import "server-only";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { nanoid } from "nanoid";
import { db, getGeneration, saveGeneration } from "./db";
import { runner } from "./runner";
import { saveOutputs, urlToPath } from "./media";
import {
  bridgeFrame,
  checkFrame,
  clean,
  clipPrompt,
  clipRefs,
  describeLook,
  clipSeconds,
  developBrief,
  firstFrame,
  fixFrame,
  freshCut,
  isGroup,
  kitPrompt,
  motionLock,
  placePicture,
  readFollowUp,
  recastFrame,
  reviewClip,
  sameOnScreen,
  shotCast,
  toBible,
  writePlan,
  writeTreatment,
  entries,
  type EditOp,
  type Plan,
} from "@/lib/storyboard/director";
import { mentionedCast } from "./cast";
import { writeClip } from "@/lib/storyboard/prompting";
import { clipLength, renderFilm, saveFrameAt, sheetTimes, timedSheet } from "@/lib/storyboard/film";
import type { Generation } from "@/lib/generations/types";
import type { AspectId } from "@/lib/shot";
import {
  lookById,
  shotDone,
  type Ask,
  type Bible,
  type BoardEvent,
  type BoardMessage,
  type KitItem,
  type LookId,
  type Shot,
  type ShotReview,
  type Storyboard,
} from "@/lib/storyboard/types";

/**
 * Storyboard: you describe a film; the director plans it (a continuity bible, one style and one
 * motion paragraph that close every prompt, and a shot list of real-time beats), then makes it one
 * shot at a time. The first frame is drawn and checked; each clip is animated from its frame,
 * watched frame by frame, retaken if it went wrong, and cut on the beat; the next shot starts from
 * the exact frame at that cut (the same camera rolling on, or that instant redrawn from a new
 * setup and checked again). When every shot is cut, the film is put together. Your follow-ups go
 * to the same director, who changes the plan and redoes only what has to change.
 *
 * Frames and clips are ordinary generations (they show in the Library too). The work runs on the
 * server, so it keeps going when you leave the page.
 */

const MAX_FIX_ROUNDS = 2;
const MAX_REDRAWS = 2;
const MAX_TAKES = 2;

type Memory = {
  __crackioBoardTable?: boolean;
  /** One change at a time per board. */
  __crackioBoardTurns?: Map<string, Promise<unknown>>;
  /** Checks, reviews, cuts and replies running in the background. */
  __crackioBoardTasks?: Set<string>;
  /** Boards with work to do; the ticker moves them along. */
  __crackioBoardActive?: Set<string>;
  __crackioBoardTicker?: ReturnType<typeof setInterval>;
  /** What the ticker runs: replaced on every reload, so it always runs the current code. */
  __crackioBoardTick?: () => void;
  /** Follow-ups, read one at a time per board, and the reply bubbles they'll fill. */
  __crackioBoardReplies?: Map<string, Promise<unknown>>;
  __crackioBoardReplying?: Set<string>;
};
const g = globalThis as unknown as Memory;
const turns = (g.__crackioBoardTurns ??= new Map());
const tasks = (g.__crackioBoardTasks ??= new Set());
const active = (g.__crackioBoardActive ??= new Set());
const replies = (g.__crackioBoardReplies ??= new Map());
const replying = (g.__crackioBoardReplying ??= new Set());

/* ------------------------------------------------------------------ storage */

function table() {
  const d = db();
  if (!g.__crackioBoardTable) {
    d.exec(`CREATE TABLE IF NOT EXISTS storyboards (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, data TEXT NOT NULL)`);
    g.__crackioBoardTable = true;
  }
  return d;
}

function save(b: Storyboard) {
  table()
    .prepare(`INSERT INTO storyboards (id, created_at, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`)
    .run(b.id, b.createdAt, JSON.stringify(b));
}

function load(id: string) {
  const row = table().prepare("SELECT data FROM storyboards WHERE id = ?").get(id) as { data: string } | undefined;
  return row ? (JSON.parse(row.data) as Storyboard) : null;
}

/** Run `fn` after every change already queued for this board. */
function inTurn<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const next = (turns.get(id) ?? Promise.resolve()).then(fn, fn);
  turns.set(
    id,
    next.catch(() => undefined),
  );
  return next;
}

/** Load, change and save a board in its turn. Returns the saved board (null when it's gone). */
function change(id: string, fn: (b: Storyboard) => void | Promise<void>) {
  return inTurn(id, async () => {
    const b = load(id);
    if (!b) return null;
    await fn(b);
    b.updatedAt = Date.now();
    save(b);
    return b;
  });
}

/* ------------------------------------------------------------------ the conversation */

const shotNo = (b: Storyboard, s: Shot) => b.shots.findIndex((x) => x.id === s.id) + 1;

/** Note what the director did under its latest reply. */
function log(b: Storyboard, e: Omit<BoardEvent, "id" | "at">) {
  b.messages ??= [];
  let last = [...b.messages].reverse().find((m) => m.role === "director");
  if (!last) {
    last = { id: nanoid(10), role: "director", text: "", at: Date.now(), events: [] };
    b.messages.push(last);
  }
  last.events = [...(last.events ?? []), { ...e, id: nanoid(8), at: Date.now() }].slice(-120);
}

const message = (role: BoardMessage["role"], text: string, extra?: Partial<BoardMessage>): BoardMessage => ({ id: nanoid(10), role, text, at: Date.now(), ...extra });

/* ------------------------------------------------------------------ jobs */

function enqueue(gen: Omit<Generation, "id" | "engine" | "status" | "outputs" | "progress" | "stage" | "createdAt">) {
  const full: Generation = { ...gen, id: nanoid(14), engine: "auto", status: "queued", outputs: [], progress: 0, stage: "Queued", createdAt: Date.now() };
  saveGeneration(full);
  runner().enqueue(full.id);
  return full.id;
}

/** The frames' resolution, when one was picked (else the model's own default). */
const frameOptions = (b: Storyboard) => (b.models?.resolution ? { options: { resolution: b.models.resolution } } : {});

function image(b: Storyboard, s: Shot, part: "frame" | "fix", label: string, made: { prompt: string; references: Generation["references"] }) {
  return enqueue({
    tool: "storyboard",
    model: b.models?.image ?? "auto",
    prompt: `${b.title} · shot ${shotNo(b, s)} · ${label}`,
    compiledPrompt: made.prompt,
    aspect: b.aspect,
    count: 1,
    references: made.references,
    params: { kind: "image", refine: false, ...frameOptions(b), storyboard: { id: b.id, shot: s.id, part } },
  });
}

/** Clips start from their frame alone: none of the clip models Crackio runs takes the cast's pictures beside it. */
const TAKES_REFS = false;

/** The video model the clips go to ("auto": LTX-2.5 on your own GPU, else a Comfy Router model). */
const videoModel = (b: Storyboard) => b.models?.video ?? "auto";

/** What a take's written prompt depends on: change any of it and the prompt is written again. */
function promptKey(b: Storyboard, s: Shot) {
  const refs = TAKES_REFS ? clipRefs(b, s).map((k) => k.image) : [];
  const parts = [videoModel(b), s.frame, s.note, s.action, s.acting, s.background, s.end, s.state, s.camera, s.duration, b.locks?.capture, b.locks?.style, ...refs];
  return createHash("sha1").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}

function animate(b: Storyboard, s: Shot) {
  if (!s.frame || !urlToPath(s.frame)) throw new Error("This shot's first frame isn't on this computer.");
  const take = (s.takes?.length ?? 0) + 1;
  const clip = clipPrompt(b, s, TAKES_REFS);
  const written = s.prompt?.key === promptKey(b, s) ? s.prompt.text : null;
  return enqueue({
    tool: "storyboard",
    model: videoModel(b),
    prompt: `${b.title} · shot ${shotNo(b, s)} · take ${take}`,
    compiledPrompt: written ?? clip.prompt,
    aspect: b.aspect,
    count: 1,
    references: [{ url: s.frame, label: "the start frame", role: "subject" }],
    params: {
      kind: "video",
      refine: false,
      startUrl: s.frame,
      ...(clip.refs.length ? { refs: clip.refs } : {}),
      options: { duration: clipSeconds(s), resolution: "720p", sound: false },
      storyboard: { id: b.id, shot: s.id, part: "clip" },
    },
  });
}

