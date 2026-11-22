import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import { z } from "zod";
import type { Generation } from "@/lib/generations/types";
import { listModels } from "@/lib/models/resolve";
import { canvasFor, instructions, type Canvas } from "@/lib/motion/agent";
import { kindOf } from "@/lib/motion/ffmpeg";
import { deliverable, lanes, logWriter } from "@/lib/motion/job";
import { motionMedia, type MotionMedia } from "@/lib/motion/media";
import type { MotionPlan } from "@/lib/motion/playbook";
import { recentPieces, rememberPiece, type RecentPiece } from "@/lib/motion/recent";
import { createProject, getProject, listProjects, updateProject, type MotionFile, type MotionProject } from "@/lib/motion/store";
import { LIMITS, runTool, stepTitle, TOOL_SPECS, type ToolEnv, type ToolOutcome, type TurnState } from "@/lib/motion/tools";
import { cleanName, describeFile, uniqueName, validProjectId, workspaceDir } from "@/lib/motion/workspace";
import { saveGeneration } from "@/lib/server/db";
import { saveOutputs } from "@/lib/server/media";
import { fail } from "./errors";
import { agentMark, type Caller } from "./jobs";
import { agentMachines } from "./machines";
import { shownFrom, type Shown } from "./pictures";
import { planJob, requireConfirm } from "./plan";
import { confirm, existing, showArg, tool, waitArg, type ToolContext } from "./shared";

/**
 * Motion, worked by an agent outside Crackio. Motion is a project: a folder of files, a plan, and a log of what was
 * done, with a page that plays the result. Its own agent runs Motion's tools (plan, write a file, render HTML to a
 * clip, ffmpeg, generate a picture or a clip, look, finish) one after another; here the agent that calls the MCP is
 * that brain. Each call runs one of those same tools in the project and is written to the project's log as a step, so
 * the Motion page shows the work as it happens, the way it shows its own agent's.
 *
 * A render or a generated clip takes minutes and an MCP call may not: a step that isn't done within `wait` seconds
 * answers with its id, and `wait` is called on it.
 */

type Step = { id: string; tool: string; title: string; startedAt: number; done: ToolOutcome | null; promise: Promise<ToolOutcome>; abort: AbortController };
type Session = {
  projectId: string;
  messageId: string;
  client: string;
  brief: string;
  canvas: Canvas;
  dir: string;
  usage: { images: number; videos: number };
  turn: TurnState;
  media: MotionMedia;
  recent: RecentPiece[];
  log: ReturnType<typeof logWriter>;
  lane: ReturnType<typeof lanes>;
  steps: Map<string, Step>;
  startedAt: number;
};

const g = globalThis as unknown as { __crackioAgentMotion?: Map<string, Session> };
const sessions = (g.__crackioAgentMotion ??= new Map());

const ASPECTS = ["auto", "16:9", "9:16", "1:1", "4:5", "21:9"] as const;
const TOOL_NAMES = TOOL_SPECS.map((t) => t.name);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const openLink = (id: string) => `/tools/motion?project=${id}`;

async function project(id: string | undefined): Promise<MotionProject> {
  if (!id) throw fail("invalid_input", { field: "project", what: 'Say which project: "project" is its id (motion with action "projects" lists them, "new" makes one).' });
  const p = validProjectId(id) ? await getProject(id) : null;
  if (!p) {
    const list = await listProjects().catch(() => []);
    throw fail("file_not_found", { field: "project", what: `There's no Motion project "${id.slice(0, 60)}".`, did_you_mean: list.slice(0, 6).map((x) => x.id), do: 'Call motion with action "projects".' });
  }
  return p;
}

const fileView = (f: MotionFile) => ({
  name: f.name,
  // (Without the address's cache suffix: it becomes a path on the agent's side.)
  file: f.url.split("?")[0],
  kind: f.kind,
  ...(f.width && f.height ? { width: f.width, height: f.height } : {}),
  ...(f.duration ? { seconds: Math.round(f.duration * 100) / 100 } : {}),
  ...(f.kind === "video" ? { sound: Boolean(f.audio) } : {}),
  made_by: f.source,
});

