import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import sharp from "sharp";
import { EngineError, type EngineContext, type EngineResult } from "@/lib/engines/types";
import type { ModelAvailability } from "@/lib/models/catalog";
import type { Generation } from "@/lib/generations/types";
import { urlToPath } from "@/lib/server/media";
import { canvasFor, instructions, type Canvas } from "./agent";
import { createBrain, type Effort, type ToolResult } from "./brain";
import { contactSheet, frameTimes, kindOf, probe, runFfmpeg, toDataUrl } from "./ffmpeg";
import { motionMedia } from "./media";
import type { MotionPlan } from "./playbook";
import { describeRecent, recentPieces, rememberPiece, type RecentPiece } from "./recent";
import { getProject, updateProject, type MotionFile, type MotionMessage, type MotionProject } from "./store";
import { runTool, stepTitle, TOOL_SPECS, type ToolEnv, type TurnState } from "./tools";
import { cleanName, describeFile, fileLine, uniqueName, workspaceDir } from "./workspace";

/**
 * One Motion turn, run by the background queue. The agent thinks, calls tools (several at once
 * when it can), sees what they made, and keeps going until it delivers a file. Every step lands
 * in the project as it happens, so the page shows the work live; leaving the page doesn't stop
 * it, and Cancel aborts whatever is running.
 */
const MAX_STEPS = 60;
const MAX_MINUTES = 120;

/** How many of each tool run at once: renders take a whole browser, clips a slot on the plan. */
const LANES: Record<string, number> = { generate_image: 4, generate_video: 3, render_html: 1, render_audio: 1, ffmpeg: 2, review: 1, image_map: 1 };

/** Motion thinks as hard as the model allows: the user asked for its best, and the design happens mid-turn. */
const EFFORT: Effort = "max";

function lanes() {
  const active = new Map<string, number>();
  const waiting = new Map<string, (() => void)[]>();
  return async function lane<T>(tool: string, fn: () => Promise<T>): Promise<T> {
    const max = LANES[tool] ?? 6;
    while ((active.get(tool) ?? 0) >= max) await new Promise<void>((r) => waiting.set(tool, [...(waiting.get(tool) ?? []), r]));
    active.set(tool, (active.get(tool) ?? 0) + 1);
    try {
      return await fn();
    } finally {
      active.set(tool, (active.get(tool) ?? 1) - 1);
      const queue = waiting.get(tool) ?? [];
      queue.shift()?.();
      waiting.set(tool, queue);
    }
  };
}

/** Batches the turn's log updates into the project file (at most every 700 ms, or right away). */
function logWriter(projectId: string, agentMessageId: string) {
  let pending: ((m: MotionMessage, p: MotionProject) => void)[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let chain: Promise<void> = Promise.resolve();
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!pending.length) return chain;
    const batch = pending;
    pending = [];
    chain = chain
      .then(() =>
        updateProject(projectId, (p) => {
          const m = p.messages.find((x) => x.id === agentMessageId);
          if (m) for (const change of batch) change(m, p);
        }),
      )
      .then(() => undefined, () => undefined);
    return chain;
  };
  return {
    queue(change: (m: MotionMessage, p: MotionProject) => void, now = false) {
      pending.push(change);
      if (now) return flush();
      timer ??= setTimeout(() => void flush(), 700);
      return chain;
    },
    flush,
  };
}

/** A short project name from the first request: its first clause, cut at a word. */
function titleFrom(text: string) {
  const clause = text.split(/[.:;!?](?:\s|$)|\n/)[0].trim().replace(/^(make|create|design|build)( me)? /i, "");
  const short = clause.length <= 44 ? clause : `${clause.slice(0, clause.lastIndexOf(" ", 44) > 20 ? clause.lastIndexOf(" ", 44) : 44).replace(/[,\s]+$/, "")}…`;
  return short.charAt(0).toUpperCase() + short.slice(1);
}

