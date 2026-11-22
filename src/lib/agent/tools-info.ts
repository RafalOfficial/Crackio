import "server-only";
import { createHmac } from "node:crypto";
import { z } from "zod";
import { DELETE as deleteTakeRoute } from "@/app/api/generations/[id]/route";
import type { Generation } from "@/lib/generations/types";
import { takesLoras } from "@/lib/local/loras";
import { durationTicks } from "@/lib/models/caps";
import { INTERNAL_TEXT, type ModelAvailability } from "@/lib/models/catalog";
import { noteFor } from "@/lib/models/notes";
import { listModels } from "@/lib/models/resolve";
import { getGeneration, listGenerations } from "@/lib/server/db";
import { listPlacements, listProjects } from "@/lib/server/library";
import { allLocalModels } from "@/lib/server/local-templates";
import { loraLibrary } from "@/lib/server/loras";
import { loraTrained, loraWarnings, NOTES_MAX, setLoraNotes, type LoraTrained } from "@/lib/server/lora-notes";
import { getSettings } from "@/lib/server/settings";
import { ASPECTS } from "@/lib/shot";
import { fail } from "./errors";
import { madeByAgent } from "./jobs";
import { agentMachines, loraFilesOnMachines } from "./machines";
import { chooseModel, nearest, planJob } from "./plan";
import { agentSecret } from "./prefs";
import { aspectNear, confirm, existing, fileArg, SIZES, tool, type ToolContext } from "./shared";

/** What there is to work with: the models, their LoRAs, a file's facts, and what's in the Library. */

const KINDS = ["image", "video", "upscale"] as const;

function modelRow(m: ModelAvailability, defaults: Record<string, string | undefined>, loraModels: Set<string>) {
  const local = m.id.startsWith("local:");
  const caps = m.caps ?? null;
  const note = noteFor(m.id);
  const lengths = caps?.duration ? durationTicks(caps.duration) : null;
  const sizes = local && m.kind === "image" ? [...SIZES] : (caps?.resolution?.choices ?? []).map((c) => String(c.value));
  const shapes = (caps?.aspect?.choices ?? caps?.size?.presets ?? []).filter((s) => s.ratio !== null).map((s) => s.label);
  return {
    id: m.id,
    name: m.name,
    best_for: m.bestFor,
    free: local,
    ...(defaults[m.kind] === m.id ? { users_default: true } : {}),
    ...(note?.quality ? { quality: note.quality } : {}),
    ...(m.kind !== "upscale" ? { references: m.kind === "video" ? (caps?.refs?.max ?? 0) : m.maxRefs } : {}),
    ...(sizes.length ? { sizes } : {}),
    ...(m.kind === "image" ? { shapes: local || !shapes.length ? ASPECTS.map((a) => a.id) : [...new Set(shapes)] } : shapes.length ? { shapes: [...new Set(shapes)] } : {}),
    ...(lengths?.seconds.length ? { seconds: lengths.seconds.length > 8 ? `${lengths.min}–${lengths.max}` : lengths.seconds } : {}),
    ...(m.kind === "video" ? { first_frame: Boolean(caps?.image || caps?.keyframes || !caps), last_frame: Boolean(caps?.end || caps?.keyframes), sound: Boolean(caps?.audio) } : {}),
    ...(local && m.kind !== "upscale" ? { loras: loraModels.has(m.id) } : {}),
    // Its time on the fastest machine that has it: a 1K picture, a 5 s clip, or a 1 MP picture upscaled 2×.
    ...(m.localTime ? { typical_seconds: Math.round(m.localTime.seconds), on: m.localTime.gpu } : {}),
  };
}

