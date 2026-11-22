import "server-only";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import SHAPES from "@/lib/local/lora-shapes.json";
import { fitOf, lookAtLora, type LoraHeader, type LoraLook, type LoraShapes } from "@/lib/local/lora-file";
import { takesLoras, type LoraRecord } from "@/lib/local/loras";
import type { LocalModel } from "@/lib/local/types";
import { profileById } from "@/lib/train/profiles";
import { comfyTargets, currentTarget, withTarget, type ComfyTarget } from "./comfy-targets";
import { DATA_DIR } from "./paths";

/**
 * Your own LoRA files, kept on this computer (data/loras): a file you upload on a model's LoRAs page is checked from its
 * header (a real LoRA, named in a way the model's loader reads, its layers the model's), recorded like a downloaded one
 * (server/loras: data/loras.json), and sent from here to whichever machine needs it: when you add it, when you ask, and
 * before a job on a machine that doesn't have it yet (engines/comfy-local `usableLoras`). LoRAs trained on the Train
 * page are sent the same way from their job's folder. So a GPU rented a minute ago draws with your LoRAs at once.
 *
 * To a ComfyUI (this computer's, a rented box's) the file goes through Crackio's helper in pieces (bridge 1.11.0, the
 * route Train added); to a RunPod Serverless endpoint through your R2 bucket, as its other files do.
 */

const HOME = path.join(/*turbopackIgnore: true*/ DATA_DIR, "loras");
const INCOMING = path.join(/*turbopackIgnore: true*/ HOME, ".incoming");
const MAX_BYTES = 8 * 1024 ** 3;
/** Free space kept on the drive after an upload. */
const SPARE = 2 * 1024 ** 3;
const shapes = SHAPES as unknown as LoraShapes;

/** A refusal with words for the person, and the status the route answers with. */
export class LoraRefused extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const FILE = /^[\w.\-+ ()[\]]{1,200}\.safetensors$/i;
const homeFile = (file: string) => path.join(/*turbopackIgnore: true*/ HOME, file);
const exists = (p: string) =>
  fs
    .stat(/*turbopackIgnore: true*/ p)
    .then((s) => (s.isFile() ? s.size : null))
    .catch(() => null);

/* ------------------------------------------------------------------ reading a file */

/** A safetensors file's header, from the bytes it starts with; null when they don't hold all of it. */
function headerIn(bytes: Uint8Array): LoraHeader | null | "bad" {
  if (bytes.length < 9) return "bad";
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size = Number(view.getBigUint64(0, true));
  // A safetensors file starts with its header's length, then JSON.
  if (!Number.isFinite(size) || size < 2 || size > 100 * 1024 ** 2 || bytes[8] !== 0x7b) return "bad";
  if (bytes.length < 8 + size) return null;
  try {
    return JSON.parse(Buffer.from(bytes.buffer, bytes.byteOffset + 8, size).toString("utf8")) as LoraHeader;
  } catch {
    return "bad";
  }
}

async function headerOf(file: string): Promise<LoraHeader | "bad"> {
  const handle = await fs.open(/*turbopackIgnore: true*/ file, "r");
  try {
    const head = Buffer.alloc(9);
    await handle.read(head, 0, 9, 0);
    const size = Number(head.readBigUInt64LE(0));
    if (!Number.isFinite(size) || size < 2 || size > 100 * 1024 ** 2 || head[8] !== 0x7b) return "bad";
    const body = Buffer.alloc(size);
    const { bytesRead } = await handle.read(body, 0, size, 8);
    if (bytesRead < size) return "bad";
    return JSON.parse(body.toString("utf8")) as LoraHeader;
  } catch {
    return "bad";
  } finally {
    await handle.close();
  }
}

/** Models whose ComfyUI loader reads only ComfyUI's and kohya's layer names (server/loras LOADS, seen on a 5090). */
const NATIVE_ONLY = new Set(["flux3-klein"]);

/** Why a file can't be this model's LoRA, in words; null when it can. */
function refusal(look: LoraLook, model: LocalModel): string | null {
  if (!look.layers && !look.textLayers) return "This file isn't a LoRA: it has no LoRA layers in it. A whole model goes in ComfyUI's models folder instead (the Train page shows where).";
  if (NATIVE_ONLY.has(model.id) && look.layers && !look.namings.comfy && !look.namings.kohya) {
    return `This LoRA is saved with diffusers names, which ComfyUI doesn't load for ${model.name}: it would do nothing. Look for a ComfyUI version of it.`;
  }
  return null;
}

