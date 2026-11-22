import "server-only";
import { z } from "zod";
import pkg from "../../../package.json";
import { probe } from "@/lib/motion/ffmpeg";
import { urlToPath } from "@/lib/server/media";
import { getSettings } from "@/lib/server/settings";
import { liveGpus } from "@/lib/server/setup/live";
import { fail } from "./errors";
import { GUIDE_ABOUT, GUIDE_TOPICS, TOPICS } from "./guide";
import { cancelJob, jobById, jobView, recentJobs, type JobView } from "./jobs";
import { agentMachines } from "./machines";
import { frameOf, frameSheet, sheet, small, tokensOf, type Shown } from "./pictures";
import { crackioQueue } from "./plan";
import { answerJob, existing, region, showArg, tool } from "./shared";

/** The tools every session uses: where things stand, the manual, waiting on jobs, and looking at files. */

export const status = tool({
  name: "status",
  title: "Crackio status",
  description: "Start here. Crackio's version, the machines (GPU, online, busy, price), balances, keys, what agents may spend, and the queue.",
  input: z.object({}),
  readOnly: true,
  async run(_args, ctx) {
    const [{ machines, snap }, live, settings] = await Promise.all([agentMachines(), liveGpus().catch(() => []), getSettings()]);
    const queue = crackioQueue();
    const busy = new Map(live.map((l) => [l.machine, l]));
    const runpodEmpty = (snap.credit.find((c) => c.provider === "runpod")?.balance ?? 1) <= 0;
    return {
      data: {
        crackio: pkg.version,
        agents: { spend: ctx.prefs.spend === "free" ? "free machines and models only" : ctx.prefs.spend === "all" ? "paid allowed without asking: the user switched confirmations off" : "paid allowed, each job after the user agrees to its price", see_pictures: ctx.prefs.seePictures },
        run_on: settings.runOn ?? "auto",
        machines: machines.map((m) => {
          const l = busy.get(m.id);
          return {
            ...m,
            ...(m.online ? { busy: Boolean(l?.working), ...(l?.running ? { running: l.running } : {}), ...(l?.queue ? { queue: l.queue } : {}) } : {}),
            ...(m.online && runpodEmpty && /RunPod/.test(m.where) ? { note: "RunPod's balance is used up: jobs there fail until the user tops it up." } : {}),
          };
        }),
        queue: { running: queue.running, waiting: queue.queued },
        balances: snap.credit.map((c) => ({ account: c.provider === "vast" ? "vast.ai" : "RunPod", dollars: Math.round(c.balance * 100) / 100, ...(c.perHour ? { spending_per_hour: Math.round(c.perHour * 100) / 100 } : {}), ...(c.hoursLeft != null ? { hours_left: Math.round(c.hoursLeft * 10) / 10 } : {}) })),
        keys: Object.fromEntries(Object.entries(snap.keys).map(([k, v]) => [k, v ? "set" : "missing"])),
        setups_running: snap.jobs.filter((j) => j.state === "running" || j.state === "queued").map((j) => ({ machine: j.machineLabel, tools: j.kits })),
      },
    };
  },
});

export const guide = tool({
  name: "guide",
  title: "Crackio guide",
  description: 'The manual, one short topic at a time. Read "start" once before making anything.',
  input: z.object({ topic: z.enum(GUIDE_TOPICS).optional().describe("Which part. Leave out for the list.") }),
  readOnly: true,
  async run({ topic }) {
    if (!topic) return { data: { topics: GUIDE_ABOUT, read_first: "start" } };
    return { data: TOPICS[topic] };
  },
});

export const wait = tool({
  name: "wait",
  title: "Wait for jobs",
  description: "Wait for jobs to finish and get their results with a preview. Returns progress if they're still running: call it again.",
  input: z.object({
    jobs: z.array(z.string().max(40)).min(1).max(8).describe("Job ids."),
    seconds: z.number().min(0).max(50).optional().describe("How long to wait (default 25). 0: just look at them now."),
    show: showArg,
  }),
  readOnly: true,
  async run({ jobs, seconds = 25, show = true }, ctx) {
    jobs.forEach(jobById);
    return answerJob(jobs, seconds, show, ctx);
  },
});

export const jobs = tool({
  name: "jobs",
  title: "Jobs",
  description: "List the jobs agents started (running first), or cancel one of them. Jobs the user started can't be cancelled.",
  input: z.object({
    cancel: z.string().max(40).optional().describe("A job id to cancel."),
    running_only: z.boolean().optional().describe("true: only jobs still waiting or running."),
  }),
  async run({ cancel, running_only }) {
    if (cancel) return { data: { cancelled: cancelJob(cancel) } };
    const list = recentJobs(20, Boolean(running_only)).map((g) => {
      const v: JobView & { prompt?: string } = jobView(g);
      // Enough to tell jobs apart; the results come from wait.
      delete v.results;
      delete v.prompt_sent;
      return { ...v, prompt: g.prompt.slice(0, 80) };
    });
    return { data: { jobs: list, queue: crackioQueue().queued } };
  },
});

const EDGES = { small: 512, medium: 768, large: 1280, full: 1568 } as const;

