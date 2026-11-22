import "server-only";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { currentTarget } from "../comfy-targets";

/**
 * What training asks of a machine's ComfyUI, on `currentTarget()` (call inside `withTarget`): send the pictures, queue a
 * graph under an id of Crackio's own, follow it (ComfyUI's websocket carries the trainer's "crackio.train" status), stop
 * it, and fetch a file it made. Kept apart from the picture engine (engines/comfy-local): a training job runs for hours,
 * outlives a restart of Crackio, and reads other messages.
 */

/** A failure with what to do about it; `code` is the trainer's own (OOM, NAN, DATA, STATE, MODEL) when it has one. */
export class TrainFail extends Error {
  constructor(
    message: string,
    readonly hint?: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

const auth = () => {
  const t = currentTarget();
  return t.token ? { Authorization: `Bearer ${t.token}` } : undefined;
};

/** One request to the machine's ComfyUI. Reads are asked again twice when the connection blinks. */
async function call(route: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const t = currentTarget();
  const read = !init.method || init.method === "GET" || init.method === "HEAD";
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetch(`${t.url}${route}`, { ...init, headers: { ...auth(), ...init.headers }, cache: "no-store", signal: init.signal ?? AbortSignal.timeout(init.timeoutMs ?? 20_000) });
    } catch (err) {
      const cause = (err as { cause?: { code?: string } }).cause?.code ?? "";
      if (read && attempt < 3 && !/^(ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ENOTFOUND)$/.test(cause) && !init.signal?.aborted) {
        await new Promise((r) => setTimeout(r, 800 * attempt));
        continue;
      }
      throw new TrainFail(`${t.label} isn't answering.`, "Check that the machine and its ComfyUI are running (Settings → Machines).", "OFFLINE");
    }
  }
}

export async function getJson<T>(route: string, timeoutMs?: number): Promise<T | null> {
  try {
    const res = await call(route, { timeoutMs });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

export async function postJson<T>(route: string, body: unknown, timeoutMs?: number): Promise<{ ok: boolean; status: number; data: T | null; text: string }> {
  const res = await call(route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), timeoutMs });
  const text = await res.text();
  let data: T | null = null;
  try {
    data = JSON.parse(text) as T;
  } catch {
    /* not JSON */
  }
  return { ok: res.ok, status: res.status, data, text };
}

/** Whether the ComfyUI answers at all. */
export const answers = async () => (await getJson<unknown>("/system_stats", 8000)) !== null;

/** Whether the machine's ComfyUI has a node (the trainer's, a loader's). */
export async function hasNode(classType: string): Promise<boolean> {
  const info = await getJson<Record<string, unknown>>(`/object_info/${encodeURIComponent(classType)}`, 30_000);
  return Boolean(info && classType in info);
}

/** Whether a file Crackio sent is still in the machine's input folder. */
export async function inputThere(name: string): Promise<boolean> {
  const at = name.lastIndexOf("/");
  const query = new URLSearchParams({ filename: name.slice(at + 1), subfolder: at >= 0 ? name.slice(0, at) : "", type: "input" });
  try {
    return (await call(`/view?${query}`, { method: "HEAD", timeoutMs: 15_000 })).ok;
  } catch {
    return false;
  }
}

/** A file into the machine's input folder, under `subfolder`; returns the name loaders take. Sent again when the line drops. */
export async function upload(data: Buffer, filename: string, subfolder: string, signal: AbortSignal): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    const form = new FormData();
    form.append("image", new Blob([new Uint8Array(data)]), filename);
    form.append("type", "input");
    form.append("subfolder", subfolder);
    form.append("overwrite", "true");
    try {
      const res = await call("/upload/image", { method: "POST", body: form, signal: AbortSignal.any([signal, AbortSignal.timeout(180_000)]) });
      if (res.ok) {
        const out = (await res.json()) as { name: string; subfolder?: string };
        return out.subfolder ? `${out.subfolder}/${out.name}` : out.name;
      }
      // A ComfyUI that's only just back (a restarted pod's answered its first questions and said 404 to an upload two
      // seconds later) or a proxy in between: sent again a few times, then it counts as a machine that went away.
      const blink = [404, 502, 503, 504].includes(res.status);
      if (!blink || attempt >= 8) throw new TrainFail(`${currentTarget().label} refused a picture (${res.status}).`, undefined, blink ? "LOST" : undefined);
    } catch (err) {
      if (signal.aborted || attempt >= 8 || err instanceof TrainFail) throw err;
    }
    await new Promise((r) => setTimeout(r, 2500 * attempt));
  }
}