type Fit = { fits: boolean; warn?: string };

/** Whether a LoRA's layers are a model's: from Crackio's own trainer's note, else from the layers real LoRAs for it have. */
async function fitFor(look: LoraLook, model: LocalModel): Promise<Fit> {
  const { allLocalModels } = await import("./local-templates");
  const nameOf = (id: string) => allLocalModels().find((m) => m.id === id)?.name ?? id;
  const made = look.family ? profileById(look.family) : null;
  if (made) {
    if (made.uses.includes(model.id)) return { fits: true };
    return { fits: false, warn: `Trained for ${made.uses.map(nameOf).slice(0, 2).join(" and ")}, not ${model.name}: it will most likely change nothing here.` };
  }
  const fit = fitOf(look, shapes, model.id);
  if (fit.verdict === "fits") return { fits: true };
  if (fit.verdict === "other") {
    return { fits: false, warn: `Its layers look like ${nameOf(fit.better[0])}'s, not ${model.name}'s: it will most likely change nothing here.` };
  }
  return { fits: false };
}

/* ------------------------------------------------------------------ uploads */

const GENERIC = /^(pytorch_lora_weights|adapter_model|diffusion_pytorch_model|model|lora|lora_weights|weights|adapter|default)$/i;
const tidy = (s: string) =>
  s
    .replace(/[^A-Za-z0-9_.\-+ ()[\]]+/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^[_.\s]+|[_.\s]+$/g, "")
    .slice(0, 150);