export const models = tool({
  name: "models",
  title: "Models",
  description: "The models that can run now for a kind of job: what each is best for, sizes, shapes, clip lengths, references, first and last frame, sound, LoRAs, typical time, and whether it's free.",
  input: z.object({
    kind: z.enum(KINDS).describe("What to make."),
    all: z.boolean().optional().describe("true: also list models that can't run now, with why."),
  }),
  readOnly: true,
  async run({ kind, all }, ctx) {
    const [list, settings] = await Promise.all([listModels(), getSettings()]);
    const loraModels = new Set(allLocalModels().filter((m) => m.crackio && takesLoras(m)).map((m) => m.crackio!));
    const ofKind = list.filter((m) => m.kind === kind && !INTERNAL_TEXT.has(m.id));
    const usable = (m: ModelAvailability) => m.available && (ctx.prefs.spend !== "free" || m.id.startsWith("local:"));
    // Free ones (the user's own GPUs) first: they're what an agent should reach for.
    const now = ofKind
      .filter(usable)
      .sort((a, b) => Number(!a.id.startsWith("local:")) - Number(!b.id.startsWith("local:")))
      .map((m) => modelRow(m, settings.models, loraModels));
    const paidOnly = ofKind.filter((m) => m.available && !usable(m)).map((m) => m.id);
    const cant = ofKind.filter((m) => !m.available).map((m) => ({ id: m.id, name: m.name, why: m.id.startsWith("local:") && /^Connect /.test(m.reason ?? "") ? "no machine is online" : (m.reason ?? "can't run now") }));
    return {
      data: {
        can_run_now: now,
        ...(now.length ? {} : { note: "Nothing free can run now. Call status: the user's machines may be off." }),
        ...(paidOnly.length ? { paid_and_not_allowed: paidOnly } : {}),
        ...(all ? { cant_run_now: cant } : cant.length ? { more: `${cant.length} more can't run now (all: true lists them with why).` } : {}),
      },
    };
  },
});

/**
 * One LoRA: what the next agent needs to prompt it. Its notes (written by the user, or by an agent after testing), and
 * for one trained here what Train knows by itself: three real captions, the model, steps, size and the version kept.
 */
async function loraDetail(asked: string, note: string | undefined, ctx: ToolContext) {
  const library = await loraLibrary();
  const names = Object.keys(library.records);
  const file = [asked, `${asked}.safetensors`].find((f) => library.records[f]) ?? names.find((f) => f.toLowerCase() === asked.toLowerCase());
  let record = file ? library.records[file] : undefined;
  if (!record) {
    throw fail("file_not_found", { field: "file", what: `Crackio has no record of a LoRA file "${asked.slice(0, 120)}".`, did_you_mean: nearest(asked.replace(/\.safetensors$/, ""), names.map((id) => ({ id }))), do: "Use a file name from loras (with a model)." });
  }
  if (note !== undefined) record = (await setLoraNotes(record.file, note, `an agent (${ctx.caller.client})`)) ?? record;
  const { warnings, ...trained } = (await loraTrained(record).catch(() => null)) ?? ({} as Partial<LoraTrained>);
  const models = record.models.map((id) => allLocalModels().find((m) => m.id === id)?.crackio).filter(Boolean);
  return {
    data: {
      file: record.file,
      name: record.name,
      // First, what went wrong in its training: it explains a LoRA that misbehaves better than any prompt change.
      ...(warnings?.length ? { warnings, tell_user: "Tell the user about these before you spend time on prompts." } : {}),
      models,
      ...(record.trigger ? { trigger: record.trigger, ...(record.triggerAt === "end" ? { trigger_at_end: true } : {}) } : {}),
      strength: record.strength,
      range: record.range,
      ...(note !== undefined ? { saved: true } : {}),
      notes: record.notes ? { text: record.notes.text, written_by: record.notes.by, on: record.notes.at.slice(0, 10) } : null,
      ...(trained.name ? { trained } : {}),
      ...(record.notes ? {} : { tip: `No notes yet. ${trained.captions?.samples.length ? "Prompt it in the words and shape of its captions. " : ""}Once you've tested it, write what you learned with note, for the next agent.` }),
    },
  };
}