/** A picture drawn from words alone (a place option, a kit item), saved as an ordinary generation. */
function picture(b: Storyboard, label: string, prompt: string, part: string, aspect = b.aspect, references: Generation["references"] = []) {
  return enqueue({
    tool: "storyboard",
    model: b.models?.image ?? "auto",
    prompt: `${b.title} · ${label}`,
    compiledPrompt: prompt,
    aspect,
    count: 1,
    references,
    params: { kind: "image", refine: false, ...frameOptions(b), storyboard: { id: b.id, part } },
  });
}

/** Stop a shot's running jobs (a stopped fix leaves the frame to be checked again). */
function cancelJobs(s: Shot) {
  for (const id of Object.values(s.jobs)) if (id) runner().cancel(id);
  if (s.jobs.fix && s.check?.status === "fixing") s.check = { ...s.check, status: "pending" };
  s.jobs = {};
}

/** Stop putting the film together (what it was making is out of date). */
function cancelFilm(b: Storyboard) {
  if (b.finalJob) runner().cancel(b.finalJob);
  b.finalJob = undefined;
  b.final = undefined;
}

/* ------------------------------------------------------------------ the chain */

/** A generation's picture once it's done (undefined while it runs; null when it failed or is gone). */
function finished(id: string): string | null | undefined {
  const gen = getGeneration(id);
  if (!gen || gen.status === "error") return null;
  return gen.status === "done" ? (gen.outputs[0]?.url ?? null) : undefined;
}

/** Catch the board up with its finished generations: place pictures, the kit, frames, fixes, clips, the film. */
function collect(b: Storyboard) {
  for (const m of b.messages ?? [])
    for (const ask of m.asks ?? [])
      for (const o of ask.options) {
        if (!o.job) continue;
        const url = finished(o.job);
        if (url === undefined) continue;
        delete o.job;
        if (url) o.image = url;
        // The place you picked before its picture was ready.
        if (url && ask.key === "place" && ask.answer === o.id && b.dev && !b.dev.place) b.dev.place = url;
      }
  for (const k of b.kit ?? []) {
    if (!k.job) continue;
    const url = finished(k.job);
    if (url === undefined) continue;
    delete k.job;
    // A picture taken from the screen is compared with its frame before it's used.
    if (url && k.from) k.draft = url;
    else if (url) k.image = url;
    else if (!k.from) k.error = "The picture didn't render; the film goes on without it.";
  }
  for (const s of b.shots) {
    for (const part of ["frame", "fix", "clip"] as const) {
      const id = s.jobs[part];
      if (!id) continue;
      const gen = getGeneration(id);
      if (!gen) {
        delete s.jobs[part];
        continue;
      }
      if (gen.status === "done" && gen.outputs[0]) {
        delete s.jobs[part];
        const url = gen.outputs[0].url;
        s.error = undefined;
        s.failures = undefined;
        if (part === "frame") {
          s.frame = url;
          s.check = { status: "pending", round: 0 };
          log(b, { shot: shotNo(b, s), kind: "frame", text: s.frameFrom === "bridge" ? "Drew the cut to the new camera" : "Drew the first frame" });
        } else if (part === "fix") {
          s.frame = url;
          s.check = { status: "pending", round: (s.check?.round ?? 0) + 1, issues: s.check?.issues };
          log(b, { shot: shotNo(b, s), kind: "fix", text: "Fixed the frame; checking it again" });
        } else {
          s.clip = url;
          s.review = { status: "pending" };
          s.takes = [...(s.takes ?? []), { clip: url, note: s.note, at: Date.now() }];
          log(b, { shot: shotNo(b, s), kind: "clip", text: `Animated take ${s.takes.length}` });
        }
      } else if (gen.status === "error") {
        delete s.jobs[part];
        // Stopped on purpose: that step simply runs again when the board goes on.
        if (gen.error === "Cancelled.") {
          if (part === "fix") s.check = { ...s.check, status: "pending" };
          continue;
        }
        const why = gen.error ?? `The ${part} didn't render.`;
        // A full disk isn't the model's fault: pause with the step still to do, nothing counted against the shot.
        if (/ENOSPC|no space left|EDQUOT|EROFS/i.test(why)) {
          b.paused = true;
          if (part === "fix") s.check = { ...s.check, status: "pending" };
          log(b, { shot: shotNo(b, s), kind: "error", text: "The disk is full, so nothing more can be saved. I paused here; free some space and press Go on." });
          continue;
        }
        if (part === "fix") {
          s.check = { status: "flagged", issues: s.check?.issues, round: s.check?.round };
          log(b, { shot: shotNo(b, s), kind: "error", text: `The fix didn't render (${why}); keeping the frame` });
        } else if (/limit|credits|sign in|signed in|session expired|supergrok|upgrade|no engine connected/i.test(`${why} ${gen.stage ?? ""}`)) {
          // Retrying won't help until you're back under the limit or signed in: stop here and say so.
          b.paused = true;
          log(b, { shot: shotNo(b, s), kind: "error", text: `${why} ${gen.stage ?? ""} I paused here; press Go on when it's sorted.`.replace(/\s+/g, " ") });
        } else if ((s.failures ?? 0) < 2) {
          s.failures = (s.failures ?? 0) + 1;
          log(b, { shot: shotNo(b, s), kind: "error", text: `${why} Trying again.` });
        } else {
          s.error = why;
          log(b, { shot: shotNo(b, s), kind: "error", text: s.error });
        }
      }
    }
  }
  if (b.finalJob) {
    const gen = getGeneration(b.finalJob);
    if (!gen) b.finalJob = undefined;
    else if (gen.status === "done" && gen.outputs[0]) {
      b.final = gen.outputs[0].url;
      b.finalJob = undefined;
      b.filmFailures = undefined;
      log(b, { kind: "film", text: "Put the film together" });
    } else if (gen.status === "error") {
      b.finalJob = undefined;
      // Tried again once on its own; after that it waits for "Export the film again".
      b.filmFailures = (b.filmFailures ?? 0) + 1;
      log(b, { kind: "error", text: `${gen.error ?? "The film didn't render."}${b.filmFailures < 2 ? " Trying again." : ""}` });
    }
  }
}

const taskKey = (b: Storyboard, s: Shot, what: string, of?: string) => `${b.id}:${s.id}:${what}:${of ?? ""}`;

/** Shot sizes in order, close to wide. */
const framingRank = (f: string) => (/extreme/i.test(f) ? 0 : /close|insert|detail/i.test(f) ? 1 : /wide|aerial|establish/i.test(f) ? 3 : 2);

const names = (list: string[]) => (list.length > 1 ? `${list.slice(0, -1).join(", ")} and ${list.at(-1)}` : (list[0] ?? ""));

/**
 * Picture again, from this frame, the characters who show clearly in it for the first time. Image
 * models seldom draw a reference exactly, and a clip shown the old picture pulls the person back to
 * it: the face changes as soon as the frame stops showing it. Your @cast keep their own photos.
 */
function recast(b: Storyboard, s: Shot) {
  const first = (s.check?.seen ?? []).flatMap((x) => {
    const k = b.kit?.find((i) => i.kind === "character" && i.name === x.name && i.image && !i.from && !i.name.startsWith("@"));
    return k ? [{ k, where: x.where }] : [];
  });
  if (!s.frame || !first.length) return false;
  for (const { k, where } of first) {
    k.from = s.frame;
    k.where = where || undefined;
    const made = recastFrame(b, k, s.frame, where);
    k.job = picture(b, `cast · ${k.name.replace(/^@/, "")} as on screen`, made.prompt, "kit", "2:3", made.references);
  }
  log(b, { shot: shotNo(b, s), kind: "note", text: `Picturing ${names(first.map((x) => x.k.name))} as they look in this frame, so every later shot shows the same faces` });
  return true;
}