/** A file name's readable form: "my_stage-look_v2" → "My stage look v2". */
const pretty = (stem: string) => {
  const words = stem.replace(/[-_.]+/g, " ").replace(/\s{2,}/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : "My LoRA";
};

async function modelFor(id: string): Promise<LocalModel> {
  const { allLocalModels } = await import("./local-templates");
  const m = allLocalModels().find((x) => x.id === id);
  if (!m || !takesLoras(m) || !m.crackio) throw new LoraRefused("That model takes no LoRAs.", 404);
  return m;
}

export type UploadAnswer = { have: number; done?: true; file?: string; record?: LoraRecord; already?: boolean };

/**
 * One piece of a file being uploaded (`offset` is where it starts; pieces come in order, and a piece sent twice is told
 * how much is already here). The first piece is looked at right away, so a file that isn't a LoRA, or can't work on the
 * model, is refused before the rest travels. The last piece checks the whole file, gives it its name and records it.
 */
export async function receivePiece(input: { id: string; name: string; total: number; offset: number; model: string }, bytes: Uint8Array): Promise<UploadAnswer> {
  const { id, total, offset } = input;
  if (!/^[a-z0-9-]{8,48}$/.test(id)) throw new LoraRefused("Invalid upload.");
  if (!/\.safetensors$/i.test(input.name)) throw new LoraRefused("Crackio takes .safetensors LoRA files only: other formats (.pt, .ckpt, .bin) can run code when they're loaded.");
  if (!Number.isInteger(total) || total < 1024 || total > MAX_BYTES) throw new LoraRefused(total > MAX_BYTES ? "That file is over 8 GB: too big for a LoRA." : "That file is too small to be a LoRA.");
  if (!Number.isInteger(offset) || offset < 0 || offset + bytes.length > total) throw new LoraRefused("That piece doesn't fit the file.");
  const model = await modelFor(input.model);
  const part = path.join(/*turbopackIgnore: true*/ INCOMING, `${id}.part`);
  await fs.mkdir(/*turbopackIgnore: true*/ INCOMING, { recursive: true });

  if (offset === 0) {
    const header = headerIn(bytes);
    if (header === "bad") throw new LoraRefused("That isn't a safetensors file (or it's damaged).");
    if (header) {
      const no = refusal(lookAtLora(header), model);
      if (no) throw new LoraRefused(no, 422);
    }
    // The same file again (its name and size): nothing travels, the model is added to what it's for.
    const same = await sameUpload(input.name, total, bytes);
    if (same) return { have: total, done: true, already: true, file: same.file, record: await alsoFor(same, model) };
    const free = await fs
      .statfs(/*turbopackIgnore: true*/ HOME)
      .then((s) => Number(s.bavail) * Number(s.bsize))
      .catch(() => null);
    if (free !== null && free < total + SPARE) throw new LoraRefused(`This computer's drive has ${(free / 1024 ** 3).toFixed(1)} GB free: not enough to keep this file. Free some space first.`, 507);
    void sweepIncoming();
  }

  const have = offset === 0 ? 0 : ((await exists(part)) ?? 0);
  if (offset !== have) return { have };
  await (offset === 0 ? fs.writeFile(/*turbopackIgnore: true*/ part, bytes) : fs.appendFile(/*turbopackIgnore: true*/ part, bytes));
  const now = have + bytes.length;
  if (now < total) return { have: now };

  try {
    const header = await headerOf(part);
    if (header === "bad") throw new LoraRefused("That isn't a safetensors file (or it's damaged).");
    const look = lookAtLora(header);
    const no = refusal(look, model);
    if (no) throw new LoraRefused(no, 422);
    const sha256 = await hashOf(part);
    const { loraRecords, curated, guessCategory, saveRecord } = await import("./loras");
    const records = await loraRecords();
    // The very same bytes under another name: one copy is enough.
    const twin = Object.values(records).find((r) => r.uploaded && r.sha256 === sha256 && r.bytes === total);
    if (twin && (await exists(homeFile(twin.file))) === total) {
      await fs.rm(/*turbopackIgnore: true*/ part, { force: true });
      return { have: total, done: true, already: true, file: twin.file, record: await alsoFor(twin, model) };
    }
    const taken = new Set([...Object.keys(records), ...curated().flatMap((e) => e.local ?? [])].map((f) => f.toLowerCase()));
    const file = await freeName(input.name, look, taken);
    const fit = await fitFor(look, model);
    const stem = file.replace(/\.safetensors$/i, "");
    const wan = model.id === "tpl-wan2.2-14b-video" ? (/high/i.test(file) ? "high_noise" : /low/i.test(file) ? "low_noise" : null) : null;
    const record: LoraRecord = {
      file,
      entry: `upload:${file}`,
      name: look.name && look.name.length <= 60 ? look.name : pretty(stem),
      repo: "",
      path: file,
      models: [model.id],
      category: guessCategory(`${stem} ${look.name ?? ""}`, model.unit === "clip"),
      ...(look.trigger ? { trigger: look.trigger.slice(0, 160) } : {}),
      strength: 1,
      range: [-1, 2],
      ...(wan ? { match: wan } : {}),
      licence: { name: "Your own file", commercial: model.licence.commercial },
      bytes: total,
      found: true,
      uploaded: new Date().toISOString(),
      sha256,
      ...(fit.fits ? { fits: [model.id] } : {}),
      ...(fit.warn ? { warn: { [model.id]: fit.warn } } : {}),
    };
    await fs.mkdir(/*turbopackIgnore: true*/ HOME, { recursive: true });
    await fs.rename(/*turbopackIgnore: true*/ part, homeFile(file));
    await saveRecord(record);
    return { have: total, done: true, file, record };
  } catch (err) {
    await fs.rm(/*turbopackIgnore: true*/ part, { force: true });
    throw err;
  }
}

/** Uploads left half-way more than a day ago are cleared. */
async function sweepIncoming() {
  const names = await fs.readdir(/*turbopackIgnore: true*/ INCOMING).catch(() => [] as string[]);
  for (const n of names) {
    const p = path.join(/*turbopackIgnore: true*/ INCOMING, n);
    const s = await fs.stat(/*turbopackIgnore: true*/ p).catch(() => null);
    if (s && Date.now() - s.mtimeMs > 24 * 3600_000) await fs.rm(/*turbopackIgnore: true*/ p, { force: true });
  }
}

/** An upload left half-way, given up. */
export async function dropUpload(id: string) {
  if (/^[a-z0-9-]{8,48}$/.test(id)) await fs.rm(/*turbopackIgnore: true*/ path.join(/*turbopackIgnore: true*/ INCOMING, `${id}.part`), { force: true });
}

function hashOf(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(/*turbopackIgnore: true*/ file)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

/** The name an uploaded file gets in models/loras: its own, tidied; one that says nothing takes its trainer's name. */
async function freeName(original: string, look: LoraLook, taken: Set<string>) {
  const base = tidy(original.replace(/\.safetensors$/i, ""));
  const stem = GENERIC.test(base) || base.length < 3 || !/[A-Za-z0-9]{2}/.test(base) ? tidy(look.name ?? "") || "my-lora" : base;
  for (let n = 1; ; n++) {
    const file = `${n === 1 ? stem : `${stem}-${n}`}.safetensors`;
    if (!taken.has(file.toLowerCase()) && (await exists(homeFile(file))) === null) return file;
  }
}

/**
 * An upload already kept here: the same name, the same size and the same bytes as far as the first piece shows (the
 * header and the first weights). A LoRA trained again under its old name has the same layers, so the same size to the
 * byte: by name and size alone the new one was answered "already here" and the old one kept, with nothing said.
 */
async function sameUpload(original: string, bytes: number, first: Uint8Array): Promise<LoraRecord | null> {
  const { loraRecords } = await import("./loras");
  const file = `${tidy(original.replace(/\.safetensors$/i, ""))}.safetensors`.toLowerCase();
  for (const r of Object.values(await loraRecords())) {
    if (!r.uploaded || r.bytes !== bytes || r.file.toLowerCase() !== file || (await exists(homeFile(r.file))) !== bytes) continue;
    const kept = Buffer.alloc(first.length);
    const handle = await fs.open(/*turbopackIgnore: true*/ homeFile(r.file), "r").catch(() => null);
    if (!handle) continue;
    try {
      const { bytesRead } = await handle.read(kept, 0, kept.length, 0);
      if (bytesRead === first.length && kept.equals(Buffer.from(first.buffer, first.byteOffset, first.length))) return r;
    } finally {
      await handle.close();
    }
  }
  return null;
}

/** A kept upload is for one more model: said in its record, with whether its layers are that model's. */
async function alsoFor(record: LoraRecord, model: LocalModel): Promise<LoraRecord> {
  if (record.models.includes(model.id)) return record;
  const header = await headerOf(homeFile(record.file));
  const look = header === "bad" ? null : lookAtLora(header);
  if (look) {
    const no = refusal(look, model);
    if (no) throw new LoraRefused(no, 422);
  }
  const fit = look ? await fitFor(look, model) : { fits: false };
  const { changeRecord } = await import("./loras");
  return (await changeRecord(record.file, (r) => {
    r.models = [...new Set([...r.models, model.id])];
    if (fit.fits) r.fits = [...new Set([...(r.fits ?? []), model.id])];
    if (fit.warn) r.warn = { ...r.warn, [model.id]: fit.warn };
  }))!;
}

/** Your words for an uploaded LoRA: its name, the words it wakes with and where they go, how strong by default. */
export async function editUpload(file: string, patch: { name?: string; trigger?: string; triggerAt?: "start" | "end"; strength?: number }) {
  const { changeRecord } = await import("./loras");
  const out = await changeRecord(file, (r) => {
    if (!r.uploaded) throw new LoraRefused("Only LoRAs you uploaded can be changed here.", 403);
    if (patch.name !== undefined && patch.name.trim()) r.name = patch.name.trim().slice(0, 60);
    if (patch.trigger !== undefined) {
      if (patch.trigger.trim()) r.trigger = patch.trigger.trim().slice(0, 160);
      else delete r.trigger;
    }
    if (patch.triggerAt === "end") r.triggerAt = "end";
    else if (patch.triggerAt === "start") delete r.triggerAt;
    if (patch.strength !== undefined) r.strength = Math.max(r.range[0], Math.min(r.range[1], Math.round(patch.strength * 100) / 100));
  });
  if (!out) throw new LoraRefused("Crackio doesn't know that LoRA.", 404);
  return out;
}

/**
 * An uploaded LoRA gone: Crackio's copy, its record, and the file on every machine that answers now, a RunPod
 * endpoint's volume included (one that's off keeps its copy, which then shows as a file nothing explains).
 */
export async function forgetUpload(file: string) {
  const { loraRecords, dropRecord } = await import("./loras");
  const record = (await loraRecords())[file];
  if (!record?.uploaded) throw new LoraRefused("Only LoRAs you uploaded can be deleted here.", 403);
  const { removeFile, installedFiles } = await import("./local-models");
  await import("@/lib/engines/registry");
  const { forgetLoraFiles } = await import("@/lib/engines/comfy-local");
  for (const t of await comfyTargets()) {
    if (t.metered === "comfy-cloud") continue;
    // A RunPod endpoint deletes with a short paid job: asked only when the file is on its volume.
    if (t.serverless && !(await withTarget(t, () => installedFiles()).catch(() => new Set<string>())).has(`loras/${file}`)) continue;
    await removeFile("loras", file, t.id).catch(() => undefined);
    await withTarget(t, async () => forgetLoraFiles());
  }
  await fs.rm(/*turbopackIgnore: true*/ homeFile(file), { force: true });
  await dropRecord(file);
  return { removed: true };
}

/**
 * A LoRA you trained, kept when its Train project is deleted: its file moves from the project's folder into Crackio's
 * own LoRA folder and its record becomes that of a file of yours, so it can still be sent to a machine and removed.
 * (The project's folder went with the only copy on this computer, and the LoRAs page went on saying it was "kept on
 * this computer".) `from` is null when Crackio never had a copy: the record then stands for the file on the machines.
 */
export async function keepTrained(file: string, from: string | null) {
  const { changeRecord } = await import("./loras");
  const bytes = from ? await exists(from) : null;
  if (from && bytes) {
    await fs.mkdir(/*turbopackIgnore: true*/ HOME, { recursive: true });
    await fs.copyFile(/*turbopackIgnore: true*/ from, homeFile(file));
  }
  await changeRecord(file, (r) => {
    delete r.trained;
    delete r.stale;
    if (from && bytes) {
      r.uploaded = new Date().toISOString();
      r.bytes = bytes;
    }
  });
}

/* ------------------------------------------------------------------ sending */

/** Crackio's own copy of a LoRA file: one you uploaded, or one trained here. */
export async function homeCopy(file: string): Promise<{ path: string; bytes: number; name: string; key: string } | null> {
  if (!FILE.test(file)) return null;
  const { loraRecords } = await import("./loras");
  const r = (await loraRecords())[file];
  if (!r) return null;
  const at = r.uploaded ? homeFile(file) : r.trained ? path.join(/*turbopackIgnore: true*/ DATA_DIR, "training", r.trained, "lora", file) : null;
  const bytes = at ? await exists(at) : null;
  // (A LoRA you trained is stored under its step too, as Train's own Send does: another of its versions picked since is
  // another file, not the one already stored.)
  return at && bytes ? { path: at, bytes, name: r.name, key: `loras/${r.trained ? `${r.trained}/${r.step ?? 0}` : (r.sha256?.slice(0, 16) ?? "own")}/${file}` } : null;
}

export type LoraSend = {
  file: string;
  name: string;
  target: string;
  label: string;
  share: number;
  state: "sending" | "done" | "error";
  error?: string;
  at: number;
  /** The file's size in bytes, once it's known. */
  bytes?: number;
  /** When it last moved (ms). */
  movedAt?: number;
  /** It hasn't moved for a while: a slow link to that machine, not a stuck send. */
  slow?: boolean;
  /** A machine billed per job (a RunPod endpoint): sending there runs a paid job. */
  metered?: boolean;
};

const g = globalThis as unknown as { __crackioLoraSends?: Map<string, { send: LoraSend; run: Promise<void>; stop?: AbortController }> };
const sends = () => (g.__crackioLoraSends ??= new Map());

/** Files on their way to machines now, and the ones that arrived or failed in the last half minute. */
export function loraSends(): LoraSend[] {
  const now = Date.now();
  for (const [key, s] of sends()) if (s.send.state !== "sending" && now - s.send.at > 30_000) sends().delete(key);
  return [...sends().values()].map((s) => ({ ...s.send, ...(s.send.state === "sending" && now - (s.send.movedAt ?? s.send.at) > 45_000 ? { slow: true } : {}) }));
}

/** Stops a file on its way to a machine. What already arrived there is a part file the next send starts over. */
export function stopSend(file: string, target: string): boolean {
  const s = sends().get(`${target}|${file}`);
  if (!s || s.send.state !== "sending") return false;
  if (s.stop) s.stop.abort();
  else {
    // A send from before sends could be stopped (an endpoint's job that never starts): let go of here, so its line
    // leaves the page; whatever it still waits on ends by itself.
    s.send.state = "error";
    s.send.error = "Stopped.";
    s.send.at = Date.now();
  }
  return true;
}

/**
 * A LoRA file sent from this computer to a machine's models/loras. Asked twice at once (two jobs wanting it), it travels
 * once. `from` names the file when no record does (a training job's result).
 */
export function sendHome(file: string, target: ComfyTarget, opts: { from?: { path: string; bytes: number; name: string; key: string }; signal?: AbortSignal; onShare?: (share: number) => void } = {}): Promise<void> {
  const key = `${target.id}|${file}`;
  const going = sends().get(key);
  if (going?.send.state === "sending") {
    const tick = opts.onShare ? setInterval(() => opts.onShare!(going.send.share), 1500) : null;
    return going.run.finally(() => tick && clearInterval(tick));
  }
  const stop = new AbortController();
  const signal = opts.signal ? AbortSignal.any([opts.signal, stop.signal]) : stop.signal;
  const send: LoraSend = { file, name: opts.from?.name ?? file.replace(/\.safetensors$/i, ""), target: target.id, label: target.label, share: 0, state: "sending", at: Date.now(), movedAt: Date.now(), ...(target.serverless || target.metered ? { metered: true } : {}) };
  const share = (n: number) => {
    if (n !== send.share) send.movedAt = Date.now();
    send.share = n;
    opts.onShare?.(n);
  };
  const run = (async () => {
    const copy = opts.from ?? (await homeCopy(file));
    if (!copy) throw new LoraRefused("Crackio has no copy of this LoRA on this computer to send.", 404);
    send.name = copy.name;
    send.bytes = copy.bytes;
    if (target.metered === "comfy-cloud") throw new LoraRefused("Comfy Cloud keeps its own model library: nothing of yours goes there.");
    if (target.serverless) {
      const [{ r2, putObject, presign, hasObject }, { serverlessEndpoints }, { fetchModels }] = await Promise.all([import("./serverless/r2"), import("./serverless/endpoints"), import("./serverless/shim")]);
      const cfg = r2();
      const ep = (await serverlessEndpoints()).find((e) => e.endpointId === target.serverless!.endpointId);
      if (!cfg || !ep) throw new LoraRefused("Sending a file to a RunPod endpoint needs R2 storage set up (docs/SERVERLESS.md).");
      if (copy.bytes > 3 * 1024 ** 3) throw new LoraRefused("Files over 3 GB can't go to a RunPod endpoint yet.");
      // The endpoint fetches the file in a job of its own. With RunPod's balance used up that job is never started: it
      // sat "sending, 50%" for as long as anyone watched, and held up the send to the next machine behind it.
      const { creditNow } = await import("./setup/cloud-money");
      const runpod = creditNow().find((c) => c.provider === "runpod");
      if (runpod && runpod.balance <= 0) throw new LoraRefused("RunPod's balance is used up, so its endpoint can't fetch the file. Top it up, then send again.", 402);
      if (!(await hasObject(cfg, copy.key))) await putObject(cfg, copy.key, await fs.readFile(/*turbopackIgnore: true*/ copy.path), "application/octet-stream");
      share(0.5);
      signal.throwIfAborted();
      // Ten minutes at most, and stopped when asked: the endpoint's own job can't be waited on for an hour.
      const done = await Promise.race([
        fetchModels(ep, [{ url: presign(cfg, "GET", copy.key, 3600), folder: "loras", name: file, bytes: copy.bytes }], 10 * 60_000),
        new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new LoraRefused("Stopped.")), { once: true })),
      ]);
      if (done.status !== "COMPLETED") throw new LoraRefused(`The endpoint didn't take the file (${done.status.toLowerCase()}).`, 502);
      const result = ((done.output as { results?: { name?: string; state?: string; error?: string }[] } | undefined)?.results ?? []).find((r) => r.name === file);
      if (result?.state === "failed") throw new LoraRefused(`The endpoint couldn't fetch the file: ${result.error ?? "it didn't say why"}`, 502);
    } else {
      await withTarget(target, async () => {
        const { answers, sendLora, getJson } = await import("./train/comfy");
        if (!(await answers())) throw new LoraRefused(`${target.label} isn't answering: start it first.`, 409);
        try {
          await sendLora(copy.path, file, share, signal);
        } catch (err) {
          if (signal.aborted) throw err;
          const old = /\b40[45]\b/.test((err as Error).message);
          // A ComfyUI on this computer whose helper is too old (or missing): the file is copied straight into its folder.
          const folders = old && /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/i.test(target.url) && !target.tunnel ? await getJson<Record<string, unknown[]>>("/internal/folder_paths") : null;
          const dirs = ((folders?.loras ?? []) as unknown[]).map((p) => (Array.isArray(p) ? p[0] : p)).filter((p): p is string => typeof p === "string");
          const dir = dirs.find((p) => path.basename(p) === "loras") ?? dirs[0];
          if (!dir) throw new LoraRefused(old ? `Crackio's helper on ${target.label} is too old to take LoRAs: update it under Settings → Machines.` : (err as Error).message, 502);
          await fs.copyFile(/*turbopackIgnore: true*/ copy.path, path.join(/*turbopackIgnore: true*/ dir, file));
        }
      });
    }
    share(1);
    await withTarget(target, async () => {
      (await import("./local-models")).forgetInstalled();
      // The engine's own list of this machine's LoRAs is asked afresh. Through the registry first, as the routes load it.
      await import("@/lib/engines/registry");
      (await import("@/lib/engines/comfy-local")).forgetLoraFiles();
    });
  })().then(
    () => {
      send.state = "done";
      send.at = Date.now();
    },
    (err: Error) => {
      send.state = "error";
      send.error = stop.signal.aborted ? "Stopped." : err.message;
      send.at = Date.now();
      throw err;
    },
  );
  sends().set(key, { send, run, stop });
  // Whoever waits hears of a failure; nobody waiting is no crash.
  run.catch(() => undefined);
  return run;
}