type ComfyError = { error?: { message?: string; details?: string }; node_errors?: Record<string, { class_type?: string; errors?: { message?: string; details?: string }[] }> };

/** Queues a graph under `promptId` (ComfyUI keeps it under that id, so asking twice never runs it twice). */
export async function queue(graph: Record<string, unknown>, promptId: string, label: string): Promise<void> {
  const out = await postJson<ComfyError & { prompt_id?: string }>("/prompt", { prompt: graph, prompt_id: promptId, extra_data: { crackio: { model: label } } }, 60_000);
  if (out.ok) return;
  const nodes = Object.values(out.data?.node_errors ?? {})
    .slice(0, 3)
    .map((n) => `${n.class_type ?? "node"}: ${(n.errors ?? []).map((e) => [e.message, e.details].filter(Boolean).join(" · ")).join("; ")}`);
  const words = [out.data?.error?.message, out.data?.error?.details, ...nodes].filter(Boolean).join(" | ").slice(0, 500) || out.text.slice(0, 300);
  throw new TrainFail(`ComfyUI on ${currentTarget().label} wouldn't take the job (${out.status}): ${words}`, undefined, /not found|does not exist|missing_node_type/i.test(words) ? "NODE" : /not in \[|value_not_in_list|Value not in list/i.test(words) ? "FILES" : undefined);
}

export type History = {
  status?: { status_str?: string; completed?: boolean; messages?: [string, Record<string, unknown>][] };
  outputs?: Record<string, Record<string, unknown>>;
};

/** A finished (or failed) job as ComfyUI remembers it; null while it runs or waits; "unreachable" when it can't be asked. */
export async function historyOf(promptId: string): Promise<History | null | "unreachable"> {
  try {
    const res = await call(`/history/${encodeURIComponent(promptId)}`, { timeoutMs: 20_000 });
    if (!res.ok) return "unreachable";
    return ((await res.json()) as Record<string, History>)[promptId] ?? null;
  } catch {
    return "unreachable";
  }
}

/** Where a job stands in ComfyUI's line: running, waiting (with how many ahead), or not there. */
export async function inQueue(promptId: string): Promise<{ state: "running" | "waiting" | "gone"; ahead: number } | null> {
  const q = await getJson<{ queue_running?: unknown[][]; queue_pending?: unknown[][] }>("/queue", 20_000);
  if (!q) return null;
  if (q.queue_running?.some((p) => p[1] === promptId)) return { state: "running", ahead: 0 };
  const at = q.queue_pending?.findIndex((p) => p[1] === promptId) ?? -1;
  if (at >= 0) return { state: "waiting", ahead: at + (q.queue_running?.length ?? 0) };
  return { state: "gone", ahead: 0 };
}

/** Takes a job out of the line, and stops it if it's the one running. */
export async function cancel(promptId: string) {
  await postJson("/queue", { delete: [promptId] }, 15_000).catch(() => undefined);
  await postJson("/interrupt", { prompt_id: promptId }, 15_000).catch(() => undefined);
}

export type Heard =
  | { type: "train"; data: Record<string, unknown> }
  /** ComfyUI's own step counter for the node at work (a serverless worker passes only this along). */
  | { type: "progress"; value: number; max: number; promptId?: string };

/**
 * Listens to the machine's ComfyUI: the trainer's status messages and step counts. The socket is opened again when it
 * drops (a rented box's proxy closes quiet ones), and pinged so it doesn't go quiet. Returns a closer.
 */
export function listen(onMessage: (m: Heard) => void): () => void {
  const t = currentTarget();
  let ws: WebSocket | null = null;
  let closed = false;
  const open = () => {
    if (closed) return;
    try {
      const url = new URL(`${t.url}/ws`);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("clientId", `crackio-train-${crypto.randomUUID().slice(0, 8)}`);
      if (t.token) url.searchParams.set("token", t.token);
      ws = new WebSocket(url);
      ws.onmessage = (ev) => {
        if (typeof ev.data !== "string") return;
        try {
          const msg = JSON.parse(ev.data) as { type?: string; data?: Record<string, unknown> };
          if (msg.type === "crackio.train" && msg.data) onMessage({ type: "train", data: msg.data });
          else if (msg.type === "progress" && msg.data && typeof msg.data.max === "number" && msg.data.max > 0) {
            onMessage({ type: "progress", value: Number(msg.data.value) || 0, max: msg.data.max, promptId: typeof msg.data.prompt_id === "string" ? msg.data.prompt_id : undefined });
          }
        } catch {
          /* not for us */
        }
      };
      ws.onerror = () => undefined;
      ws.onclose = () => void setTimeout(open, 2500);
    } catch {
      ws = null;
      setTimeout(open, 5000);
    }
  };
  const ping = setInterval(() => {
    try {
      if (ws?.readyState === WebSocket.OPEN) ws.send('{"type":"crackio_ping"}');
    } catch {
      /* closing */
    }
  }, 30_000);
  open();
  return () => {
    closed = true;
    clearInterval(ping);
    try {
      ws?.close();
    } catch {
      /* closed already */
    }
  };
}

/** A file a job wrote to ComfyUI's output folder, streamed to `dest` (a LoRA is tens to hundreds of megabytes). */
export async function fetchOutput(file: { filename: string; subfolder?: string; type?: string }, dest: string): Promise<number> {
  const query = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder ?? "", type: file.type ?? "output" });
  await fs.mkdir(/*turbopackIgnore: true*/ path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await call(`/view?${query}`, { timeoutMs: 30 * 60_000 });
      if (!res.ok || !res.body) throw new TrainFail(`${currentTarget().label} didn't hand over ${file.filename} (${res.status}).`);
      await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), createWriteStream(part));
      const size = (await fs.stat(/*turbopackIgnore: true*/ part)).size;
      const expected = Number(res.headers.get("content-length") ?? 0);
      if (expected && size !== expected) throw new TrainFail(`Got ${size} of ${expected} bytes of ${file.filename}.`);
      await fs.rename(/*turbopackIgnore: true*/ part, dest);
      return size;
    } catch (err) {
      await fs.rm(/*turbopackIgnore: true*/ part, { force: true });
      if (attempt >= 3) throw err;
      await new Promise((r) => setTimeout(r, 3000 * attempt));
    }
  }
}