/** A picture taken from the screen replaces the old one only if it really is that person (an edit can pick the wrong one, or blend two). */
function startCompare(boardId: string, itemId: string, draft: string) {
  background(`${boardId}:kit:${itemId}:${draft}`, async () => {
    const b = await settledBoard(boardId);
    const k = b?.kit?.find((x) => x.id === itemId);
    if (!b || !k?.from || k.draft !== draft) return;
    const same = await sameOnScreen(k, k.from, draft).catch(() => null);
    await change(boardId, (now) => {
      const item = now.kit?.find((x) => x.id === itemId);
      if (!item?.from || item.draft !== draft) return;
      delete item.draft;
      const shot = now.shots.findIndex((x) => x.frame === item.from) + 1 || undefined;
      if (same !== false) {
        item.image = draft;
        item.error = undefined;
        log(now, { shot, kind: "note", text: `${item.name} is pictured as they look on screen now` });
      } else if (!item.retried) {
        item.retried = true;
        const made = recastFrame(now, item, item.from, item.where);
        item.job = picture(now, `cast · ${item.name.replace(/^@/, "")} as on screen`, made.prompt, "kit", "2:3", made.references);
      } else log(now, { shot, kind: "note", text: `Couldn't picture ${item.name} from the frame; keeping their first picture` });
    });
    kick(boardId);
  });
}

/** Rolling on needs whoever the shot is about on screen already: from a close-up of hands, the video model makes the face up. */
function leadOnScreen(b: Storyboard, prev: Shot, s: Shot) {
  const lead = shotCast(b, s)[0];
  if (!lead) return true;
  if (prev.check?.seen) return prev.check.seen.some((x) => x.name === lead.name);
  return !/insert|detail|\bhands?\b|fingers|wrist/i.test(`${prev.framing} ${prev.camera}`);
}

/** Move the board along: start whatever comes next, one shot at a time, in order. */
function advance(b: Storyboard) {
  collect(b);
  if (b.status !== "ready" || b.paused) return;
  // The cast, props and place are pictured before the first frame, so every shot can be shown them;
  // a picture taken from the screen is compared with its frame before any shot uses it.
  if ((b.kit ?? []).some((k) => k.job)) return;
  const drafts = (b.kit ?? []).filter((k) => k.draft);
  if (drafts.length) {
    for (const k of drafts) startCompare(b.id, k.id, k.draft!);
    return;
  }
  for (const [i, s] of b.shots.entries()) {
    if (s.error || s.jobs.frame || s.jobs.fix || s.jobs.clip) return;

    // The first frame: drawn for the opening shot; after that, the frame the last shot was cut on.
    if (!s.frame) {
      const prev = b.shots[i - 1];
      if (!prev) {
        s.frameFrom = "drawn";
        s.jobs.frame = image(b, s, "frame", "first frame", firstFrame(b, s));
        return;
      }
      if (!prev.outFrame) return;
      if (s.transition === "continuous") {
        s.frame = prev.outFrame;
        s.frameFrom = "continuous";
        s.check = { status: "passed" };
        log(b, { shot: i + 1, kind: "frame", text: "Continues the take from the last frame of the shot before" });
      } else {
        s.frameFrom = "bridge";
        s.jobs.frame = image(b, s, "frame", "cut", s.fresh ? freshCut(b, prev, s) : bridgeFrame(b, prev, s));
        return;
      }
    }

    // Check the frame before anything is built on it.
    if (s.check?.status === "pending" || (s.check?.status === "checking" && !tasks.has(taskKey(b, s, "check", s.frame)))) {
      s.check = { ...s.check, status: "checking" };
      startCheck(b.id, s.id, s.frame!);
      return;
    }
    if (s.check?.status === "checking" || s.check?.status === "fixing") return;

    // The approved opening frame sets the look every later prompt describes.
    // (A film whose look was taken before clips had their one look sentence gets it now.)
    if (i === 0 && b.locks && (b.locks.anchor !== s.frame || b.locks.capture === undefined)) {
      startLook(b.id, s.frame!);
      return;
    }
    // Whoever shows clearly for the first time is pictured again from this frame.
    if (recast(b, s)) return;

    // Write the take's prompt for its video model, animate, then watch the take and cut it.
    if (!s.clip) {
      const key = promptKey(b, s);
      if (s.prompt?.key !== key) {
        startWrite(b.id, s.id, key);
        return;
      }
      try {
        s.jobs.clip = animate(b, s);
      } catch (err) {
        s.error = (err as Error).message;
      }
      return;
    }
    if (s.review?.status === "pending" || (s.review?.status === "reviewing" && !tasks.has(taskKey(b, s, "review", s.clip)))) {
      s.review = { ...s.review, status: "reviewing" };
      startReview(b.id, s.id, s.clip);
      return;
    }
    if (s.review?.status === "reviewing") return;
    if (!s.outFrame) {
      startCut(b.id, s.id, s.clip, s.review?.out);
      return;
    }
  }
  // Every shot is cut: put the film together.
  if (b.shots.length && b.shots.every(shotDone) && !b.final && !b.finalJob && (b.filmFailures ?? 0) < 2) b.finalJob = startFilm(b);
}

/** Work left on a board (the ticker keeps moving it). */
function hasWork(b: Storyboard) {
  if (b.version !== 3 || b.paused || b.status === "error") return false;
  if (b.status === "planning" || b.finalJob || b.messages?.some((m) => m.pending)) return true;
  // Waiting on you to answer: only the place pictures still rendering keep it moving.
  if (b.status === "developing") return Boolean(b.messages?.some((m) => m.asks?.some((a) => a.options.some((o) => o.job))));
  // The chain waits at the first unfinished shot: work left unless that one has a problem.
  const first = b.shots.find((s) => !shotDone(s));
  if (first) return !first.error;
  return b.shots.length > 0 && !b.final && (b.filmFailures ?? 0) < 2;
}

/** Catch the board up and start what comes next. */
function step(id: string) {
  return inTurn(id, async () => {
    const b = load(id);
    if (!b) {
      active.delete(id);
      return null;
    }
    if (b.version !== 3) return b;
    const before = JSON.stringify(b);
    // After a restart: a plan, a read of the brief or a story nobody is writing starts again, and a reply nobody is writing says so.
    if (b.status === "planning" && !tasks.has(`${id}:plan`)) startPlan(id);
    if (b.status === "developing" && b.dev?.waiting === "develop" && !tasks.has(`${id}:develop`)) startDevelop(id);
    if (b.status === "developing" && b.dev?.waiting === "treatment" && !tasks.has(`${id}:treatment`)) startTreatment(id);
    for (const m of b.messages ?? [])
      if (m.role === "director" && m.pending && m.id !== b.planReply && m.id !== b.dev?.reply && !replying.has(m.id))
        Object.assign(m, { pending: false, text: "That got interrupted (Crackio restarted while I was reading it). Send it again?" });
    advance(b);
    if (JSON.stringify(b) !== before) {
      b.updatedAt = Date.now();
      save(b);
    }
    if (hasWork(b)) active.add(id);
    else active.delete(id);
    ensureTicker();
    return b;
  });
}

/** Something finished: move on now rather than on the next tick. */
const kick = (id: string) => void step(id).catch((err) => console.warn(`[storyboard] ${(err as Error).message}`));

g.__crackioBoardTick = () => {
  for (const id of active) kick(id);
};

function ensureTicker() {
  g.__crackioBoardTicker ??= setInterval(() => g.__crackioBoardTick?.(), 2500);
}

/* ------------------------------------------------------------------ background tasks */

/** The board as saved once the change in progress is done (tasks start in the middle of one). */
const settledBoard = (id: string) => inTurn(id, async () => load(id));

function background(key: string, work: () => Promise<void>) {
  if (tasks.has(key)) return;
  tasks.add(key);
  void work()
    .catch((err) => console.warn(`[storyboard] ${key}: ${(err as Error).message}`))
    .finally(() => tasks.delete(key));
}