/** Send a LoRA to machines by their ids; answers with what went wrong on each (nothing: all arrived). */
export async function sendToMachines(file: string, targetIds: string[]) {
  const all = await comfyTargets();
  const results: { target: string; error?: string }[] = [];
  for (const id of targetIds) {
    const target = all.find((t) => t.id === id);
    if (!target) {
      results.push({ target: id, error: "That machine isn't one of yours." });
      continue;
    }
    try {
      await sendHome(file, target);
      results.push({ target: id });
    } catch (err) {
      results.push({ target: id, error: (err as Error).message });
    }
  }
  return { results };
}

/**
 * Before a job: the LoRAs it asks for that the machine it runs on (the current target) doesn't have, sent there from
 * Crackio's own copies. Never fails the job: a file that can't travel is said, and the job is drawn without it. Answers
 * with how many arrived.
 */
export async function bringHome(files: string[], say: (text: string) => void, signal?: AbortSignal): Promise<number> {
  const target = currentTarget();
  // Comfy Cloud draws with its own library only: nothing to try.
  if (target.metered === "comfy-cloud") return 0;
  let arrived = 0;
  for (const file of files) {
    const copy = await homeCopy(file).catch(() => null);
    if (!copy) continue;
    const size = copy.bytes >= 1024 ** 3 ? `${(copy.bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(copy.bytes / 1024 ** 2))} MB`;
    say(`Sending ${copy.name} to ${target.label} (${size})`);
    let said = 0;
    try {
      await sendHome(file, target, {
        signal,
        onShare: (n) => {
          const tenth = Math.floor(n * 10);
          if (tenth > said && tenth < 10) {
            said = tenth;
            say(`Sending ${copy.name} to ${target.label} · ${tenth * 10}%`);
          }
        },
      });
      arrived++;
      // It replaced an older version there: its record says so no longer, and the machine reads the file again (ComfyUI
      // remembers a LoRA by its file's name).
      const { changeRecord } = await import("./loras");
      let replaced = false;
      await changeRecord(file, (r) => {
        if (!r.stale?.includes(target.id)) return;
        replaced = true;
        r.stale = r.stale.filter((x) => x !== target.id);
        if (!r.stale.length) delete r.stale;
      }).catch(() => null);
      if (replaced && !target.serverless) await import("./train/comfy").then((m) => m.postJson("/free", { unload_models: true, free_memory: true }, 10_000)).catch(() => null);
    } catch (err) {
      if (signal?.aborted) throw err;
      say(`${copy.name} couldn't be sent to ${target.label} (${(err as Error).message.slice(0, 140)}): drawn without it`);
    }
  }
  return arrived;
}