/** A LoRA from the machine's models/loras, through the bridge (machines that have its routes). */
export async function fetchLora(name: string, dest: string, bytes?: number): Promise<number> {
  await fs.mkdir(/*turbopackIgnore: true*/ path.dirname(dest), { recursive: true });
  // A part file of its own: two copies of one file at once (two tabs) wrote the same one, each over the other.
  const part = `${dest}.${crypto.randomUUID().slice(0, 8)}.part`;
  try {
    const res = await call(`/crackio/train/lora?name=${encodeURIComponent(name)}`, { timeoutMs: 30 * 60_000 });
    if (!res.ok || !res.body) throw new TrainFail(`${currentTarget().label} didn't hand over ${name} (${res.status}).`);
    await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), createWriteStream(part));
    const size = (await fs.stat(/*turbopackIgnore: true*/ part)).size;
    const whole = Number(res.headers.get("content-length") ?? 0) || bytes || 0;
    if (whole && size !== whole) throw new TrainFail(`${name} arrived incomplete from ${currentTarget().label}.`, "Try again.");
    await fs.rename(/*turbopackIgnore: true*/ part, dest);
    return size;
  } catch (err) {
    await fs.rm(/*turbopackIgnore: true*/ part, { force: true }).catch(() => undefined);
    throw err;
  }
}

/**
 * A LoRA file sent into the machine's models/loras through the bridge, 4 MB at a time (ComfyUI caps a request's size).
 * Small pieces, so the progress moves on a slow link too: to a rented box across an ocean, 8 MB pieces left the bar
 * standing still for minutes at a time, and it read as stuck.
 */
export async function sendLora(file: string, name: string, onShare?: (share: number) => void, signal?: AbortSignal): Promise<void> {
  const total = (await fs.stat(/*turbopackIgnore: true*/ file)).size;
  const handle = await fs.open(/*turbopackIgnore: true*/ file, "r");
  // Small enough that one piece gets through a slow uplink inside a proxy's time limit (RunPod's allows 100 s a request).
  const PIECE = 4 * 1024 * 1024;
  try {
    for (let offset = 0; offset < total; ) {
      signal?.throwIfAborted();
      const piece = Buffer.alloc(Math.min(PIECE, total - offset));
      await handle.read(piece, 0, piece.length, offset);
      const res = await call(`/crackio/train/lora?${new URLSearchParams({ name, offset: String(offset), total: String(total) })}`, { method: "POST", body: new Uint8Array(piece), headers: { "Content-Type": "application/octet-stream" }, timeoutMs: 10 * 60_000 });
      const out = (await res.json().catch(() => ({}))) as { have?: number; error?: string };
      if (!res.ok) throw new TrainFail(`${currentTarget().label} didn't take ${name}: ${out.error ?? res.status}`);
      offset = out.have ?? offset + piece.length;
      onShare?.(offset / total);
    }
  } finally {
    await handle.close();
  }
}