/** The continuity check of a fresh frame: pass it, fix it, redraw it, or keep the take rolling. */
function startCheck(boardId: string, shotId: string, frame: string) {
  background(`${boardId}:${shotId}:check:${frame}`, async () => {
    const b = await settledBoard(boardId);
    const index = b?.shots.findIndex((s) => s.id === shotId) ?? -1;
    if (!b || index < 0 || b.shots[index].frame !== frame) return;
    // Never judge a frame the checker can't see.
    const verdict = urlToPath(frame)
      ? await checkFrame(b, b.shots[index], index).catch((err) => {
          console.warn(`[storyboard] check: ${(err as Error).message}`);
          return null;
        })
      : null;
    await change(boardId, (now) => {
      const s = now.shots.find((x) => x.id === shotId);
      if (!s || s.frame !== frame) return; // redrawn meanwhile
      const n = shotNo(now, s);
      const round = s.check?.round ?? 0;
      const bridge = s.frameFrom === "bridge";
      // A cut gets one fresh drawing; the opening frame, which nothing else can stand in for, gets more.
      const redrawsLeft = (bridge ? 1 : MAX_REDRAWS) - (s.redraws ?? 0) > 0;
      // An edit can't move the camera: a too-similar angle means the take keeps rolling.
      const jump = (i: { what: string }) => /jump cut|glitch|identical to the previous|same (camera|angle|framing|setup)|nearly the same|too similar|camera (barely|hardly)/i.test(i.what);
      const fixable = verdict?.issues.filter((i) => !jump(i)) ?? [];
      // Keeping the take rolling only works between similar framings: asked to turn a close-up into a
      // wide shot, the video model pulls back and invents the rest of the place.
      const prev = now.shots[n - 2];
      const canRollOn = bridge && Boolean(prev?.outFrame) && Math.abs(framingRank(s.framing) - framingRank(prev.framing)) <= 1 && leadOnScreen(now, prev, s);
      const seen = verdict?.seen;
      const rollOn = (why: string) => {
        s.frame = now.shots[n - 2]?.outFrame;
        s.frameFrom = "continuous";
        s.transition = "continuous";
        s.check = { status: "passed", issues: [why] };
        log(now, { shot: n, kind: "check", text: why });
      };
      const redraw = (why: string) => {
        s.redraws = (s.redraws ?? 0) + 1;
        s.frameNote = verdict!.issues.map((i) => i.fix).join(" ");
        s.frame = undefined;
        s.check = undefined;
        log(now, { shot: n, kind: "check", text: why });
      };
      if (!verdict) {
        s.check = { status: "skipped", round };
        log(now, { shot: n, kind: "check", text: "Couldn't check the frame (no text model answered); going on" });
      } else if (verdict.verdict === "pass" || (!bridge && verdict.verdict === "continuous")) {
        s.check = { status: round ? "fixed" : "passed", issues: s.check?.issues, round, seen };
        log(now, { shot: n, kind: "check", text: round ? "The fix holds up" : "Frame checked: no problems" });
      } else if (bridge && (verdict.verdict === "continuous" || verdict.jump || (verdict.issues[0] && jump(verdict.issues[0])) || (verdict.issues.some(jump) && !verdict.serious))) {
        // Redrawn the same way, a cut that kept the old camera keeps it again: when that's the main problem, go fresh straight away.
        // First a fresh drawing of the new angle (the planned coverage is worth one more picture), then the take keeps rolling.
        if (!s.fresh && redrawsLeft) {
          s.fresh = true;
          redraw("The new angle came out too close to the last shot; drawing the planned angle fresh from the place and the cast");
        } else if (canRollOn) rollOn("The new angle came out too close to the last shot (a jump cut), so the take keeps rolling instead");
        else if (redrawsLeft) redraw("The new angle came out too close to the last shot; drawing it again with the planned framing");
        else {
          s.check = { status: "flagged", issues: verdict.issues.map((i) => i.what), round, seen };
          log(now, { shot: n, kind: "check", text: "The cut stays close to the last shot's framing; going on with it" });
        }
      } else if (verdict.verdict === "redraw" && redrawsLeft) {
        redraw(`Drawing it again: ${verdict.issues[0]?.what ?? verdict.summary ?? "the frame was wrong"}`);
      } else if (fixable.length && round < MAX_FIX_ROUNDS && verdict.verdict !== "redraw") {
        s.check = { status: "fixing", issues: fixable.map((i) => i.what), round };
        s.jobs.fix = image(now, s, "fix", "fix", fixFrame(now, s, fixable));
        log(now, { shot: n, kind: "fix", text: `Fixing: ${fixable.map((i) => i.what).join("; ")}` });
      } else if (verdict.serious && redrawsLeft) {
        // Fixes didn't save it (or made it worse): a broken frame is never animated, so start it over.
        redraw(`The fixes didn't hold (${verdict.issues[0]?.what ?? "still wrong"}); drawing it fresh`);
      } else if (verdict.serious && bridge && !s.fresh) {
        // Redrawing the last frame keeps failing: one drawing of the new angle from the place and the cast.
        s.fresh = true;
        redraw(`The new angle still wasn't right (${verdict.issues[0]?.what ?? "still wrong"}); drawing it fresh from the place and the cast`);
      } else if (canRollOn && verdict.serious) {
        // The new angle won't come out right: the exact last frame is a safe start when the framing is close.
        rollOn(`The new angle wouldn't come out right (${verdict.issues[0]?.what ?? "still wrong"}), so the take keeps rolling instead`);
      } else {
        s.check = { status: "flagged", issues: verdict.issues.map((i) => i.what), round, seen };
        log(now, { shot: n, kind: "check", text: `Good enough to go on, with a small flaw: ${verdict.issues[0]?.what ?? ""}` });
      }
    });
    kick(boardId);
  });
}

/**
 * Write the next take's prompt for its video model, from the shot's plan and its start frame. If no
 * text model answers, the plan's own prompt goes instead, so the film never waits on it.
 */
function startWrite(boardId: string, shotId: string, key: string) {
  background(`${boardId}:${shotId}:write:${key}`, async () => {
    const b = await settledBoard(boardId);
    const s = b?.shots.find((x) => x.id === shotId);
    if (!b || !s || s.clip || promptKey(b, s) !== key) return;
    const look = b.locks?.capture ?? b.locks?.style ?? lookById(b.look).prompt;
    const written = await writeClip(b, s, videoModel(b), clipSeconds(s), TAKES_REFS ? clipRefs(b, s) : [], look).catch((err) => {
      console.warn(`[storyboard] write: ${(err as Error).message}`);
      return null;
    });
    await change(boardId, (now) => {
      const shot = now.shots.find((x) => x.id === shotId);
      if (!shot || shot.clip || promptKey(now, shot) !== key) return;
      shot.prompt = written ? { text: written.text, key, words: written.words, dropped: written.dropped, guide: written.guide } : { text: clipPrompt(now, shot, TAKES_REFS).prompt, key };
      if (written) log(now, { shot: shotNo(now, shot), kind: "note", text: `Wrote the take for ${written.guide} in ${written.words} words${written.dropped ? `; left out ${written.dropped.replace(/.$/, "")}` : ""}` });
    });
    kick(boardId);
  });
}

/** Write the film's style from its approved first frame, so cuts drawn later match what's on screen, not the plan's words. */
function startLook(boardId: string, frame: string) {
  background(`${boardId}:look:${frame}`, async () => {
    const look = await describeLook(frame).catch(() => null);
    await change(boardId, (now) => {
      if (!now.locks || now.shots[0]?.frame !== frame) return;
      const style = look?.style ?? now.locks.style;
      // Never left without one: it would be asked for again on every step.
      const capture = look?.capture ?? now.locks.capture ?? clean(style.split(/(?<=.)s/)[0], 240);
      now.locks = { ...now.locks, style, capture, anchor: frame };
      if (look) log(now, { shot: 1, kind: "note", text: "Took the film's look from the approved first frame; every later frame and clip is described with it" });
    });
    kick(boardId);
  });
}

