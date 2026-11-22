import { z } from "zod";
import { SETTING_KEYS } from "@/lib/train/plan";

/**
 * One LoRA: GET is the job as it stands, with its log lines after `?from=`; PATCH changes what it's called, what it
 * teaches, its model, machine, settings, test prompts and captions (while nothing runs); DELETE removes it, with what it
 * left on its machine (`?lora=1`: the trained LoRA too).
 */
export async function GET(request: Request, ctx: RouteContext<"/api/train/[id]">) {
  const { id } = await ctx.params;
  const [{ getJob, logSince }, { isLive, reattach }] = await Promise.all([import("@/lib/server/train/store"), import("@/lib/server/train/run")]);
  const job = await getJob(id);
  if (!job) return Response.json({ error: "No such LoRA." }, { status: 404 });
  await reattach();
  const from = Number(new URL(request.url).searchParams.get("from")) || 0;
  return Response.json({ job, log: await logSince(id, from), live: isLive(id) }, { headers: { "Cache-Control": "no-store" } });
}

const Settings = z
  .object({
    steps: z.number().int().min(50).max(20000),
    rank: z.number().int().min(1).max(256),
    lr: z.number().min(1e-7).max(1e-2),
    resolution: z.number().int().min(256).max(2048),
    checkpoints: z.number().int().min(1).max(20),
    previews: z.boolean(),
    captions: z.enum(["auto", "trigger"]),
    captionDropout: z.number().min(0).max(50),
    offload: z.boolean(),
    seed: z.number().int().min(0).max(2 ** 31),
  })
  .partial();

const Base = z.union([
  z.object({ kind: z.literal("catalog"), family: z.string().min(1).max(60) }),
  z.object({ kind: z.literal("custom"), family: z.string().min(1).max(60), folder: z.enum(["diffusion_models", "checkpoints"]), file: z.string().min(1).max(300) }),
]);

const Patch = z.object({
  name: z.string().min(1).max(60).optional(),
  goal: z.enum(["person", "character", "object", "style", "edit"]).optional(),
  trigger: z.string().max(40).optional(),
  noun: z.string().max(40).optional(),
  /** An edit LoRA's change in words. */
  instruction: z.string().max(400).optional(),
  base: Base.nullable().optional(),
  machine: z.string().max(120).nullable().optional(),
  settings: Settings.optional(),
  /** Settings handed back to Crackio. */
  auto: z.array(z.enum(SETTING_KEYS as [string, ...string[]])).optional(),
  testPrompts: z.array(z.string().max(400)).max(4).optional(),
  captions: z.array(z.object({ id: z.string().max(20), caption: z.string().max(1000) })).max(400).optional(),
  /** Leave a picture out, or take it back in. */
  skip: z.array(z.object({ id: z.string().max(20), skip: z.boolean() })).max(400).optional(),
});

export async function PATCH(request: Request, ctx: RouteContext<"/api/train/[id]">) {
  const { id } = await ctx.params;
  const parsed = Patch.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid request" }, { status: 400 });
  const { getJob, touch } = await import("@/lib/server/train/store");
  const { isActive } = await import("@/lib/train/types");
  const job = await getJob(id);
  if (!job) return Response.json({ error: "No such LoRA." }, { status: 404 });
  const p = parsed.data;
  const running = isActive(job.state);
  // A name can change any time; the rest only while nothing runs (a paused run keeps its model and LoRA size).
  if (p.name !== undefined) job.name = p.name.trim() || job.name;
  const rest = Object.keys(p).filter((k) => k !== "name");
  if (rest.length && running) return Response.json({ error: "Pause it first." }, { status: 409 });
  const started = job.progress.step > 0 || job.state === "done";
  if (p.goal !== undefined && p.goal !== job.goal) {
    job.goal = p.goal;
    const { profileById } = await import("@/lib/train/profiles");
    const profile = profileById(job.base?.family);
    // An edit is learned by a model that takes a picture to change, and an edit model learns nothing else: a model that
    // doesn't go with the new goal is let go (the page then picks the first that does).
    if (!started && profile && job.base?.kind === "catalog" && (p.goal === "edit" ? !profile.edit : profile.editOnly)) job.base = null;
    // (A before picture still waiting for its after picture stays one: left out of any other goal, which would learn
    // from it what it was meant to change, and a waiting before picture again when the goal comes back to an edit.)
  }
  if (p.trigger !== undefined) job.trigger = p.trigger.replace(/[^\p{L}\p{N}_-]+/gu, "").slice(0, 40);
  if (p.noun !== undefined) job.noun = p.noun.replace(/\s+/g, " ").trim();
  if (p.instruction !== undefined) job.instruction = p.instruction.replace(/\s+/g, " ").trim();
  if (p.base !== undefined && !started) job.base = p.base as typeof job.base;
  if (p.machine !== undefined && !started) job.machine = p.machine;
  if (p.settings) {
    for (const [key, value] of Object.entries(p.settings)) {
      if (value === undefined) continue;
      if (started && (key === "rank" || key === "resolution")) continue;
      (job.settings as Record<string, unknown>)[key] = value;
      job.auto = job.auto.filter((k) => k !== key);
    }
  }
  if (p.auto && !started) for (const key of p.auto) if (!job.auto.includes(key as (typeof job.auto)[number])) job.auto.push(key as (typeof job.auto)[number]);
  if (p.testPrompts) job.testPrompts = p.testPrompts.map((t) => t.trim()).filter(Boolean);
  for (const c of p.captions ?? []) {
    const image = job.images.find((i) => i.id === c.id);
    if (!image) continue;
    const text = c.caption.replace(/\s+/g, " ").trim();
    if (text) Object.assign(image, { caption: text, captionBy: "you" });
    else {
      delete image.caption;
      delete image.captionBy;
    }
  }
  for (const s of p.skip ?? []) {
    const image = job.images.find((i) => i.id === s.id);
    if (!image) continue;
    if (s.skip) image.skip = "Left out by you";
    else {
      delete image.skip;
      // Taken in after all, away from an edit: a waiting before picture becomes a picture like the others.
      if (job.goal !== "edit") delete image.waiting;
    }
  }
  await touch(job, true);
  return Response.json({ job });
}

export async function DELETE(request: Request, ctx: RouteContext<"/api/train/[id]">) {
  const { id } = await ctx.params;
  const [{ getJob, deleteJob }, { cleanMachine, isLive }] = await Promise.all([import("@/lib/server/train/store"), import("@/lib/server/train/run")]);
  const job = await getJob(id);
  if (!job) return Response.json({ error: "No such LoRA." }, { status: 404 });
  if (isLive(id)) return Response.json({ error: "Pause it first." }, { status: 409 });
  const alsoLora = new URL(request.url).searchParams.get("lora") === "1";
  // What it left on its machine goes too, when the machine answers (else it stays there until it's cleared by hand).
  const cleaned = await cleanMachine(job, alsoLora).catch(() => false);
  if (alsoLora) await import("@/lib/server/loras").then((m) => m.forgetTrained(id)).catch(() => undefined);
  // Kept: Crackio's copy of the LoRA leaves the project's folder before that goes.
  else if (job.result) {
    const { jobPath } = await import("@/lib/server/train/store");
    await import("@/lib/server/lora-home").then((m) => m.keepTrained(job.result!.file, job.result!.kept ? jobPath(id, "lora", job.result!.file) : null)).catch(() => undefined);
  }
  if (job.state !== "done" && job.state !== "error" && job.state !== "paused") job.state = "draft";
  await deleteJob(id);
  return Response.json({ deleted: true, cleaned });
}