export const loras = tool({
  name: "loras",
  title: "LoRAs",
  description: "The LoRAs installed for a model: file name, what it does, trigger words (Crackio adds them), default strength and range, and the machines that hold each. With file: one LoRA's notes on how to prompt it and what it was trained on; note writes them.",
  input: z.object({
    model: z.string().max(300).optional().describe("A model id from models (own-GPU models only): lists its LoRAs."),
    all: z.boolean().optional().describe("true: also Crackio's picks for it that aren't installed."),
    file: z.string().max(220).optional().describe("One LoRA's file name: how to prompt it (notes) and, for one trained here, its real captions and settings."),
    note: z.string().max(NOTES_MAX).optional().describe("With file: writes its notes. It replaces them, so read first and send the whole text: the words that work, strength, quirks, sizes."),
  }),
  async run({ model, all, file, note }, ctx) {
    if (file) return loraDetail(file, note, ctx);
    if (!model) throw fail("invalid_input", { field: "model", what: 'Pass "model" to list its LoRAs, or "file" for one LoRA\'s notes.' });
    // A client that connected before "file" existed can only send "model": a LoRA's file name there is taken as the file.
    if (/\.safetensors$/i.test(model.trim())) return loraDetail(model.trim(), note, ctx);
    const local = allLocalModels().find((m) => m.crackio === model || m.id === model);
    if (!local) {
      const options = allLocalModels().filter((m) => m.crackio && takesLoras(m)).map((m) => ({ id: m.crackio!, name: m.name }));
      throw fail(model.startsWith("comfy:") ? "option_not_supported" : "model_not_found", { field: "model", what: model.startsWith("comfy:") ? "Hosted models take no LoRAs." : `No own-GPU model "${model.slice(0, 80)}".`, did_you_mean: nearest(model, options) });
    }
    if (!takesLoras(local)) throw fail("option_not_supported", { field: "model", what: `${local.name} takes no LoRAs.` });
    const [library, onMachines] = await Promise.all([loraLibrary(), loraFilesOnMachines()]);
    type Row = { file: string; name: string; does?: string; trigger?: string; trigger_at_end?: true; strength: number; range: [number, number]; on?: string[] };
    const rows = new Map<string, Row>();
    for (const e of library.entries) {
      if (!e.models.includes(local.id)) continue;
      for (const file of e.local ?? []) rows.set(file, { file, name: e.name, does: e.blurb, ...(e.trigger ? { trigger: e.trigger } : {}), ...(e.triggerAt === "end" ? { trigger_at_end: true as const } : {}), strength: e.strength, range: e.range });
    }
    // What was downloaded, trained or uploaded for it beyond the picks.
    for (const r of Object.values(library.records)) {
      if (!r.models.includes(local.id) || rows.has(r.file)) continue;
      rows.set(r.file, { file: r.file, name: r.name, ...(r.trigger ? { trigger: r.trigger } : {}), ...(r.triggerAt === "end" ? { trigger_at_end: true as const } : {}), strength: r.strength, range: r.range });
    }
    const { machines } = await agentMachines().catch(() => ({ machines: [] }));
    const mayUse = (id: string) => ctx.prefs.spend !== "free" || !(machines.find((m) => m.id === id)?.paid ?? id === "comfy-cloud");
    // The user's own (uploaded or trained here) are kept on this computer: a job sends the file to its machine, so they
    // count as usable even with every machine that holds them off.
    const { homeCopy } = await import("@/lib/server/lora-home");
    const kept = new Set<string>();
    await Promise.all([...rows.values()].map(async (r) => void ((await homeCopy(r.file).catch(() => null)) && kept.add(r.file))));
    // What went wrong in the training of the ones made here ("Trained WITHOUT captions"), said on the row itself.
    const warned = new Map<string, string>();
    await Promise.all(
      [...rows.values()].map(async (r) => {
        const rec = library.records[r.file];
        const first = rec?.trained ? (await loraWarnings(rec).catch(() => []))[0] : undefined;
        if (first) warned.set(r.file, first.split(": ")[0]);
      }),
    );
    const installed = [...rows.values()]
      .filter((r) => onMachines.has(r.file) || kept.has(r.file))
      .map((r) => {
        const on = onMachines.get(r.file) ?? [];
        const rec = library.records[r.file];
        return {
          ...r,
          on,
          ...(kept.has(r.file) ? { sent_when_used: true } : on.some(mayUse) ? {} : { paid_only: true }),
          ...(rec?.notes ? { notes: true } : {}),
          ...(rec?.trained ? { trained_here: true } : {}),
          ...(warned.has(r.file) ? { warning: warned.get(r.file) } : {}),
        };
      });
    const off = machines.filter((m) => !m.online).map((m) => m.name);
    const rest = [...rows.values()].filter((r) => !onMachines.has(r.file) && !kept.has(r.file));
    return {
      data: {
        model: local.crackio ?? local.id,
        installed,
        ...(installed.length ? {} : { note: "None on a machine that's online. The user installs LoRAs in Crackio → Settings → LoRAs." }),
        ...(installed.some((r) => "sent_when_used" in r) ? { sent_note: "sent_when_used: the user's own LoRA, kept on their computer. A job sends it to the machine it runs on, once." } : {}),
        ...(installed.some((r) => "paid_only" in r) ? { paid_note: "paid_only: the file is only on machines that cost money, which the user doesn't allow agents." } : {}),
        ...(installed.some((r) => "notes" in r || "trained_here" in r) ? { notes_note: 'notes / trained_here: call loras with that file before you use it. It says how to prompt it. (No "file" option on your loras? Pass the file name as "model".)' } : {}),
        // A machine that's off can't be asked what it holds: a LoRA missing here may be on one of these.
        ...(off.length ? { not_read: `${off.join(", ")} ${off.length === 1 ? "is" : "are"} off, so ${off.length === 1 ? "its" : "their"} LoRAs aren't listed. Don't tell the user a LoRA doesn't exist: it may be there.` } : {}),
        ...(all ? { not_installed: rest.slice(0, 40).map(({ name, does, file }) => ({ name, does, file })) } : rest.length ? { more: `${rest.length} more for this model aren't installed (all: true lists them).` } : {}),
      },
    };
  },
});