/** The headline of a reasoning summary ("**Planning the cut**" → "Planning the cut"). */
function headline(summary: string) {
  const bold = /\*\*(.+?)\*\*/.exec(summary)?.[1];
  const line = (bold ?? summary.split(/\n|(?<=\.)\s/)[0]).trim();
  return line.length > 4 ? line.slice(0, 80) : "";
}

const soft = (steps: number) => Math.min(0.95, 0.05 + 0.9 * (1 - Math.exp(-steps / 8)));

/** Copies this message's attachments into the project folder, read-only, under their own names. */
async function importAttachments(projectId: string, request: MotionMessage, dir: string): Promise<MotionFile[]> {
  const imported: MotionFile[] = [];
  const names: (string | undefined)[] = [];
  for (const att of request.attachments ?? []) {
    const src = urlToPath(att.url);
    if (!src) {
      names.push(undefined);
      continue;
    }
    const name = await uniqueName(dir, cleanName(att.name || path.basename(src), path.extname(src).slice(1).toLowerCase()));
    const dest = path.join(dir, name);
    await fs.copyFile(src, dest);
    await fs.chmod(dest, 0o444).catch(() => {});
    imported.push(await describeFile(projectId, name, "upload", { turn: request.id }));
    names.push(name);
  }
  if (imported.length) {
    await updateProject(projectId, (p) => {
      p.files = [...(p.files ?? []).filter((f) => !imported.some((i) => i.name === f.name)), ...imported];
      const m = p.messages.find((x) => x.id === request.id);
      m?.attachments?.forEach((a, i) => names[i] && Object.assign(a, { file: names[i] }));
    });
  }
  return imported;
}

async function imagePreview(file: string) {
  return toDataUrl(await sharp(file).resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true }).flatten({ background: "#101012" }).jpeg({ quality: 80 }).toBuffer());
}

async function videoFrames(file: string) {
  const info = await probe(file);
  return toDataUrl(await contactSheet(file, info, frameTimes(info.duration ?? 1, 6)));
}