/** The open turn an agent works in, or a new one: your words as the request, and an empty log for its steps. */
async function turn(p: MotionProject, caller: Caller, brief: string | undefined, aspect: string | undefined, fresh = false): Promise<Session> {
  const held = sessions.get(p.id);
  if (held && !fresh && p.messages.some((m) => m.id === held.messageId && m.agent?.open)) return held;
  // A turn left open by a session that is gone (Crackio restarted): its running steps stopped with it.
  await updateProject(p.id, (x) => {
    for (const m of x.messages) {
      if (!m.agent?.open) continue;
      m.agent = { ...m.agent, open: false };
      for (const e of m.log ?? []) if (e.kind === "step" && e.status === "running") Object.assign(e, { status: "stopped", endedAt: Date.now() });
      if (!m.text) m.text = "The agent left before it finished.";
    }
  });
  const now = Date.now();
  const text = (brief ?? "").trim() || [...p.messages].reverse().find((m) => m.role === "user")?.text || "A piece made by an agent.";
  const user = { id: nanoid(10), role: "user" as const, text, createdAt: now };
  const agent = { id: nanoid(10), role: "agent" as const, text: "", log: [], agent: { client: caller.client, open: true, at: now }, createdAt: now + 1 };
  const titled = p.title === "Untitled motion" ? text.split(/[.!?\n]/)[0].trim().slice(0, 48) : "";
  await updateProject(p.id, (x) => {
    x.messages.push(user, agent);
    if (titled) x.title = titled;
  });
  const dir = workspaceDir(p.id);
  await fs.mkdir(/*turbopackIgnore: true*/ dir, { recursive: true });
  const [media, recent] = await Promise.all([motionMedia(), recentPieces(p.id).catch(() => [])]);
  const s: Session = {
    projectId: p.id,
    messageId: agent.id,
    client: caller.client,
    brief: text,
    canvas: canvasFor(aspect ?? held?.canvas.aspect ?? "auto"),
    dir,
    usage: { images: 0, videos: 0 },
    turn: { plan: p.plan ?? null, reviews: 0, reviewed: new Set(), draws: 0 },
    media,
    recent,
    log: logWriter(p.id, agent.id),
    lane: lanes(),
    steps: new Map(),
    startedAt: now,
  };
  sessions.set(p.id, s);
  return s;
}

/** A picture or clip made inside Motion runs on the machine Crackio picks by itself: the user's money rules hold there too. */
async function moneyCheck(name: string, args: Record<string, unknown>, s: Pick<Session, "media" | "canvas">, all: Record<string, unknown>, ctx: ToolContext) {
  if (name !== "generate_image" && name !== "generate_video") return;
  const video = name === "generate_video";
  const id = video ? (args.start_image ? s.media.video : (s.media.videoFromText ?? s.media.video)) : s.media.image;
  if (!id) return; // Motion's own tool says there's no model for it.
  const model = (await listModels()).find((m) => m.id === id);
  if (!model) return;
  const aspect = s.canvas.aspect === "auto" ? "16:9" : s.canvas.aspect;
  const plan = await planJob(model, { kind: video ? "video" : "image", aspect, count: 1, references: 0, unpinned: true, ...(video ? { duration: Number(args.duration ?? args.seconds) || 5 } : {}) }, ctx.prefs);
  requireConfirm("motion", all, plan);
}

const toShown = async (images: string[] | undefined, key: string): Promise<Shown[]> =>
  Promise.all((images ?? []).slice(0, 4).map((url, i) => shownFrom(Buffer.from(url.slice(url.indexOf(",") + 1), "base64"), `motion-${key}-${i}`)));

/** The piece goes out: the turn's reply and its file on the Motion page, and a take in the Library. */
async function deliver(s: Session, caller: Caller, done: { file: string; message: string }) {
  const out = await deliverable(s.dir, done.file, AbortSignal.timeout(10 * 60_000));
  let f = (await getProject(s.projectId))?.files?.find((x) => x.name === out.name);
  if (!f) {
    f = await describeFile(s.projectId, out.name, "ffmpeg", { turn: s.messageId });
    await s.log.queue((_, p) => void (p.files = [...(p.files ?? []).filter((x) => x.name !== out.name), f!]), true);
  }
  const kind = kindOf(out.name) === "image" ? ("image" as const) : ("video" as const);
  const id = nanoid(14);
  const now = Date.now();
  const outputs = await saveOutputs(id, [{ data: out.data, mime: out.mime, width: f.width, height: f.height }]);
  const gen: Generation = {
    id,
    tool: "motion",
    engine: "auto",
    model: "auto",
    modelName: `Motion · ${caller.client}`,
    status: "done",
    prompt: s.brief,
    aspect: s.canvas.aspect === "auto" ? "16:9" : s.canvas.aspect,
    count: 1,
    references: [],
    outputs,
    params: { kind: "motion", projectId: s.projectId, agentMessageId: s.messageId, aspect: s.canvas.aspect, agent: agentMark(caller) },
    progress: 1,
    createdAt: s.startedAt,
    startedAt: s.startedAt,
    finishedAt: now,
  };
  saveGeneration(gen);
  await s.log.queue((m) => {
    m.text = done.message || `Here's ${out.name}.`;
    m.output = { name: out.name, url: f!.url, kind };
    m.generationId = id;
    if (m.agent) m.agent = { ...m.agent, open: false, at: now };
  }, true);
  sessions.delete(s.projectId);
  return { delivered: out.name, file: f.url.split("?")[0], library_job: id };
}