/* ------------------------------------------------------------------ files */

/** One use's wait and cost, or why it can't run now. Never throws: a file's facts shouldn't fail on an estimate. */
async function estimate(use: string, run: () => Promise<{ seconds: number | null; cost: string; model: string }>) {
  try {
    const p = await run();
    return { use, model: p.model, ...(p.seconds != null ? { seconds: p.seconds } : {}), cost: p.cost };
  } catch (err) {
    const f = (err as { failure?: { what?: string } }).failure;
    return { use, unavailable: f?.what ?? "can't be estimated now" };
  }
}

export const addFile = tool({
  name: "add_file",
  title: "Add a file",
  description: "Give Crackio a picture, clip or sound file (a local path or a link). Returns what it is, what it can be used for, and the wait and cost of the usual next steps.",
  input: z.object({ file: fileArg("A local path or a link.") }),
  files: ["file"],
  async run({ file }, ctx) {
    const f = await existing(file, "file", ctx.viaProgram);
    const i = f.info;
    const facts = {
      file: f.url,
      kind: i.kind === "image" ? "picture" : i.kind === "video" ? "clip" : i.kind === "audio" ? "sound" : i.kind,
      ...(i.width && i.height ? { width: i.width, height: i.height, shape: aspectNear(i.width / i.height) } : {}),
      ...(i.duration ? { seconds: Math.round(i.duration * 100) / 100 } : {}),
      ...(i.fps ? { fps: Math.round(i.fps * 100) / 100 } : {}),
      ...(i.kind === "video" ? { has_sound: Boolean(i.audio) } : {}),
      mb: i.bytes < 1e6 ? Math.round(i.bytes / 1e4) / 100 : Math.round(i.bytes / 1e5) / 10,
    };
    const plan = async (kind: "image" | "video" | "upscale", ask: Parameters<typeof planJob>[1]) => {
      const m = await chooseModel(kind, undefined, ctx.prefs);
      const p = await planJob(m, ask, ctx.prefs);
      return { seconds: p.seconds, cost: p.cost.free ? "free" : p.cost.text, model: m.name };
    };
    if (i.kind === "image" && i.width && i.height) {
      const shape = aspectNear(i.width / i.height);
      const ratio = i.width / i.height;
      return {
        data: {
          ...facts,
          use_for: ["a reference or the picture to edit in make_image", "the first or last frame in make_video", "retouch, relight, angles, upscale", "a Director place (director open)", "a Cast member's photo (cast)", "a product photo (product)"],
          estimates: await Promise.all([
            estimate("edit it or use it as a reference (make_image, 1k)", () => plan("image", { kind: "image", aspect: shape, count: 1, references: 1, resolution: "1k", ratio })),
            estimate("animate it for 5 s (make_video)", () => plan("video", { kind: "video", aspect: shape, count: 1, references: 1, duration: 5, ratio, start: true })),
            estimate("upscale it 2×", () => plan("upscale", { kind: "upscale", aspect: shape, count: 1, references: 1, ratio, source: { width: i.width!, height: i.height! }, scale: 2 })),
          ]),
        },
      };
    }
    if (i.kind === "video") return { data: { ...facts, use_for: ["swap (replace a person or thing in it)", "upscale", "look (its frames)"] } };
    if (i.kind === "audio") return { data: { ...facts, use_for: [], note: "No agent tool takes a sound file yet." } };
    return { data: { ...facts, use_for: [] } };
  },
});