/** Watch a take frame by frame: accept it with a cut, or retake it with a note. */
function startReview(boardId: string, shotId: string, clip: string) {
  background(`${boardId}:${shotId}:review:${clip}`, async () => {
    const b = await settledBoard(boardId);
    const index = b?.shots.findIndex((s) => s.id === shotId) ?? -1;
    const file = urlToPath(clip);
    if (!b || index < 0 || b.shots[index].clip !== clip) return;
    // A clip that can't be read stops the shot with a message, instead of being tried every tick.
    const length = file ? await clipLength(file).catch(() => 0) : 0;
    if (!file || !length) {
      await change(boardId, (now) => {
        const s = now.shots.find((x) => x.id === shotId);
        if (s && s.clip === clip) s.error = "This shot's clip can't be read from disk. Retake it.";
      });
      return;
    }
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "crackio-review-"));
    let verdict: Awaited<ReturnType<typeof reviewClip>> = null;
    try {
      const sheet = path.join(dir, "sheet.jpg");
      await fs.writeFile(sheet, await timedSheet(file, sheetTimes(length)));
      verdict = await reviewClip(b, b.shots[index], index, sheet, length);
    } catch (err) {
      console.warn(`[storyboard] review: ${(err as Error).message}`);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
    await change(boardId, (now) => {
      const s = now.shots.find((x) => x.id === shotId);
      if (!s || s.clip !== clip) return;
      const n = shotNo(now, s);
      const takes = s.takes ?? [];
      const record = (review: ShotReview) => {
        s.review = review;
        s.takes = takes.map((t) => (t.clip === clip ? { ...t, review } : t));
      };
      if (!verdict) {
        record({ status: "skipped", in: 0, out: length });
        log(now, { shot: n, kind: "review", text: "Couldn't watch the take (no text model answered); using all of it" });
        return;
      }
      const review: ShotReview = { status: "accepted", in: verdict.in, out: verdict.out, score: verdict.score, summary: verdict.summary, issues: verdict.issues, note: verdict.note };
      if (verdict.verdict === "accept") {
        record(review);
        log(now, { shot: n, kind: "review", text: `Take ${takes.length} works; cut at ${verdict.out.toFixed(1)} s${verdict.summary ? `: ${verdict.summary}` : ""}` });
        return;
      }
      record({ ...review, status: "retake" });
      // A shot that broke the story on every take gets one more, staged as simply as it can be.
      const broken = (s.takes ?? []).every((t) => (t.review?.score ?? 10) <= 3);
      if (takes.length < MAX_TAKES || (broken && takes.length < MAX_TAKES + 1)) {
        const simpler = takes.length >= MAX_TAKES ? "Keep it simple and readable: few, big, clear moves." : "";
        s.note = [s.note, verdict.note, simpler].filter(Boolean).join(" ").slice(-600) || undefined;
        s.clip = undefined;
        s.review = undefined;
        s.outFrame = undefined;
        log(now, { shot: n, kind: "retake", text: `Retake: ${verdict.issues[0] ?? verdict.summary ?? "the take didn't work"}` });
        return;
      }
      // Out of retakes: the best one so far, flagged for you.
      const best = [...(s.takes ?? [])].sort((a, c) => (c.review?.score ?? 0) - (a.review?.score ?? 0))[0];
      s.clip = best.clip;
      s.review = { ...(best.review ?? review), status: "flagged" };
      log(now, { shot: n, kind: "review", text: `Kept the best of ${takes.length} takes; it still has a problem: ${best.review?.issues?.[0] ?? verdict.issues[0] ?? "see the shot"}` });
    });
    kick(boardId);
  });
}

/** Save the frame at the cut: the next shot starts from it. */
function startCut(boardId: string, shotId: string, clip: string, out?: number) {
  background(`${boardId}:${shotId}:cut:${clip}:${out ?? ""}`, async () => {
    const file = urlToPath(clip);
    const at = out ?? (file ? await clipLength(file).catch(() => 0) : 0);
    const url = file
      ? await saveFrameAt(clip, at).catch((err) => {
          console.warn(`[storyboard] cut: ${(err as Error).message}`);
          return null;
        })
      : null;
    await change(boardId, (now) => {
      const s = now.shots.find((x) => x.id === shotId);
      if (!s || s.clip !== clip || (s.review?.out ?? at) !== at) return;
      if (url) s.outFrame = url;
      else s.error = "Couldn't save the frame at the cut.";
    });
    kick(boardId);
  });
}

/** Put the film together in the background; it shows up as a take in the Library too. */
function startFilm(b: Storyboard) {
  const gen: Generation = {
    id: nanoid(14),
    tool: "storyboard",
    engine: "auto",
    status: "running",
    prompt: `${b.title} · film`,
    aspect: b.aspect,
    count: 1,
    references: [],
    outputs: [],
    params: { kind: "video", storyboard: { id: b.id, part: "final" } },
    progress: 0.3,
    stage: "Putting the film together",
    createdAt: Date.now(),
  };
  saveGeneration(gen);
  const snapshot = structuredClone(b);
  void (async () => {
    try {
      const film = await renderFilm(snapshot);
      const outputs = await saveOutputs(gen.id, [{ data: film.data, mime: "video/mp4", width: film.width, height: film.height }]);
      saveGeneration({ ...gen, status: "done", outputs, progress: 1, stage: undefined, finishedAt: Date.now() });
    } catch (err) {
      saveGeneration({ ...gen, status: "error", error: (err as Error).message, stage: undefined, finishedAt: Date.now() });
    }
    kick(b.id);
  })();
  return gen.id;
}

/* ------------------------------------------------------------------ planning */

const clampSeconds = (n: unknown) => Math.min(12, Math.max(2, Math.round(Number(n) || 4)));

function toShot(s: Partial<Shot & { seconds: number }>): Shot {
  return {
    id: nanoid(8),
    title: clean(s.title, 60) || "Shot",
    framing: clean(s.framing, 40) || "Medium",
    camera: clean(s.camera, 300) || "Eye level; static",
    layout: clean(s.layout, 700) || undefined,
    action: clean(s.action, 800),
    acting: clean(s.acting, 600) || undefined,
    background: clean(s.background, 400) || undefined,
    end: clean(s.end, 500) || undefined,
    state: clean(s.state, 500) || undefined,
    transition: s.transition === "continuous" ? "continuous" : "cut",
    duration: clampSeconds(s.seconds ?? s.duration),
    jobs: {},
  };
}

function applyPlan(b: Storyboard, p: Plan) {
  b.title = clean(p.title, 80) || b.title;
  b.bible = toBible(p.bible);
  b.locks = { style: clean(p.style, 1200) || lookById(b.look).prompt, motion: motionLock(b.look) };
  b.shots = (p.shots ?? []).slice(0, 16).map(toShot);
  if (b.shots[0]) b.shots[0].transition = "cut";
  b.final = undefined;
  b.status = "ready";
  b.error = undefined;
  buildKit(b);
}

/**
 * The cast, props and place as pictures, made before the first frame: your @cast's own portraits,
 * the place you picked, and everyone and everything else drawn now on a plain backdrop. Pictures
 * whose description hasn't changed are kept.
 */
function buildKit(b: Storyboard) {
  const old = b.kit ?? [];
  const kit: KitItem[] = [];
  if (b.dev?.place) kit.push({ id: "place", kind: "place", name: "the place", noun: "the place", image: b.dev.place });
  const add = (kind: "character" | "prop", e: { name: string; noun?: string; look: string; size?: string }) => {
    const look = [e.look, e.size].filter(Boolean).join("; ");
    const cast = e.name.startsWith("@") ? mentionedCast(e.name)[0] : undefined;
    if (cast) return kit.push({ id: nanoid(6), kind, name: e.name, noun: e.noun, look, image: cast.portrait ?? cast.photos[0] ?? cast.sheet });
    const keep = old.find((k) => k.kind === kind && k.name === e.name && k.look === look && (k.image || k.job));
    if (keep) return kit.push({ ...keep, noun: e.noun });
    const item: KitItem = { id: nanoid(6), kind, name: e.name, noun: e.noun, look };
    item.job = picture(b, `${kind === "prop" ? "prop" : "cast"} · ${e.name.replace(/^@/, "")}`, kitPrompt(b, item), "kit", kind === "prop" ? "1:1" : "2:3");
    kit.push(item);
  };
  for (const c of (b.bible?.characters ?? []).filter((e) => !isGroup(e)).slice(0, 6)) add("character", c);
  for (const p of (b.bible?.props ?? []).slice(0, 3)) add("prop", p);
  b.kit = kit;
}