/** What a finished step says: the tool's own words, the files it made (as paths), and what it showed. */
async function answer(s: Session, step: Step, outcome: ToolOutcome, show: boolean, ctx: ToolContext) {
  const files = outcome.files?.length ? ((await getProject(s.projectId))?.files ?? []).filter((f) => outcome.files!.includes(f.name)).map(fileView) : [];
  const delivered = outcome.finish && outcome.ok ? await deliver(s, ctx.caller, outcome.finish) : null;
  return {
    data: {
      step: step.id,
      tool: step.tool,
      status: outcome.ok ? "done" : "failed",
      took_s: Math.round((Date.now() - step.startedAt) / 100) / 10,
      says: outcome.output,
      ...(files.length ? { files } : {}),
      ...(delivered ? { ...delivered, open: openLink(s.projectId), note: "The turn is closed. Tell the user where it is: the Motion page plays it, and it's in the Library." } : {}),
    },
    images: show && ctx.prefs.seePictures ? await toShown(outcome.images, step.id) : [],
  };
}

const waitOn = async (step: Step, seconds: number) => step.done ?? (await Promise.race([step.promise, sleep(Math.max(0, seconds) * 1000).then(() => null)]));

const running = (s: Session, step: Step) => ({
  data: {
    step: step.id,
    tool: step.tool,
    status: "running",
    running_s: Math.round((Date.now() - step.startedAt) / 1000),
    doing: step.title,
    do: 'It keeps going. Call motion with action "wait", this project and this step (a render or a generated clip takes minutes).',
    open: openLink(s.projectId),
  },
});