/* ------------------------------------------------------------------ Library */

const LIBRARY_TOOLS = ["image", "video", "director", "retouch", "relight", "angles", "upscale", "swap", "product", "voice", "cast", "templates", "storyboard", "lipsync"] as const;

const when = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");

function takeRow(g: Generation, projects: Map<string, string>) {
  return {
    job: g.id,
    tool: g.tool,
    made: when(g.createdAt),
    by: madeByAgent(g) ? String((g.params!.agent as { client?: unknown }).client ?? "agent") : "the user",
    ...(g.prompt ? { prompt: g.prompt.slice(0, 100) } : {}),
    ...(g.modelName ? { model: g.modelName } : {}),
    files: g.outputs.map((o) => o.url),
    ...(projects.has(g.id) ? { project: projects.get(g.id) } : {}),
    open: `{{crackio}}/library?view=${g.id}:0`,
  };
}

const deleteToken = (ids: string[]) => createHmac("sha256", agentSecret()).update(JSON.stringify(["delete-takes", [...ids].sort()])).digest("hex").slice(0, 10);

export const library = tool({
  name: "library",
  title: "Library",
  description: "The finished takes in the user's Library, newest first: file paths, who made them, a link that opens each in Crackio. Can delete takes an agent made (needs a confirm).",
  input: z.object({
    tool: z.enum(LIBRARY_TOOLS).optional().describe("Only one tool's takes."),
    mine: z.boolean().optional().describe("true: only takes agents made."),
    limit: z.number().int().min(1).max(40).optional().describe("How many (default 12)."),
    before: z.string().max(40).optional().describe("A job id: list the takes older than it."),
    delete: z.array(z.string().max(40)).min(1).max(20).optional().describe("Job ids of agent-made takes to delete for good."),
    confirm,
  }),
  destructive: true,
  async run(args, ctx: ToolContext) {
    void ctx;
    if (args.delete) {
      const gens = args.delete.map((id) => {
        const g = getGeneration(id);
        if (!g) throw fail("job_not_found", { what: `There's no take "${id.slice(0, 40)}".` });
        if (!madeByAgent(g)) throw fail("not_yours", { what: `Take ${id} was made by the user, not by an agent: agents never delete those.` });
        return g;
      });
      const token = deleteToken(args.delete);
      if (args.confirm !== token) {
        throw fail("confirm_needed", { what: `Deleting ${gens.length === 1 ? "this take" : `these ${gens.length} takes`} removes the files for good.`, confirm: token });
      }
      for (const g of gens) await deleteTakeRoute(new Request(`http://crackio.internal/api/generations/${g.id}`, { method: "DELETE" }), { params: Promise.resolve({ id: g.id }) });
      return { data: { deleted: gens.map((g) => g.id) } };
    }
    const limit = args.limit ?? 12;
    // Swap's takes are kept under its first name.
    const only = args.tool === "swap" ? "recast" : args.tool;
    const before = args.before ? getGeneration(args.before)?.createdAt : undefined;
    if (args.before && !before) throw fail("job_not_found", { field: "before", what: `There's no take "${args.before.slice(0, 40)}".` });
    const projectNames = new Map(listProjects().map((p) => [p.id, p.name]));
    const inProject = new Map(listPlacements().map((p) => [p.id, projectNames.get(p.project) ?? p.project]));
    const found: Generation[] = [];
    // Finished ones only, a page of the table at a time until there are enough.
    for (let cursor = before, pages = 0; found.length < limit && pages < 10; pages++) {
      const page = listGenerations({ limit: 200, before: cursor, ...(only ? { tools: [only] } : {}) });
      if (!page.length) break;
      for (const g of page) if (g.status === "done" && g.outputs.length && g.tool !== "showcase" && (!args.mine || madeByAgent(g)) && found.length < limit) found.push(g);
      cursor = page[page.length - 1].createdAt;
    }
    return { data: { takes: found.map((g) => takeRow(g, inProject)), ...(found.length === limit ? { more: `Older ones: pass before: "${found[found.length - 1].id}".` } : {}) } };
  },
});