/**
 * Whether the machine keeps a job's training state (what a run carries on from) and how big it is; null when its helper
 * is too old to hand one over (before 1.12.0).
 */
export async function stateProbe(job: string): Promise<{ state: boolean; bytes: number } | null> {
  const res = await call(`/crackio/train/state?job=${encodeURIComponent(job)}&probe=1`, { timeoutMs: 20_000 });
  if (res.status === 404 || res.status === 405) return null;
  const out = (await res.json().catch(() => null)) as { state?: boolean; bytes?: number } | null;
  if (!res.ok || typeof out?.state !== "boolean") throw new TrainFail(`${currentTarget().label} didn't say whether it keeps the run's checkpoint (${res.status}).`);
  return { state: out.state, bytes: out.bytes ?? 0 };
}

/** A job's training state brought from the machine to a file here. */
export async function fetchState(job: string, dest: string, onShare?: (share: number) => void): Promise<number> {
  await fs.mkdir(/*turbopackIgnore: true*/ path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  const res = await call(`/crackio/train/state?job=${encodeURIComponent(job)}`, { timeoutMs: 60 * 60_000 });
  if (!res.ok || !res.body) throw new TrainFail(`${currentTarget().label} didn't hand over the run's checkpoint (${res.status}).`);
  const total = Number(res.headers.get("content-length") ?? 0);
  let got = 0;
  const counted = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      got += chunk.length;
      if (total) onShare?.(got / total);
      done(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), counted, createWriteStream(part));
    const size = (await fs.stat(/*turbopackIgnore: true*/ part)).size;
    if (total && size !== total) throw new TrainFail("The run's checkpoint arrived incomplete.", "Try again.");
    await fs.rename(/*turbopackIgnore: true*/ part, dest);
    return size;
  } catch (err) {
    // (A copy that broke off left close to a gigabyte behind on a disk that was already short.)
    await fs.rm(/*turbopackIgnore: true*/ part, { force: true }).catch(() => undefined);
    throw err;
  }
}

/**
 * A job's training state sent to the machine, 8 MB at a time. A piece that didn't get through is sent again, from where
 * the machine says it is.
 */
export async function sendState(file: string, job: string, onShare?: (share: number) => void, signal?: AbortSignal): Promise<void> {
  const total = (await fs.stat(/*turbopackIgnore: true*/ file)).size;
  const handle = await fs.open(/*turbopackIgnore: true*/ file, "r");
  const PIECE = 8 * 1024 * 1024;
  let failed = 0;
  try {
    for (let offset = 0; offset < total; ) {
      signal?.throwIfAborted();
      const piece = Buffer.alloc(Math.min(PIECE, total - offset));
      await handle.read(piece, 0, piece.length, offset);
      let res: Response;
      try {
        res = await call(`/crackio/train/state?${new URLSearchParams({ job, offset: String(offset), total: String(total) })}`, { method: "POST", body: new Uint8Array(piece), headers: { "Content-Type": "application/octet-stream" }, timeoutMs: 10 * 60_000 });
      } catch (err) {
        if (signal?.aborted || ++failed > 4) throw err;
        await new Promise((r) => setTimeout(r, 2000 * failed));
        continue;
      }
      const out = (await res.json().catch(() => ({}))) as { have?: number; error?: string };
      // Out of step after a piece that half arrived: carry on from what the machine has (from the start at worst).
      if (res.status === 409 && typeof out.have === "number" && ++failed <= 8) {
        offset = out.have > offset ? out.have : 0;
        continue;
      }
      if (!res.ok) throw new TrainFail(`${currentTarget().label} didn't take the run's checkpoint: ${out.error ?? res.status}`);
      offset = out.have ?? offset + piece.length;
      onShare?.(offset / total);
    }
  } finally {
    await handle.close();
  }
}