function planSummary(b: Storyboard, logline?: string) {
  const total = Math.round(b.shots.reduce((t, s) => t + s.duration, 0));
  const cuts = b.shots.filter((s, i) => i > 0 && s.transition === "continuous").length;
  return [
    logline ? clean(logline, 300) : "",
    `${b.shots.length} shots, about ${total} s${cuts ? `, ${cuts} of them continuing the take before` : ""}. I'm drawing the first frame now; each next shot starts from the exact frame the one before is cut on, and I check every frame and watch every take before moving on.`,
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * Plan (or plan again) in the background, from the board's scene and any note asked for with it;
 * the reply that asked for it (`planReply`) gets the summary. Started again after a restart.
 */
function startPlan(boardId: string) {
  background(`${boardId}:plan`, async () => {
    const b = await settledBoard(boardId);
    if (!b || b.status !== "planning") return;
    let plan: Plan | null = null;
    let error: string | null = null;
    try {
      plan = await writePlan(b, b.planNote);
    } catch (err) {
      error = (err as Error).message;
    }
    await change(boardId, (now) => {
      const reply = (now.messages ?? []).find((m) => m.id === now.planReply) ?? (now.messages ?? []).find((m) => m.role === "director" && m.pending);
      now.planNote = undefined;
      now.planReply = undefined;
      if (plan) {
        applyPlan(now, plan);
        if (reply) Object.assign(reply, { text: planSummary(now, plan.logline), pending: false });
        log(now, { kind: "plan", text: `Planned ${now.shots.length} shots` });
      } else {
        now.status = "error";
        now.error = error ?? "The plan didn't come through.";
        if (reply) Object.assign(reply, { text: `I couldn't plan this: ${now.error}`, pending: false });
      }
    });
    kick(boardId);
  });
}

/* ------------------------------------------------------------------ development */

/** The reply bubble a development step will fill. */
function waitFor(now: Storyboard, what: "develop" | "treatment") {
  const reply = message("director", "", { pending: true, events: [] });
  now.messages = [...(now.messages ?? []), reply];
  if (now.dev) Object.assign(now.dev, { waiting: what, reply: reply.id });
  return reply;
}

const devReply = (now: Storyboard) => (now.messages ?? []).find((m) => m.id === now.dev?.reply) ?? [...(now.messages ?? [])].reverse().find((m) => m.role === "director" && m.pending);

/** Read the brief: a few questions with pictures of three places, or (for a detailed brief) straight to the story. */
function startDevelop(boardId: string) {
  background(`${boardId}:develop`, async () => {
    const b = await settledBoard(boardId);
    if (!b?.dev || b.status !== "developing") return;
    let read: Awaited<ReturnType<typeof developBrief>> | null = null;
    let error: string | null = null;
    try {
      read = await developBrief(b);
    } catch (err) {
      error = (err as Error).message;
    }
    let straight = false;
    await change(boardId, (now) => {
      if (!now.dev || now.status !== "developing") return;
      const reply = devReply(now);
      Object.assign(now.dev, { waiting: undefined, reply: undefined });
      if (!read) {
        now.status = "error";
        now.error = error ?? "I couldn't read the brief.";
        if (reply) Object.assign(reply, { text: `I couldn't read that: ${now.error}`, pending: false });
        return;
      }
      if (read.mode === "go" || now.dev.auto || !read.places.length) {
        // A brief that already says it all: no questions, but still a real story behind it.
        if (reply) Object.assign(reply, { text: read.note || "That's clear. I'll work out the story and plan the shots.", pending: false });
        now.dev.auto = true;
        waitFor(now, "treatment");
        straight = true;
        return;
      }
      const places: Ask = {
        id: nanoid(8),
        kind: "pictures",
        key: "place",
        question: "Where does it happen?",
        options: read.places.map((p) => ({ id: nanoid(6), label: p.label, detail: p.detail, prompt: p.prompt, job: picture(now, `place · ${p.label}`, placePicture(now, p.prompt), "place") })),
      };
      const questions: Ask[] = read.questions.map((q) => ({
        id: nanoid(8),
        kind: "choice",
        key: q.key,
        question: q.question,
        options: q.options.map((o) => ({ id: nanoid(6), label: o.label, detail: o.detail })),
      }));
      if (reply) Object.assign(reply, { text: read.note || "A few quick choices will make this a lot better.", pending: false, asks: [places, ...questions] });
    });
    if (straight) startTreatment(boardId);
    else kick(boardId);
  });
}

/** Work the brief and your answers into a story; you approve it before anything is shot (unless you said to just make it). */
function startTreatment(boardId: string) {
  background(`${boardId}:treatment`, async () => {
    const b = await settledBoard(boardId);
    if (!b?.dev || b.status !== "developing") return;
    let result: Awaited<ReturnType<typeof writeTreatment>> | null = null;
    let error: string | null = null;
    try {
      result = await writeTreatment(b, b.dev.place ? urlToPath(b.dev.place) : null);
    } catch (err) {
      error = (err as Error).message;
    }
    let plan = false;
    await change(boardId, (now) => {
      if (!now.dev || now.status !== "developing") return;
      const reply = devReply(now);
      Object.assign(now.dev, { waiting: undefined, reply: undefined });
      if (!result) {
        if (reply) Object.assign(reply, { text: `I couldn't write the story: ${error}. Tell me more and I'll try again.`, pending: false });
        return;
      }
      now.dev.treatment = result.treatment;
      now.title = result.treatment.title || now.title;
      if (now.dev.auto) {
        now.dev.approved = true;
        if (reply) Object.assign(reply, { text: result.reply, treatment: result.treatment, pending: false });
        const next = message("director", "", { pending: true, events: [] });
        now.messages = [...(now.messages ?? []), next];
        now.planReply = next.id;
        now.status = "planning";
        plan = true;
        return;
      }
      const approve: Ask = {
        id: nanoid(8),
        kind: "approve",
        key: "story",
        question: "Shall I shoot this?",
        options: [
          { id: "shoot", label: "Shoot it" },
          { id: "another", label: "Another idea" },
        ],
      };
      if (reply) Object.assign(reply, { text: result.reply, treatment: result.treatment, pending: false, asks: [approve] });
    });
    if (plan) startPlan(boardId);
    else kick(boardId);
  });
}

/** Your tap on one of the director's questions; "director" means "just make it": it picks the rest and goes. */
export async function answerAsk(id: string, askId: string, optionId: string) {
  let next: "treatment" | "plan" | null = null;
  const b = await change(id, (now) => {
    const d = now.dev;
    if (now.status !== "developing" || !d || d.waiting) return;
    const m = (now.messages ?? []).find((x) => x.asks?.some((a) => a.id === askId));
    const ask = m?.asks?.find((a) => a.id === askId);
    if (!m || !ask || ask.answer) return;
    const pick = (a: Ask, o: Ask["options"][number]) => {
      a.answer = o.id;
      d.answers[a.key] = o.detail ? `${o.label} (${o.detail})` : o.label;
      if (a.key === "place") d.place = o.image;
    };
    if (optionId === "director") {
      for (const a of m.asks!)
        if (!a.answer && a.kind !== "approve") pick(a, a.kind === "pictures" ? (a.options.find((o) => o.image) ?? a.options[0]) : a.options[Math.floor(a.options.length / 2)]);
      now.messages = [...(now.messages ?? []), message("user", "Your call: just make it.")];
      d.auto = true;
      waitFor(now, "treatment");
      next = "treatment";
      return;
    }
    const option = ask.options.find((o) => o.id === optionId);
    if (!option) return;
    if (ask.kind === "approve") {
      ask.answer = option.id;
      now.messages = [...(now.messages ?? []), message("user", option.label)];
      if (option.id === "shoot") {
        d.approved = true;
        const reply = message("director", "", { pending: true, events: [] });
        now.messages.push(reply);
        now.planReply = reply.id;
        now.status = "planning";
        next = "plan";
      } else {
        d.notes.push("They'd like a different idea for the story: take it somewhere else.");
        waitFor(now, "treatment");
        next = "treatment";
      }
      return;
    }
    pick(ask, option);
    if (m.asks!.every((a) => a.answer)) {
      waitFor(now, "treatment");
      next = "treatment";
    }
  });
  if (next === "plan") startPlan(id);
  else if (next === "treatment") startTreatment(id);
  return b;
}

/** Words typed while the film is being worked out: they answer what's open, or change the story. */
async function developNote(id: string, text: string) {
  let next = false;
  const b = await change(id, (now) => {
    const d = now.dev;
    if (!d) return;
    now.messages = [...(now.messages ?? []), message("user", text)];
    d.notes.push(text);
    if (d.waiting) {
      now.messages.push(message("director", "Noted: I'll fold that in."));
      return;
    }
    // Whatever is still open is answered by what they wrote.
    const open = [...(now.messages ?? [])].reverse().find((m) => m.asks?.some((a) => !a.answer));
    for (const a of open?.asks ?? []) if (!a.answer) a.answer = "note";
    waitFor(now, "treatment");
    next = true;
  });
  if (next) startTreatment(id);
  return b;
}

/* ------------------------------------------------------------------ follow-ups */

/** Forget what was made from shot `from` on (frames too), and the clip of shot `clipFrom` and on. */
function invalidate(b: Storyboard, from: number, clipFrom: number) {
  const first = Math.min(from, clipFrom);
  if (!Number.isFinite(first)) return;
  for (const [i, s] of b.shots.entries()) {
    if (i < first) continue;
    cancelJobs(s);
    Object.assign(s, { clip: undefined, review: undefined, takes: undefined, outFrame: undefined, error: undefined, failures: undefined });
    // A shot after the first changed one starts from a new frame too (it continues from it).
    if (i >= from || i > clipFrom) Object.assign(s, { frame: undefined, frameFrom: undefined, check: undefined, redraws: undefined, fresh: undefined });
  }
  cancelFilm(b);
}

const SHOT_FIELDS = ["title", "framing", "camera", "layout", "action", "acting", "background", "end", "state", "transition"] as const;
const STRUCTURAL = new Set(["add", "remove", "move"]);

/** Where a structural op lands in the shot list as the director saw it (applied from the end back, so numbers stay true). */
const position = (op: EditOp) => (op.op === "add" ? Number(op.after) + 0.5 : Number(op.shot));

/** Apply the director's changes. Returns a new brief when the film is to be planned over. */
function applyOps(b: Storyboard, ops: EditOp[]): { replan?: string; film?: boolean } {
  let from = Infinity;
  let clipFrom = Infinity;
  let film = false;
  const at = (n: unknown) => {
    const i = Math.round(Number(n)) - 1;
    return Number.isFinite(i) && i >= 0 && i < b.shots.length ? i : -1;
  };
  // Shot numbers refer to the list before any change: edits first, then adds, removes and moves from the end back.
  const ordered = [
    ...ops.filter((o) => !STRUCTURAL.has(o.op)),
    ...ops.filter((o) => o.op !== "move" && STRUCTURAL.has(o.op)).sort((a, c) => (position(c) || 0) - (position(a) || 0)),
    ...ops.filter((o) => o.op === "move"),
  ];
  for (const op of ordered) {
    switch (op.op) {
      case "edit": {
        const i = at(op.shot);
        if (i < 0) break;
        const s = b.shots[i];
        let frameChanged = false;
        let clipChanged = false;
        for (const k of SHOT_FIELDS) {
          if (typeof op[k] !== "string" || !op[k]) continue;
          const v = k === "transition" ? (op[k] === "continuous" ? "continuous" : "cut") : clean(op[k], k === "action" ? 800 : 700);
          if (v === s[k]) continue;
          (s as Record<string, unknown>)[k] = v;
          if (k === "camera" || k === "layout" || k === "framing" || k === "transition") frameChanged = true;
          else if (k !== "title") clipChanged = true;
        }
        if (op.seconds !== undefined && clampSeconds(op.seconds) !== s.duration) {
          s.duration = clampSeconds(op.seconds);
          clipChanged = true;
        }
        if (i === 0) s.transition = "cut";
        if (frameChanged) from = Math.min(from, i);
        else if (clipChanged) clipFrom = Math.min(clipFrom, i);
        break;
      }
      case "add": {
        const after = Math.max(0, Math.min(b.shots.length, Math.round(Number(op.after) || 0)));
        const shot = toShot((op.shot ?? {}) as Partial<Shot & { seconds: number }>);
        if (!shot.action) break;
        b.shots.splice(after, 0, shot);
        if (after === 0) {
          shot.transition = "cut";
          if (b.shots[1]) b.shots[1].transition = b.shots[1].transition ?? "cut";
        }
        from = Math.min(from, after);
        break;
      }
      case "remove": {
        const i = at(op.shot);
        if (i < 0 || b.shots.length < 2) break;
        cancelJobs(b.shots[i]);
        b.shots.splice(i, 1);
        if (b.shots[0]) b.shots[0].transition = "cut";
        from = Math.min(from, i);
        break;
      }
      case "move": {
        const i = at(op.shot);
        const to = Math.max(0, Math.min(b.shots.length - 1, Math.round(Number(op.to)) - 1));
        if (i < 0 || !Number.isFinite(to) || i === to) break;
        const [s] = b.shots.splice(i, 1);
        b.shots.splice(to, 0, s);
        b.shots[0].transition = "cut";
        from = Math.min(from, i, to);
        break;
      }
      case "retake": {
        const i = at(op.shot);
        if (i < 0) break;
        if (typeof op.note === "string" && op.note.trim()) b.shots[i].note = clean(op.note, 600);
        clipFrom = Math.min(clipFrom, i);
        break;
      }
      case "redraw": {
        const i = at(op.shot);
        if (i < 0) break;
        if (typeof op.note === "string" && op.note.trim()) b.shots[i].frameNote = clean(op.note, 600);
        // A frame that continues the take can't be redrawn on its own: it becomes a cut.
        if (i > 0 && b.shots[i].transition === "continuous") b.shots[i].transition = "cut";
        from = Math.min(from, i);
        break;
      }
      case "trim": {
        const i = at(op.shot);
        const s = b.shots[i];
        if (i < 0 || !s?.clip || !s.review) break;
        const inPoint = op.in !== undefined ? Math.max(0, Number(op.in) || 0) : (s.review.in ?? 0);
        const out = op.out !== undefined ? Math.max(inPoint + 0.5, Number(op.out) || 0) : (s.review.out ?? s.duration);
        s.review = { ...s.review, in: inPoint, out };
        s.outFrame = undefined;
        // The next shot starts from the frame at the cut, whether it keeps rolling or redraws it.
        from = Math.min(from, i + 1);
        cancelFilm(b);
        break;
      }
      case "style": {
        if (typeof op.text !== "string" || !op.text.trim()) break;
        b.locks = { style: clean(op.text, 1200), motion: b.locks?.motion ?? motionLock(b.look) };
        from = 0;
        break;
      }
      case "motion": {
        if (typeof op.text !== "string" || !op.text.trim()) break;
        b.locks = { style: b.locks?.style ?? lookById(b.look).prompt, motion: clean(op.text, 1200) };
        clipFrom = 0;
        break;
      }
      case "bible": {
        const bible: Bible = b.bible ?? { setting: "", characters: [], props: [] };
        if (typeof op.setting === "string") bible.setting = clean(op.setting, 800);
        if (typeof op.scale === "string") bible.scale = clean(op.scale, 500);
        if (Array.isArray(op.characters)) bible.characters = entries(op.characters);
        if (Array.isArray(op.props)) bible.props = entries(op.props);
        b.bible = bible;
        // New looks get new pictures (unchanged ones are kept).
        buildKit(b);
        from = 0;
        break;
      }
      case "title":
        if (typeof op.text === "string" && op.text.trim()) b.title = clean(op.text, 80);
        break;
      case "length":
        if (Number(op.seconds) > 0) b.target = Math.min(180, Math.max(5, Math.round(Number(op.seconds))));
        break;
      case "replan":
        return { replan: typeof op.brief === "string" && op.brief.trim() ? op.brief : b.scene };
      case "pause":
        b.paused = true;
        for (const s of b.shots) cancelJobs(s);
        break;
      case "resume":
        b.paused = false;
        break;
      case "film":
        film = true;
        break;
    }
  }
  invalidate(b, from, clipFrom);
  if (film) {
    cancelFilm(b);
    b.filmFailures = undefined;
  }
  return { film };
}

/**
 * Read a follow-up and change the film; its own reply bubble gets the answer. Messages are read one
 * at a time per board, each against the board as the one before left it.
 */
function startFollowUp(boardId: string, text: string, replyId: string) {
  replying.add(replyId);
  const work = async () => {
    // A message sent while the film is being planned waits for the plan.
    for (let waited = 0; load(boardId)?.status === "planning" && tasks.has(`${boardId}:plan`) && waited < 600; waited += 2) await new Promise((r) => setTimeout(r, 2000));
    const b = await settledBoard(boardId);
    if (!b) return;
    // Nothing planned yet (or the plan failed): plan again, with this message.
    if (!b.shots.length) {
      await change(boardId, (now) => {
        now.status = "planning";
        now.error = undefined;
        now.planNote = text;
        now.planReply = replyId;
      });
      startPlan(boardId);
      return;
    }
    let result: Awaited<ReturnType<typeof readFollowUp>> | null = null;
    let error: string | null = null;
    try {
      result = await readFollowUp(b, text);
    } catch (err) {
      error = (err as Error).message;
    }
    let replan = false;
    await change(boardId, (now) => {
      const reply = (now.messages ?? []).find((m) => m.id === replyId);
      if (!result) {
        if (reply) Object.assign(reply, { text: `I couldn't read that: ${error}`, pending: false });
        return;
      }
      const applied = applyOps(now, result.ops);
      if (reply) Object.assign(reply, { text: result.reply, pending: Boolean(applied.replan) });
      if (applied.replan) {
        replan = true;
        for (const s of now.shots) cancelJobs(s);
        cancelFilm(now);
        now.scene = clean(applied.replan, 4000);
        now.status = "planning";
        now.shots = [];
        now.planReply = replyId;
      }
    });
    if (replan) startPlan(boardId);
    else kick(boardId);
  };
  const before: Promise<unknown> = replies.get(boardId) ?? Promise.resolve();
  const next = before
    .then(work)
    .catch((err: Error) => console.warn(`[storyboard] reply: ${err.message}`))
    .finally(() => replying.delete(replyId));
  replies.set(boardId, next);
}

/* ------------------------------------------------------------------ public */

/** Every board, newest first; boards with work left are moved along. */
export async function listStoryboards() {
  const rows = table().prepare("SELECT data FROM storyboards ORDER BY created_at DESC").all() as { data: string }[];
  const boards = rows.map((r) => JSON.parse(r.data) as Storyboard);
  for (const b of boards) if (hasWork(b)) active.add(b.id);
  ensureTicker();
  return boards;
}

export async function getStoryboard(id: string) {
  return step(id);
}

/**
 * A new film. The director first works it out with you: a short brief gets a few questions (where,
 * how busy, how it plays) and a story to approve; a detailed one (or "just make it") goes straight
 * to the story and the shots.
 */
export async function createStoryboard(input: { scene: string; aspect: AspectId; look: LookId; target: number; models?: { image?: string; video?: string; resolution?: string }; auto?: boolean }) {
  const now = Date.now();
  const scene = input.scene.trim();
  const reply = message("director", "", { pending: true, events: [] });
  const b: Storyboard = {
    id: nanoid(12),
    version: 3,
    title: scene.split(/\s+/).slice(0, 6).join(" "),
    scene,
    aspect: input.aspect,
    look: input.look,
    target: input.target,
    locks: { style: lookById(input.look).prompt, motion: motionLock(input.look) },
    ...(input.models && Object.keys(input.models).length ? { models: input.models } : {}),
    shots: [],
    status: "developing",
    dev: { brief: scene, answers: {}, notes: [], waiting: "develop", reply: reply.id, ...(input.auto ? { auto: true } : {}) },
    messages: [message("user", scene), reply],
    jobs: {},
    createdAt: now,
    updatedAt: now,
  };
  save(b);
  active.add(b.id);
  startDevelop(b.id);
  return b;
}

/** A message to the director: a change, a question, or (with nothing planned) the film itself. */
export async function postMessage(id: string, text: string) {
  // While the film is still being worked out, words answer the questions or reshape the story.
  if (load(id)?.status === "developing") {
    active.add(id);
    return developNote(id, text.trim());
  }
  const reply = message("director", "", { pending: true, events: [] });
  // Claimed before it's saved, so no step takes it for one a restart left behind.
  replying.add(reply.id);
  const b = await change(id, (now) => {
    now.messages = [...(now.messages ?? []), message("user", text.trim()), reply];
    if (now.status === "error" && now.version === 3) now.error = undefined;
  });
  if (!b) {
    replying.delete(reply.id);
    return null;
  }
  active.add(id);
  startFollowUp(id, text.trim(), reply.id);
  return b;
}

type ShotEdit = Partial<Pick<Shot, "id" | "title" | "framing" | "camera" | "layout" | "action" | "acting" | "background" | "end" | "state" | "transition" | "duration">>;

/** Direct edits from the editor: the title, the models, the style, or one shot's plan. */
export async function updateStoryboard(
  id: string,
  patch: { title?: string; models?: { image?: string | null; video?: string | null; resolution?: string | null }; shot?: ShotEdit; style?: string; motion?: string; paused?: boolean },
) {
  const b = await change(id, (b) => {
    if (patch.title?.trim()) b.title = patch.title.trim().slice(0, 80);
    // A model set to null goes back to Auto.
    if (patch.models)
      b.models = Object.fromEntries(Object.entries({ ...b.models, ...patch.models }).filter((e): e is [string, string] => typeof e[1] === "string" && e[1] !== "auto"));
    const ops: EditOp[] = [];
    if (patch.shot?.id) {
      const n = b.shots.findIndex((s) => s.id === patch.shot!.id) + 1;
      if (n > 0) ops.push({ op: "edit", shot: n, ...patch.shot, seconds: patch.shot.duration });
    }
    if (patch.style) ops.push({ op: "style", text: patch.style });
    if (patch.motion) ops.push({ op: "motion", text: patch.motion });
    if (patch.paused === true) ops.push({ op: "pause" });
    if (patch.paused === false) ops.push({ op: "resume" });
    if (ops.length) applyOps(b, ops);
  });
  if (b) kick(id);
  return b;
}

/** Animate a shot again from the same first frame (and redo the shots after it). */
export async function retakeShot(id: string, shotId: string, note?: string) {
  const b = await change(id, (b) => {
    const n = b.shots.findIndex((s) => s.id === shotId) + 1;
    if (n > 0) applyOps(b, [{ op: "retake", shot: n, note }]);
    const s = b.shots[n - 1];
    if (s) s.error = undefined;
  });
  if (b) kick(id);
  return b;
}

/** Draw a shot's first frame again (and redo the shots after it). */
export async function redrawShot(id: string, shotId: string, note?: string) {
  const b = await change(id, (b) => {
    const n = b.shots.findIndex((s) => s.id === shotId) + 1;
    if (n > 0) applyOps(b, [{ op: "redraw", shot: n, note }]);
  });
  if (b) kick(id);
  return b;
}

/** Use an earlier take of a shot (the shots after it start over from its cut). */
export async function pickTake(id: string, shotId: string, take: number) {
  const b = await change(id, (b) => {
    const i = b.shots.findIndex((s) => s.id === shotId);
    const s = b.shots[i];
    const t = s?.takes?.[take];
    if (!s || !t || t.clip === s.clip) return;
    invalidate(b, i + 1, Infinity);
    // A retake still rendering would land over the take you picked.
    cancelJobs(s);
    s.clip = t.clip;
    s.error = undefined;
    s.review = t.review ? { ...t.review, status: t.review.status === "retake" ? "flagged" : t.review.status } : { status: "pending" };
    s.outFrame = undefined;
  });
  if (b) kick(id);
  return b;
}

/** Put the film together again from what's made so far. */
export async function stitchStoryboard(id: string) {
  const b = await change(id, (b) => {
    if (!b.shots.some((s) => s.frame || s.clip)) throw new Error("Nothing to put together yet.");
    if (b.finalJob) return;
    b.final = undefined;
    b.filmFailures = undefined;
    b.finalJob = startFilm(b);
  });
  return b;
}

/** Start a board made with the old storyboard over with the director: same scene, look and shape. */
export async function remakeStoryboard(id: string) {
  const old = load(id);
  if (!old) return null;
  const total = old.shots.reduce((t, s) => t + s.duration, 0) || 30;
  const target = [15, 30, 45, 60].reduce((best, n) => (Math.abs(n - total) < Math.abs(best - total) ? n : best), 30);
  return createStoryboard({ scene: old.scene, aspect: old.aspect, look: old.look, target, models: old.models });
}

export function deleteStoryboard(id: string) {
  const b = load(id);
  if (b) {
    for (const s of b.shots) cancelJobs(s);
    if (b.finalJob) runner().cancel(b.finalJob);
  }
  active.delete(id);
  table().prepare("DELETE FROM storyboards WHERE id = ?").run(id);
}