function planSummary(p: MotionPlan) {
  const shots = p.shots.map((s, i) => `${i + 1}) ${s.seconds} s: ${s.what}${s.text ? ` [text: "${s.text}"]` : ""}`).join("\n");
  return [
    `Concept: ${p.concept}`,
    p.format ? `Format: ${p.format}` : "",
    `Look: ${p.look}${p.palette ? `; palette: ${p.palette}` : ""}`,
    `Sound: score ${p.music || "none"}; effects ${p.sfx || "none"}`,
    `Shots:\n${shots}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** What the agent reads first: the folder, the conversation so far, the plan, the request, and pictures of the material. */
async function firstMessage(project: MotionProject, request: MotionMessage, canvas: Canvas, dir: string, attached: MotionFile[], recent: RecentPiece[]) {
  const images: string[] = [];
  const shown: string[] = [];
  for (const f of attached.filter((x) => x.kind === "image").slice(0, 6)) {
    images.push(await imagePreview(path.join(dir, f.name)));
    shown.push(`${f.name} (image)`);
  }
  for (const f of attached.filter((x) => x.kind === "video").slice(0, 2)) {
    const frames = await videoFrames(path.join(dir, f.name)).catch(() => null);
    if (frames) {
      images.push(frames);
      shown.push(`${f.name} (6 frames, start to end)`);
    }
  }
  const before = project.messages.filter((m) => m.createdAt < request.createdAt);
  const lastDelivery = [...before].reverse().find((m) => m.output?.kind === "video")?.output;
  if (lastDelivery && images.length < 8) {
    const frames = await videoFrames(path.join(dir, lastDelivery.name)).catch(() => null);
    if (frames) {
      images.push(frames);
      shown.push(`${lastDelivery.name}, your last delivery (6 frames)`);
    }
  }
  const history = before.slice(-10).map((m) =>
    m.role === "user" ? `User: ${m.text.slice(0, 600) || "(attachments only)"}` : `You: ${(m.text || "(no reply)").slice(0, 500)}${m.output ? ` [delivered ${m.output.name}]` : ""}`,
  );
  const files = project.files ?? [];
  const others = describeRecent(recent);
  const text = [
    `Project: ${project.title}`,
    `Canvas: ${canvas.aspect === "auto" ? "your choice" : `${canvas.aspect}, ${canvas.width}x${canvas.height}`}`,
    files.length ? `Project folder (${files.length} files):\n${files.map(fileLine).join("\n")}` : "Project folder: empty.",
    attached.length ? `Attached with this message: ${attached.map((f) => f.name).join(", ")}` : "",
    history.length ? `Earlier in this project:\n${history.join("\n")}` : "",
    project.plan ? `The plan this project was made to:\n${planSummary(project.plan)}` : "This project has no plan yet: draw ideas and plan before you make anything.",
    others && !project.plan ? `Recent Motion projects looked like this; make this one its own thing:\n${others}` : "",
    shown.length ? `Pictures below, in order: ${shown.join("; ")}.` : "",
    `Request:\n${request.text || "Make something great with what I attached."}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  return { text, images };
}

/** The delivered file in a form every player and the Library understand. */
async function deliverable(dir: string, name: string, signal: AbortSignal): Promise<{ name: string; data: Buffer; mime: string }> {
  const file = path.join(dir, name);
  const ext = path.extname(name).slice(1).toLowerCase();
  const kind = kindOf(name);
  if (kind === "video" && (ext === "mp4" || ext === "webm")) return { name, data: await fs.readFile(file), mime: `video/${ext}` };
  if (kind === "image" && ["png", "jpg", "jpeg", "webp"].includes(ext)) return { name, data: await fs.readFile(file), mime: ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg" };
  if (kind === "image") {
    const out = await uniqueName(dir, cleanName(name, "png"));
    await sharp(file).png().toFile(path.join(dir, out));
    return { name: out, data: await fs.readFile(path.join(dir, out)), mime: "image/png" };
  }
  const out = await uniqueName(dir, cleanName(name, "mp4"));
  const run = await runFfmpeg(["-hide_banner", "-y", "-loglevel", "error", "-i", name, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-c:a", "aac", "-movflags", "+faststart", out], { cwd: dir, signal });
  if (run.code !== 0) throw new EngineError(`Couldn't prepare ${name} for playback: ${run.stderr.trim().slice(0, 200)}`);
  return { name: out, data: await fs.readFile(path.join(dir, out)), mime: "video/mp4" };
}

export async function runMotion(gen: Generation, model: ModelAvailability, ctx: EngineContext): Promise<EngineResult> {
  const { projectId, messageId, agentMessageId } = (gen.params ?? {}) as { projectId: string; messageId: string; agentMessageId: string };
  const canvas = canvasFor(String(gen.params?.aspect ?? "auto"));
  let project = await getProject(projectId);
  if (!project) throw new EngineError("This Motion project no longer exists.");
  const request = project.messages.find((m) => m.id === messageId);
  if (!request) throw new EngineError("Couldn't find your message in the project.");

  const dir = workspaceDir(projectId);
  await fs.mkdir(dir, { recursive: true });
  const log = logWriter(projectId, agentMessageId);
  ctx.progress(0.02, "Opening the project");
  const attached = await importAttachments(projectId, request, dir);
  // Only a name: a failed save never stops the turn.
  if (project.title === "Untitled motion" && request.text) await updateProject(projectId, (p) => void (p.title = titleFrom(request.text))).catch(() => {});
  project = (await getProject(projectId)) ?? project;

  const recent = await recentPieces(projectId);
  const first = await firstMessage(project, request, canvas, dir, attached, recent);
  // Which image and video models this turn may use: the user's plans first, paid APIs only without any plan.
  const media = await motionMedia();
  const brain = await createBrain(model, instructions(canvas, media), TOOL_SPECS, first);
  const origin = `http://127.0.0.1:${process.env.PORT || 3210}`;
  const usage = { images: 0, videos: 0 };
  const turnState: TurnState = { plan: project.plan ?? null, reviews: 0, reviewed: new Set(), draws: 0 };
  const savePlan = async (plan: MotionPlan) => {
    await log.queue((_, p) => void (p.plan = plan), true);
    await rememberPiece(projectId, plan).catch(() => {});
  };
  const lane = lanes();
  const effort = EFFORT;
  const started = Date.now();
  const state: { delivered: { file: string; message: string } | null; lastVideo: string | null; closing: { id: string; text: string } | null } = {
    delivered: null,
    lastVideo: null,
    closing: null,
  };
  let steps = 0;

  // Full-length edits made this turn, newest last: what gets delivered if time runs out first.
  const cuts: { name: string; duration: number }[] = [];
  const addFile: ToolEnv["addFile"] = async (name, source, extra) => {
    const f = await describeFile(projectId, name, source, { turn: agentMessageId, ...extra });
    await log.queue((_, p) => void (p.files = [...(p.files ?? []).filter((x) => x.name !== name), f]), true);
    if (f.kind === "video") state.lastVideo = name;
    if (f.kind === "video" && (source === "ffmpeg" || source === "render") && f.duration) cuts.push({ name, duration: f.duration });
    return f;
  };
  const bestCut = () => {
    const want = turnState.plan?.seconds;
    const full = want ? cuts.filter((c) => Math.abs(c.duration - want) <= want * 0.2) : cuts;
    return (full.at(-1) ?? cuts.at(-1))?.name ?? state.lastVideo;
  };
  const minutes = () => (Date.now() - started) / 60_000;
  let timedOut = false;

  try {
    for (let turn = 0; turn < MAX_STEPS && !state.delivered; turn++) {
      if (minutes() > MAX_MINUTES) {
        timedOut = true;
        break;
      }
      ctx.progress(soft(steps), turn === 0 ? "Planning" : "Thinking");
      const noteId = nanoid(8);
      let noted = false;
      const reply = await brain.step({
        signal: ctx.signal,
        effort,
        onText: (soFar) => {
          if (!noted) {
            noted = true;
            void log.queue((m) => void (m.log ??= []).push({ id: noteId, kind: "note", text: soFar, at: Date.now() }));
          } else {
            void log.queue((m) => {
              const e = m.log?.find((x) => x.id === noteId);
              if (e?.kind === "note") e.text = soFar;
            });
          }
        },
        onThinking: (summary) => {
          const t = headline(summary);
          if (t) ctx.progress(soft(steps), t);
        },
        onArgs: (chars) => ctx.progress(soft(steps), `Writing · ${(chars / 1024).toFixed(1)} KB`),
      });

      if (reply.text) {
        await log.queue((m) => {
          m.log ??= [];
          const e = m.log.find((x) => x.id === noteId);
          if (e?.kind === "note") e.text = reply.text;
          else m.log.push({ id: noteId, kind: "note", text: reply.text, at: Date.now() });
        }, true);
      }
      if (!reply.calls.length) {
        if (reply.text) state.closing = { id: noteId, text: reply.text };
        break;
      }

      const results = await Promise.all(
        reply.calls.map(async (call): Promise<ToolResult> => {
          const id = nanoid(8);
          const title = stepTitle(call);
          steps++;
          await log.queue((m) => void (m.log ??= []).push({ id, kind: "step", tool: call.name, title, status: "running", at: Date.now() }), true);
          ctx.progress(soft(steps), title);
          const env: ToolEnv = {
            projectId,
            dir,
            origin,
            canvas,
            signal: ctx.signal,
            usage,
            media,
            model,
            brief: request.text,
            turn: turnState,
            savePlan,
            recent,
            detail: (text) => {
              void log.queue((m) => {
                const e = m.log?.find((x) => x.id === id);
                if (e?.kind === "step") e.detail = text;
              });
              ctx.progress(soft(steps), `${title} · ${text}`);
            },
            addFile,
            addComposition: async (c) => void (await log.queue((_, p) => void p.compositions.push(c), true)),
            files: async () => (await getProject(projectId))?.files ?? [],
          };
          const outcome = await lane(call.name, () => runTool(call, env));
          if (outcome.finish) state.delivered = outcome.finish;
          await log.queue((m) => {
            const e = m.log?.find((x) => x.id === id);
            if (e?.kind !== "step") return;
            e.status = outcome.ok ? "done" : "error";
            e.files = outcome.files?.length ? outcome.files : undefined;
            e.detail = outcome.ok ? outcome.summary : outcome.output.replace(/^Error:\s*/, "").split("\n")[0].slice(0, 240);
            e.endedAt = Date.now();
          }, true);
          return { id: call.id, output: outcome.output, images: outcome.images };
        }),
      );
      if (state.delivered) break;
      // The clock, so the agent paces itself instead of polishing until the turn is cut off.
      const used = minutes();
      const clock =
        used > MAX_MINUTES * 0.85
          ? `Time: ${Math.round(used)} of ${MAX_MINUTES} minutes used. Finish now with your best full cut; nothing else.`
          : used > MAX_MINUTES * 0.65
            ? `Time: ${Math.round(used)} of ${MAX_MINUTES} minutes used. Wrap up: no new generations or full re-renders; make only the fixes that matter, then review (if you have a round left) and finish.`
            : used > MAX_MINUTES * 0.4
              ? `Time: ${Math.round(used)} of ${MAX_MINUTES} minutes used. Aim to deliver within the next 20-30 minutes.`
              : "";
      if (clock && results.length) results[results.length - 1] = { ...results[results.length - 1], output: `${results[results.length - 1].output}\n\n(${clock})` };
      brain.results(results);
    }
  } catch (err) {
    await log.queue((m) => {
      for (const e of m.log ?? []) {
        if (e.kind === "step" && e.status === "running") {
          e.status = "stopped";
          e.endedAt = Date.now();
        }
      }
    }, true);
    throw err;
  }

  // Out of time before finish: the latest full cut goes out rather than nothing.
  if (timedOut && !state.delivered) {
    const cut = bestCut();
    if (!cut) throw new EngineError("Motion ran out of time on this turn.", "Ask it to carry on from where it stopped.");
    state.delivered = { file: cut, message: `I ran out of time before my last check, so this is the latest full cut (${cut}). Ask me to carry on and I'll finish the polish.` };
  }
  // A turn that ends in words (a question, a short answer) shows them once, as the reply.
  const closing = state.closing;
  const finalName = state.delivered?.file ?? (closing ? null : (bestCut() ?? state.lastVideo));
  if (!finalName) {
    await log.queue((m) => {
      if (closing) m.log = m.log?.filter((e) => e.id !== closing.id);
      m.text = closing?.text ?? "I stopped before making anything. Tell me how to carry on.";
    }, true);
    return { outputs: [], usedPrompt: request.text };
  }
  ctx.progress(0.97, "Delivering");
  const out = await deliverable(dir, finalName, ctx.signal);
  const f = out.name === finalName ? (await getProject(projectId))?.files?.find((x) => x.name === finalName) : await addFile(out.name, "ffmpeg");
  const message = state.delivered?.message || `Here's ${out.name}.`;
  await log.queue((m) => {
    m.text = message;
    m.output = { name: out.name, url: f?.url ?? "", kind: kindOf(out.name) === "image" ? "image" : "video" };
  }, true);
  return { outputs: [{ data: out.data, mime: out.mime, width: f?.width, height: f?.height }], usedPrompt: request.text };
}