export const motion = tool({
  name: "motion",
  title: "Motion",
  description:
    'Motion is a project on a canvas: you plan a piece, write HTML/CSS/JS that is rendered to a clip, generate or bring in pictures, clips and sound, cut with ffmpeg, look at the result and deliver it. Everything stays in one project the user can open. Start with action "new" (it returns how to work), then "tools" once, then "run" one Motion tool at a time.',
  input: z.object({
    action: z.enum(["projects", "new", "open", "tools", "run", "wait", "stop", "add"]).describe("projects: list. new: a project and a turn. open: one project's state. tools: Motion's tools and their arguments. run: one of them. wait: on a running step. stop: a running step. add: bring files in."),
    project: z.string().max(60).optional().describe("The project's id (all but projects and new)."),
    title: z.string().max(80).optional().describe("new: the project's name."),
    brief: z.string().max(4000).optional().describe("new, or run to start another turn: what the user asked for, in their words."),
    aspect: z.enum(ASPECTS).optional().describe("new: the canvas (default auto: you choose in the plan)."),
    tool: z.string().max(40).optional().describe("run: the Motion tool's name (from tools)."),
    args: z.record(z.string(), z.unknown()).optional().describe("run: that tool's arguments."),
    step: z.string().max(20).optional().describe("wait, stop: the step's id."),
    files: z.array(z.string().max(1000)).max(12).optional().describe("add: pictures, clips or sound made with other tools (make_image, make_video, voice…) or the user's own, as paths."),
    names: z.array(z.string().max(80)).max(12).optional().describe('add: the name each file gets in the project, in the same order ("hero.png", "voice.wav"). Name them: you use these names in your HTML and in ffmpeg.'),
    guide: z.boolean().optional().describe("open: true also returns how to work."),
    confirm,
    wait: waitArg,
    show: showArg,
  }),
  files: ["files.*"],
  async run(args, ctx) {
    if (args.action === "projects") {
      const list = await listProjects();
      return { data: { projects: list.slice(0, 30).map((p) => ({ project: p.id, title: p.title, updated: new Date(p.updatedAt).toLocaleString("sv-SE").slice(0, 16) })), ...(list.length ? {} : { note: 'None yet: action "new" makes one.' }) } };
    }
    if (args.action === "tools") {
      return {
        data: {
          tools: TOOL_SPECS.map((t) => ({ name: t.name, description: t.description, arguments: t.parameters })),
          how: 'Call motion with action "run", the project, "tool" and "args". The "title" argument most tools take is the line the user sees on the Motion page while the step runs: write it for them.',
        },
      };
    }
    if (args.action === "new") {
      const p = await createProject(args.title?.trim() || "Untitled motion");
      const s = await turn(p, ctx.caller, args.brief, args.aspect, true);
      return {
        data: {
          project: p.id,
          open: openLink(p.id),
          canvas: s.canvas,
          how_to_work: instructions(s.canvas, s.media),
          next: 'Call motion with action "tools" once (their arguments). Then run "plan" first: generating and rendering need a plan. Deliver with the "finish" tool. Files made with Crackio\'s other tools (make_image, make_video, voice, upscale…) come in with action "add".',
          you_are: "the designer here: Crackio's own Motion agent isn't running. Where the text above says \"you\", that is you.",
        },
      };
    }
    const p = await project(args.project);
    if (args.action === "open") {
      const held = sessions.get(p.id);
      const canvas = held?.canvas ?? canvasFor("auto");
      const last = [...p.messages].reverse().find((m) => m.role === "agent");
      return {
        data: {
          project: p.id,
          title: p.title,
          open: openLink(p.id),
          canvas,
          ...(p.plan ? { plan: p.plan } : { plan: null }),
          files: (p.files ?? []).map(fileView),
          turns: p.messages.filter((m) => m.role === "user").length,
          ...(last?.output ? { last_delivered: last.output.name } : {}),
          ...(held ? { turn_open: true, running: [...held.steps.values()].filter((x) => !x.done).map((x) => ({ step: x.id, tool: x.tool, doing: x.title })) } : { turn_open: false, note: 'A "run" starts a new turn (pass "brief": what the user asked for now).' }),
          ...(args.guide ? { how_to_work: instructions(canvas, held?.media ?? (await motionMedia())) } : {}),
        },
      };
    }
    if (args.action === "add") {
      if (!args.files?.length) throw fail("invalid_input", { field: "files", what: 'Pass "files": the paths to bring into the project.' });
      const s = await turn(p, ctx.caller, args.brief, undefined);
      const added: ReturnType<typeof fileView>[] = [];
      for (const [i, value] of args.files.entries()) {
        const f = await existing(value, `files.${i}`, ctx.viaProgram);
        // (A file sent from the agent's computer arrives under a random id: its name here is the one asked for.)
        const ext = path.extname(f.path).slice(1).toLowerCase();
        const wanted = args.names?.[i]?.trim();
        const name = await uniqueName(s.dir, cleanName(wanted || path.basename(f.path), wanted && !path.extname(wanted) ? ext : undefined));
        await fs.copyFile(/*turbopackIgnore: true*/ f.path, path.join(s.dir, name));
        const described = await describeFile(p.id, name, "upload", { turn: s.messageId });
        await s.log.queue((_, x) => void (x.files = [...(x.files ?? []).filter((y) => y.name !== name), described]), true);
        added.push(fileView(described));
      }
      await s.log.queue((m) => {
        (m.log ??= []).push({ id: nanoid(8), kind: "step", tool: "add", title: `Brought in ${added.length === 1 ? added[0].name : `${added.length} files`}`, status: "done", files: added.map((a) => a.name), at: Date.now(), endedAt: Date.now() });
        if (m.agent) m.agent = { ...m.agent, at: Date.now() };
      }, true);
      return { data: { added, note: "Use them by name in your HTML (relative paths) and in ffmpeg." } };
    }
    if (args.action === "wait" || args.action === "stop") {
      const s = sessions.get(p.id);
      const step = s?.steps.get(args.step ?? "") ?? (s && !args.step ? [...s.steps.values()].filter((x) => !x.done).at(-1) : undefined);
      if (!s || !step) throw fail("job_not_found", { field: "step", what: "That step isn't running here (any more).", do: 'Call motion with action "open" to see the project\'s files and what is running.' });
      if (args.action === "stop") {
        step.abort.abort();
        const outcome = await waitOn(step, 10);
        return { data: { step: step.id, status: outcome ? "stopped" : "stopping" } };
      }
      const outcome = await waitOn(step, args.wait ?? 25);
      return outcome ? answer(s, step, outcome, args.show ?? true, ctx) : running(s, step);
    }

    // run
    const name = args.tool ?? "";
    if (!TOOL_NAMES.includes(name)) throw fail("invalid_input", { field: "tool", what: name ? `Motion has no tool "${name.slice(0, 40)}".` : 'Say which Motion tool: "tool".', allowed: TOOL_NAMES });
    // Another brief on a turn that has already done things is the next turn (the user asked for something new).
    const held = sessions.get(p.id);
    const another = Boolean(args.brief?.trim() && held && held.steps.size > 0 && args.brief.trim() !== held.brief);
    const toolArgs = args.args ?? {};
    // (Before a turn is opened: a refusal leaves nothing behind on the user's page.)
    await moneyCheck(name, toolArgs, held ?? { media: await motionMedia(), canvas: canvasFor("auto") }, args as Record<string, unknown>, ctx);
    const s = await turn(p, ctx.caller, args.brief, undefined, another);
    // Motion's review is a second opinion from one of Crackio's own models that see: a hosted one costs credits, and
    // one on the user's GPUs runs on whatever machine is on, which may be a rented one. Under "free" neither is used
    // unless a free machine is on. With no reviewer the agent, who has eyes of its own, is the reviewer.
    const free = ctx.prefs.spend === "free";
    const freeMachine = free ? (await agentMachines().catch(() => ({ machines: [] }))).machines.some((m) => m.online && !m.paid) : true;
    const reviewer = (await listModels()).find((m) => m.kind === "text" && m.available && (m.id.startsWith("local:") ? freeMachine : !free));
    // (finish asks for a review first: with none to be had, that round counts as used.)
    if (!reviewer) s.turn.reviews = LIMITS.reviews;
    if (name === "review" && !reviewer) {
      return { data: { tool: "review", status: "skipped", says: "No model of Crackio's own is free to give a second opinion here. Be the reviewer yourself: run look on the cut (frames across it, then the moments that matter) and judge it against THE BAR in how_to_work. Then finish." } };
    }
    const call = { id: nanoid(8), name, args: toolArgs };
    const step: Step = { id: nanoid(8), tool: name, title: stepTitle(call), startedAt: Date.now(), done: null, promise: Promise.resolve({ ok: false, output: "" }), abort: new AbortController() };
    await s.log.queue((m) => {
      (m.log ??= []).push({ id: step.id, kind: "step", tool: name, title: step.title, status: "running", at: step.startedAt });
      if (m.agent) m.agent = { ...m.agent, at: Date.now() };
    }, true);
    const env: ToolEnv = {
      projectId: p.id,
      dir: s.dir,
      origin: `http://127.0.0.1:${process.env.PORT || 3210}`,
      canvas: s.canvas,
      signal: step.abort.signal,
      usage: s.usage,
      media: s.media,
      model: reviewer as ToolEnv["model"],
      brief: s.brief,
      turn: s.turn,
      savePlan: async (plan: MotionPlan) => {
        await s.log.queue((_, x) => void (x.plan = plan), true);
        await rememberPiece(p.id, plan).catch(() => {});
      },
      recent: s.recent,
      detail: (text) => {
        void s.log.queue((m) => {
          const e = m.log?.find((x) => x.id === step.id);
          if (e?.kind === "step") e.detail = text;
        });
      },
      addFile: async (file, source, extra) => {
        const f = await describeFile(p.id, file, source, { turn: s.messageId, ...extra });
        await s.log.queue((_, x) => void (x.files = [...(x.files ?? []).filter((y) => y.name !== file), f]), true);
        return f;
      },
      addComposition: async (c) => void (await s.log.queue((_, x) => void x.compositions.push(c), true)),
      files: async () => (await getProject(p.id))?.files ?? [],
    };
    step.promise = s
      .lane(name, () => runTool(call, env))
      .catch((err: unknown): ToolOutcome => ({ ok: false, output: step.abort.signal.aborted ? "Stopped." : `Error: ${err instanceof Error ? err.message : String(err)}` }))
      .then(async (outcome) => {
        step.done = outcome;
        await s.log.queue((m) => {
          const e = m.log?.find((x) => x.id === step.id);
          if (e?.kind === "step") {
            e.status = step.abort.signal.aborted ? "stopped" : outcome.ok ? "done" : "error";
            e.files = outcome.files?.length ? outcome.files : undefined;
            e.detail = outcome.ok ? outcome.summary : outcome.output.replace(/^Error:\s*/, "").split("\n")[0].slice(0, 240);
            e.endedAt = Date.now();
          }
          if (m.agent) m.agent = { ...m.agent, at: Date.now() };
        }, true);
        return outcome;
      });
    s.steps.set(step.id, step);
    const outcome = await waitOn(step, args.wait ?? 20);
    return outcome ? answer(s, step, outcome, args.show ?? true, ctx) : running(s, step);
  },
});