export const look = tool({
  name: "look",
  title: "Look at files",
  description: "See pictures or a clip as small previews: one picture, several as one numbered sheet, a clip as a sheet of frames, one frame, or a crop.",
  input: z.object({
    files: z.array(z.string().max(600)).min(1).max(16).optional().describe("File paths. Several pictures come as one sheet, numbered in this order."),
    jobs: z.array(z.string().max(40)).min(1).max(8).optional().describe("Or job ids: their results."),
    size: z.enum(["small", "medium", "large", "full"]).optional().describe("Long side: 512, 768 (default), 1280 or 1568 px. Bigger costs more tokens."),
    crop: region.optional().describe("Only this part of one picture or frame: x, y, w, h as fractions (0–1) from the top-left."),
    at: z.number().min(0).optional().describe("A clip: the one frame at this second, instead of a sheet."),
    rate: z.number().min(0.5).max(4).optional().describe("A clip's sheet: frames per second (default 1; at most 16 tiles)."),
    from: z.number().min(0).optional().describe("A clip's sheet: start second."),
    to: z.number().min(0).optional().describe("A clip's sheet: end second."),
  }),
  files: ["files.*"],
  readOnly: true,
  async run(args, ctx) {
    const targets: { url: string; path: string; kind: string; job?: string }[] = [];
    for (const [i, f] of (args.files ?? []).entries()) {
      const e = await existing(f, `files.${i}`, ctx.viaProgram);
      targets.push({ url: e.url, path: e.path, kind: e.info.kind });
    }
    for (const id of args.jobs ?? []) {
      const g = jobById(id);
      if (g.status !== "done") throw fail("invalid_input", { field: "jobs", what: `Job ${id} has no results yet (it's ${jobView(g).status}).`, do: "Call wait for it first." });
      for (const o of g.outputs) {
        const p = urlToPath(o.url);
        if (p) targets.push({ url: o.url, path: p, kind: o.kind, job: id });
      }
    }
    if (!targets.length) throw fail("invalid_input", { field: "files", what: "Nothing to look at: pass files or jobs." });
    if (!ctx.prefs.seePictures) {
      return { data: { files: targets.map((t) => t.url), notes: ["The user keeps pictures from agents: you can't look. Give the user these file paths instead."] } };
    }
    const edge = EDGES[args.size ?? "medium"];
    const pictures = targets.filter((t) => t.kind === "image");
    const clips = targets.filter((t) => t.kind === "video");
    const other = targets.filter((t) => t.kind !== "image" && t.kind !== "video");
    const images: Shown[] = [];
    const seen: Record<string, unknown>[] = [];
    if (args.crop && pictures.length + clips.length !== 1) throw fail("invalid_input", { field: "crop", what: "A crop is of one picture or one clip frame.", do: "Pass one file with crop." });
    if (pictures.length === 1) {
      const s = await small(pictures[0].path, edge, args.crop);
      images.push({ ...s, label: args.crop ? "The cropped part." : "The picture." });
      seen.push({ file: pictures[0].url, shown: `${s.width}×${s.height}`, ...(args.crop ? { crop: args.crop } : {}) });
    } else if (pictures.length > 1) {
      const s = await sheet(pictures.map((p, i) => ({ file: p.path, label: String(i + 1) })), { edge: Math.max(edge, 1024) });
      images.push({ ...s, label: `Pictures 1–${pictures.length}, numbered in the order listed.` });
      seen.push(...pictures.map((p, i) => ({ n: i + 1, file: p.url })));
    }
    if (args.at != null && !clips.length) throw fail("invalid_input", { field: "at", what: '"at" picks one frame of a clip; these are pictures.', do: "Leave it out." });
    if (args.crop && clips.length && args.at == null) throw fail("invalid_input", { field: "crop", what: "A crop of a clip is of one frame.", do: 'Pass "at" with the second to crop.' });
    for (const c of clips) {
      const length = Math.round(((await probe(c.path).catch(() => null))?.duration ?? 0) * 100) / 100;
      const past = (field: "at" | "from" | "to", v: number) => fail("invalid_input", { field, what: `"${field}" is ${v} s, but the clip is ${length} s long.`, allowed: [`0 to ${length}`] });
      if (args.at != null) {
        if (args.at > length) throw past("at", args.at);
        const s = await frameOf(c.path, args.at, edge, args.crop);
        images.push({ ...s, label: `The frame at ${args.at} s${args.crop ? ", cropped" : ""}.` });
        seen.push({ file: c.url, clip_seconds: length, frame_at: args.at, ...(args.crop ? { crop: args.crop } : {}) });
      } else {
        if (args.from != null && args.from >= length) throw past("from", args.from);
        if (args.to != null && args.to > length + 0.05) throw past("to", args.to);
        if (args.from != null && args.to != null && args.to <= args.from) throw fail("invalid_input", { field: "to", what: '"to" has to be later than "from".' });
        const s = await frameSheet(c.path, { rate: args.rate, from: args.from, to: args.to, edge: Math.max(edge, 1024) });
        images.push({ ...s, label: `Frames at ${s.rate} a second, the time on each.` });
        seen.push({ file: c.url, seconds: s.duration, frames_at: s.times, rate: s.rate });
      }
    }
    for (const o of other) {
      const info = await probe(o.path).catch(() => null);
      seen.push({ file: o.url, kind: o.kind, ...(info?.duration ? { seconds: Math.round(info.duration * 10) / 10 } : {}), note: "Nothing to look at: sound has no picture." });
    }
    return { data: { looked_at: seen, preview_tokens: images.reduce((n, s) => n + tokensOf(s), 0) }, images };
  },
});
