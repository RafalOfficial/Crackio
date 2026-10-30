import "server-only";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { DETAIL_PASS, jobUnits, picturePlan, recipeFor, type Recipe, type Uploaded } from "./comfy-local-recipes";
import { detail, enlarge, forMac, stockAttention, tune, withLoras, type ApiGraph } from "./comfy-local-templates";
import { estimateContext, estimateFor, forgetInstalled, installedFiles, installModel, lastRunUsed, pickTarget, poolFor, recordSpeed, restartIfPending, type PoolHelper } from "@/lib/server/local-models";
import { currentTarget, withTarget } from "@/lib/server/comfy-targets";
import { whileBusy } from "@/lib/server/comfy-busy";
import { allLocalModels } from "@/lib/server/local-templates";
import { formatSeconds } from "@/lib/local/fit";
import { speedModeFor } from "@/lib/local/work";
import { refinePrompt } from "./refine";
import { aspectById, sizeFor, type AspectId } from "@/lib/shot";
import { ticker } from "./util";
import { EngineError, type Engine, type EngineContext, type EngineJob, type EngineOutput } from "./types";
import { machineKey, recorded } from "@/lib/server/recipes";
import { lean, type ApiGraph as RecipeGraph, type RecipeStep } from "@/lib/recipes/recipe";

/**
 * Your own ComfyUI (on this computer or a rented GPU box), driven through its HTTP API: inputs are
 * uploaded to its input folder, one API-format workflow per model is queued (see
 * comfy-local-recipes), and the finished files are downloaded from its output folder.
 *
 * COMFYUI_URL points at the main one (default http://127.0.0.1:8188). COMFYUI_TOKEN is sent as a bearer
 * token, for a box behind vast.ai's portal, which takes `Authorization: Bearer <OPEN_BUTTON_TOKEN>`. With more than
 * one ComfyUI (comfy-targets: the one Crackio installed here, a Mac on the network), each job runs on one that has
 * its model's files, idle and fastest first; everything below talks to that one (`currentTarget()`).
 * Big results are fetched in parallel byte ranges: long routes cap each connection well below the
 * line's speed, and more connections add up.
 */

const CLIENT_ID = `crackio-${process.pid}`;
const RANGE_PARTS = 8;

async function call(route: string, init: RequestInit & { signal: AbortSignal }) {
  const t = currentTarget();
  const headers = new Headers(init.headers);
  if (t.token) headers.set("Authorization", `Bearer ${t.token}`);
  try {
    return await fetch(`${t.url}${route}`, { ...init, headers, cache: "no-store" });
  } catch (err) {
    if (init.signal.aborted) throw err;
    throw new EngineError(`ComfyUI isn't answering at ${t.url}: ${(err as Error).message}`, "Check that the machine and its ComfyUI are running.");
  }
}

async function json<T>(res: Response, what: string): Promise<T> {
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 401) throw new EngineError("ComfyUI refused Crackio's token.", "Set COMFYUI_TOKEN to the box's OPEN_BUTTON_TOKEN.");
    throw new EngineError(`ComfyUI couldn't ${what} (${res.status}): ${describeError(text)}`);
  }
  return JSON.parse(text) as T;
}

/** ComfyUI's validation errors name the node and the input; keep the first few, readable. */
function describeError(text: string) {
  try {
    const body = JSON.parse(text) as { error?: { message?: string; details?: string }; node_errors?: Record<string, { class_type?: string; errors?: { message?: string; details?: string }[] }> };
    const nodes = Object.entries(body.node_errors ?? {})
      .slice(0, 3)
      .map(([id, n]) => `${n.class_type ?? "node"} #${id}: ${(n.errors ?? []).map((e) => [e.message, e.details].filter(Boolean).join(" · ")).join("; ")}`);
    return [body.error?.message, body.error?.details, ...nodes].filter(Boolean).join(" | ").slice(0, 600) || text.slice(0, 300);
  } catch {
    return text.slice(0, 300);
  }
}

const sentFiles = ((globalThis as unknown as { __crackioComfySent?: Map<string, Uploaded> }).__crackioComfySent ??= new Map());

/** Whether a file Crackio put in a ComfyUI's input folder is still there (a HEAD of ComfyUI's /view, no download). */
async function stillThere(u: Uploaded, signal: AbortSignal) {
  const at = u.name.lastIndexOf("/");
  const query = new URLSearchParams({ filename: u.name.slice(at + 1), subfolder: at >= 0 ? u.name.slice(0, at) : "", type: "input" });
  return (await call(`/view?${query}`, { method: "HEAD", signal }).catch(() => null))?.ok ?? false;
}

/**
 * Put a file in ComfyUI's input folder (pictures and clips alike); returns the name loaders take. The same bytes go to the
 * same ComfyUI once: a rented box far away takes seconds per megabyte, and every job sends its Cast sheets again.
 */
export async function uploadInput(data: Buffer, filename: string, signal: AbortSignal): Promise<Uploaded> {
  const key = `${currentTarget().id}|${createHash("sha1").update(data).digest("hex")}`;
  const sent = sentFiles.get(key);
  if (sent && (await stillThere(sent, signal))) return sent;
  const uploaded = await uploadNow(data, filename, signal);
  sentFiles.set(key, uploaded);
  if (sentFiles.size > 2000) sentFiles.delete(sentFiles.keys().next().value!);
  return uploaded;
}

async function uploadNow(data: Buffer, filename: string, signal: AbortSignal): Promise<Uploaded> {
  const form = new FormData();
  form.append("image", new Blob([new Uint8Array(data)]), filename);
  form.append("type", "input");
  form.append("subfolder", "crackio");
  form.append("overwrite", "true");
  // Sent again when the connection drops: the name is this job's own and overwrites, so a second copy changes nothing.
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await call("/upload/image", { method: "POST", body: form, signal });
      const out = await json<{ name: string; subfolder?: string }>(res, "take the upload");
      return { name: out.subfolder ? `${out.subfolder}/${out.name}` : out.name };
    } catch (err) {
      // A restart (ComfyUI loading a new node) takes up to a minute: keep trying that long.
      if (signal.aborted || attempt >= 8 || !dropped(err)) throw err;
      await new Promise((r) => setTimeout(r, 3000 * Math.min(attempt, 4)));
    }
  }
}

/**
 * The connection failed (a rented box far away blinks now and then), or the box's web portal answered for a ComfyUI
 * that's restarting (502–504), as opposed to ComfyUI answering with an error.
 */
const dropped = (err: unknown) => err instanceof EngineError && (err.message.startsWith("ComfyUI isn't answering") || /^ComfyUI couldn't [^(]*\((502|503|504)\)/.test(err.message));

/** An input file from disk, uploaded under a name that won't collide with other jobs. */
export async function uploadFile(file: string, signal: AbortSignal, tag = "in"): Promise<Uploaded> {
  const ext = path.extname(file) || ".bin";
  return uploadInput(await fs.readFile(file), `${tag}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}${ext}`, signal);
}

type HistoryEntry = {
  status?: { status_str?: string; completed?: boolean; messages?: [string, Record<string, unknown>][] };
  outputs?: Record<string, Record<string, unknown>>;
};
type OutputFile = { filename: string; subfolder?: string; type?: string };

const SAMPLERS = new Set(["KSampler", "KSamplerAdvanced", "SamplerCustom", "SamplerCustomAdvanced"]);

/**
 * Step progress from ComfyUI's websocket, mapped onto `from`–0.92. Only the graph's sampling nodes move the bar,
 * one share each (a swap samples once per segment; SAM 3.1's frame-by-frame tracking also reports "steps", which
 * would race it to the end); other nodes' progress just names what's happening. Returns a closer. Without a
 * websocket the ticker still moves the bar.
 */
function watchProgress(promptId: string, ctx: EngineContext, expectedMs: number, from: number, graph: Record<string, unknown>) {
  const started = Date.now();
  let firstStep: { at: number; share: number } | null = null;
  const stopTicker = ticker(ctx.progress, expectedMs, from, (elapsed) => `Rendering${left(expectedMs - elapsed)}`);
  const samplers = Object.entries(graph)
    .filter(([, n]) => SAMPLERS.has((n as { class_type?: string }).class_type ?? ""))
    .map(([id]) => id);
  const done = new Set<string>();
  let last = from;
  let ws: WebSocket | null = null;
  let tickerStopped = false;
  let closed = false;
  const t = currentTarget();
  // A box behind Cloudflare (RunPod's proxy, quick tunnels) drops a socket that's quiet for about 100 s, and ComfyUI never
  // pings: send a small message it ignores every 30 s, and open the socket again when it drops anyway.
  const ping = setInterval(() => {
    try {
      if (ws?.readyState === WebSocket.OPEN) ws.send('{"type":"crackio_ping"}');
    } catch {
      /* closing */
    }
  }, 30_000);
  const open = () => {
    if (closed) return;
    try {
      const url = new URL(`${t.url}/ws`);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("clientId", CLIENT_ID);
      if (t.token) url.searchParams.set("token", t.token);
      ws = new WebSocket(url);
      ws.onmessage = onMessage;
      ws.onerror = () => undefined;
      ws.onclose = () => void setTimeout(open, 2000);
    } catch {
      ws = null;
    }
  };
  const onMessage = (ev: MessageEvent) => {
    if (typeof ev.data !== "string") return;
    try {
      const msg = JSON.parse(ev.data) as { type: string; data?: { prompt_id?: string; value?: number; max?: number; node?: string; text?: string } };
      // The bridge's word while a Mac rests between steps ("Letting your Mac cool down").
      if (msg.type === "crackio.status" && msg.data?.prompt_id === promptId && msg.data.text) return void ctx.progress(last, msg.data.text);
      if (msg.type !== "progress" || msg.data?.prompt_id !== promptId || !msg.data.max) return;
      const node = msg.data.node ?? "";
      const value = msg.data.value ?? 0;
      if (samplers.length && !samplers.includes(node)) {
        if (tickerStopped) ctx.progress(last, `Preparing · ${value}/${msg.data.max}`);
        return;
      }
      if (!tickerStopped) {
        stopTicker();
        tickerStopped = true;
      }
      if (value >= msg.data.max) done.add(node);
      const share = samplers.length ? (done.size + (done.has(node) ? 0 : value / msg.data.max)) / samplers.length : value / msg.data.max;
      const part = samplers.length > 1 ? ` · part ${Math.min(samplers.length, done.size + (done.has(node) ? 0 : 1))} of ${samplers.length}` : "";
      last = from + Math.min(1, share) * (0.92 - from);
      // The time left at the steps' own pace once two have been seen (loading and reading the prompt come before them),
      // else what's left of the expected time.
      const now = Date.now();
      if (firstStep === null) firstStep = { at: now, share };
      const rest = share > firstStep.share ? ((now - firstStep.at) / (share - firstStep.share)) * (1 - share) : expectedMs - (now - started);
      ctx.progress(last, `Rendering${part} · step ${value}/${msg.data.max}${left(rest)}`);
    } catch {
      /* not a progress message */
    }
  };
  open();
  return () => {
    closed = true;
    clearInterval(ping);
    if (!tickerStopped) stopTicker();
    try {
      (ws as WebSocket | null)?.close();
    } catch {
      /* already closed */
    }
  };
}

/**
 * How long ComfyUI worked on a job, from its own messages (execution_start to execution_success, in ms), and whether
 * its models were already loaded: every loader node came from ComfyUI's cache, so no weights were read from disk.
 */
function ranFor(entry: HistoryEntry, graph: Record<string, unknown>): { ms: number | null; warm: boolean } {
  const message = (kind: string) => entry.status?.messages?.find(([k]) => k === kind)?.[1];
  const start = message("execution_start")?.timestamp;
  const end = message("execution_success")?.timestamp;
  const cached = new Set((message("execution_cached")?.nodes as string[] | undefined) ?? []);
  const loaders = Object.entries(graph).filter(([, n]) => /Loader/.test(String((n as { class_type?: string }).class_type)));
  return {
    ms: typeof start === "number" && typeof end === "number" && end > start ? end - start : null,
    warm: loaders.length > 0 && loaders.every(([id]) => cached.has(id)),
  };
}

/** What a RunPod Serverless job was billed (server/serverless adds it to the job's messages); null elsewhere. */
function billed(entry: HistoryEntry): { executionTime: number; delayTime: number; gpu: string | null } | null {
  const m = entry.status?.messages?.find(([k]) => k === "crackio_serverless")?.[1] as { executionTime?: number; delayTime?: number; gpu?: string | null } | undefined;
  return m ? { executionTime: Number(m.executionTime) || 0, delayTime: Number(m.delayTime) || 0, gpu: m.gpu ?? null } : null;
}

/** What a Comfy Cloud job ran for (server/serverless/comfy-cloud adds it to the job's messages); null elsewhere. */
function cloudBilled(entry: HistoryEntry): { executionMs: number; credits: number } | null {
  const m = entry.status?.messages?.find(([k]) => k === "crackio_comfy_cloud")?.[1] as { executionMs?: number; credits?: number } | undefined;
  return m ? { executionMs: Number(m.executionMs) || 0, credits: Number(m.credits) || 0 } : null;
}

/** " · about 6 min left" for waits worth naming; nothing for short ones. */
const left = (ms: number) => (ms > 45_000 ? ` · about ${formatSeconds(ms / 1000)} left` : "");

/**
 * Queues a graph under an id Crackio picks (ComfyUI 0.4 and later take one). When the connection drops while it's sent,
 * the box's queue and history say whether it arrived, so trying again never runs the job twice; while that can't be
 * told, Crackio waits rather than send it again. A ComfyUI too old to take the id gives its own.
 */
async function submit(graph: Record<string, unknown>, model: string | undefined, signal: AbortSignal, front = false): Promise<string> {
  const promptId = crypto.randomUUID();
  const body = JSON.stringify({ prompt: graph, prompt_id: promptId, ...(front ? { front: true } : {}), extra_data: { crackio: { model: model ?? "workflow" } } });
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await call("/prompt", { method: "POST", headers: { "Content-Type": "application/json" }, body, signal });
      return (await json<{ prompt_id: string }>(res, "queue the workflow")).prompt_id;
    } catch (err) {
      if (signal.aborted || attempt >= 3 || !dropped(err)) throw err;
      let seen: boolean | null = null;
      for (let check = 0; check < 10 && seen === null && !signal.aborted; check++) {
        await new Promise((r) => setTimeout(r, 3000));
        seen = await arrived(promptId, signal);
      }
      if (seen) return promptId;
      if (seen === null) throw err;
    }
  }
}

/** Whether ComfyUI has a job: in line, running or done; null when it can't be reached to say. */
async function arrived(promptId: string, signal: AbortSignal): Promise<boolean | null> {
  try {
    const q = (await (await call("/queue", { signal })).json()) as { queue_running?: unknown[][]; queue_pending?: unknown[][] };
    if ([...(q.queue_running ?? []), ...(q.queue_pending ?? [])].some((p) => p[1] === promptId)) return true;
    const h = (await (await call(`/history/${promptId}`, { signal })).json()) as Record<string, unknown>;
    return Boolean(h[promptId]);
  } catch {
    return null;
  }
}

/**
 * Queue a workflow and wait for it; returns the files its output nodes wrote and how long ComfyUI worked on it. Sent without a
 * client id, so ComfyUI tells every open window of its own interface how the job goes (the ComfyUI page shows its nodes
 * working), and marked as Crackio's (`extra_data.crackio`, with the model's name) so that page knows which jobs to open.
 */
/**
 * `front`: ahead of everything waiting in ComfyUI's line (a click waiting on an outline), after what's running. Inside a
 * Library job the graph is kept as sent, with the machine, its GPU and the time it took (server/recipes).
 */
export async function runWorkflow(graph: Record<string, unknown>, ctx: EngineContext, expectedMs: number, model?: string, front = false): Promise<{ files: OutputFile[]; ms: number | null; warm: boolean }> {
  const t = currentTarget();
  return recorded(
    { kind: "comfyui", name: model ?? "Workflow", machine: { key: machineKey(t.id), label: t.label }, graph: lean(graph, 65_536) as RecipeGraph },
    (step) => {
      if (step) void describeMachine(graph, step);
      return queueAndWait(graph, ctx, expectedMs, model, front, step);
    },
    (out, step) => {
      Object.assign(step, { ms: out.ms, warm: out.warm, outputs: out.files.map((f) => f.filename) });
      // On RunPod Serverless: what it billed (in ms, as its /status says) and the GPU the job got.
      if (out.serverless) {
        Object.assign(step, { executionTime: out.serverless.executionTime, delayTime: out.serverless.delayTime });
        if (out.serverless.gpu && step.machine) step.machine.gpu = out.serverless.gpu;
      }
      // On Comfy Cloud: the GPU time it ran and what that came to in Comfy credits.
      if (out.comfyCloud) Object.assign(step, { executionMs: out.comfyCloud.executionMs, comfyCredits: out.comfyCloud.credits });
    },
  );
}

async function queueAndWait(graph: Record<string, unknown>, ctx: EngineContext, expectedMs: number, model: string | undefined, front: boolean, step: RecipeStep | null) {
  const id = await submit(graph, model, ctx.signal, front);
  if (step) step.promptId = id;
  // Cancelling takes it out of the line, or stops it if it's already running, on the ComfyUI running it: the abort
  // arrives from the cancel request, outside this job's context, where "the current ComfyUI" is the main one.
  const target = currentTarget();
  const post = (route: string, body: unknown) =>
    withTarget(target, () => call(route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: new AbortController().signal })).catch(() => undefined);
  const cancel = () => void Promise.all([post("/queue", { delete: [id] }), post("/interrupt", { prompt_id: id })]);
  ctx.signal.addEventListener("abort", cancel, { once: true });

  // The bar only moves once ComfyUI starts this job; until then it shows the place in line.
  let stop: (() => void) | null = null;
  // Polls in a row that found the job neither in line, nor running, nor finished: ComfyUI restarted and lost it.
  let missing = 0;
  // Polls in a row that couldn't reach ComfyUI at all. It keeps working meanwhile, so a short drop doesn't end the job.
  let offline = 0;
  try {
    for (let polls = 0; ; polls++) {
      if (ctx.signal.aborted) throw new EngineError("Cancelled.");
      const q = await json<{ queue_running?: unknown[][]; queue_pending?: unknown[][] }>(await call("/queue", { signal: ctx.signal }), "report its queue").catch(() => null);
      const queued = Boolean(q?.queue_running?.some((p) => p[1] === id) || q?.queue_pending?.some((p) => p[1] === id));
      if (!stop) {
        const running = !q || q.queue_running?.some((p) => p[1] === id) || !q.queue_pending?.some((p) => p[1] === id);
        if (running) stop = watchProgress(id, ctx, expectedMs, 0.12, graph);
        else {
          const ahead = (q?.queue_pending?.findIndex((p) => p[1] === id) ?? 0) + (q?.queue_running?.length ?? 0);
          ctx.progress(0.1, `In ComfyUI's queue · ${ahead} ahead`);
        }
      }
      let entry: HistoryEntry | undefined;
      try {
        entry = (await json<Record<string, HistoryEntry>>(await call(`/history/${id}`, { signal: ctx.signal }), "report the job"))[id];
        offline = 0;
      } catch (err) {
        if (ctx.signal.aborted || !dropped(err) || ++offline >= 20) throw err;
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      missing = !entry && q && !queued ? missing + 1 : 0;
      if (missing >= 15) throw new EngineError("ComfyUI lost the job (it restarted?).", "Run it again.");
      if (entry?.status?.status_str === "error") {
        const err = entry.status.messages?.find(([kind]) => kind === "execution_error")?.[1] as { node_type?: string; exception_message?: string } | undefined;
        throw new EngineError(`ComfyUI failed${err?.node_type ? ` in ${err.node_type}` : ""}: ${(err?.exception_message ?? "unknown error").trim().slice(0, 400)}`, "Try other settings, or check the box's ComfyUI log.");
      }
      if (entry?.status?.completed || (entry?.outputs && Object.keys(entry.outputs).length && entry.status?.status_str === "success")) {
        const files: OutputFile[] = [];
        for (const node of Object.values(entry.outputs ?? {})) {
          for (const list of Object.values(node)) {
            if (!Array.isArray(list)) continue;
            for (const item of list) if (item && typeof item === "object" && typeof (item as OutputFile).filename === "string") files.push(item as OutputFile);
          }
        }
        return { files: files.filter((f) => (f.type ?? "output") === "output"), ...ranFor(entry, graph), serverless: billed(entry), comfyCloud: cloudBilled(entry) };
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  } finally {
    (stop as (() => void) | null)?.();
    ctx.signal.removeEventListener("abort", cancel);
  }
}

const MIME_BY_EXT: Record<string, string> = { ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };

/** Pieces of a result are fetched this big, a few at a time, so a dropped connection costs one piece, not the file. */
const PIECE = 2 * 1024 * 1024;

/** One request, tried again when the connection drops (a rented box far away can cut long transfers). */
async function fetchTried(route: string, init: RequestInit, signal: AbortSignal, ok: (res: Response) => boolean, what: string) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await call(route, { ...init, signal });
      if (!ok(res)) throw new EngineError(`ComfyUI didn't send ${what} (${res.status}).`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      if (signal.aborted || attempt >= 5) throw err;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
}

const gpus = new Map<string, Promise<string | null>>();

/** The current ComfyUI's GPU as it names it ("NVIDIA GeForce RTX 5090"), asked once per ComfyUI. */
function gpuName() {
  const key = currentTarget().url;
  let known = gpus.get(key);
  if (!known) {
    known = call("/system_stats", { signal: AbortSignal.timeout(15_000) })
      .then(async (res) => {
        const dev = ((await res.json()) as { devices?: { name?: string; type?: string }[] }).devices?.[0];
        if (!dev?.name) return null;
        if (dev.type === "mps") return "Apple silicon (Metal)";
        return dev.name.replace(/^cuda:\d+\s*/, "").replace(/\s*:\s*\w+$/, "").trim() || null;
      })
      .catch(() => null);
    gpus.set(key, known);
  }
  return known;
}

const packs = new Map<string, Promise<string | null>>();

/** The custom node pack a node comes from (its `/object_info` python_module), null for ComfyUI's own; asked once per ComfyUI. */
function packOf(classType: string) {
  const key = `${currentTarget().url} ${classType}`;
  let known = packs.get(key);
  if (!known) {
    known = call(`/object_info/${encodeURIComponent(classType)}`, { signal: AbortSignal.timeout(20_000) })
      .then(async (res) => /^custom_nodes[./\\]([^./\\]+)/.exec(((await res.json()) as Record<string, { python_module?: string }>)[classType]?.python_module ?? "")?.[1] ?? null)
      .catch(() => null);
    packs.set(key, known);
  }
  return known;
}

/** A recorded step's GPU, and which of its nodes come from custom node packs (what the graph needs installed elsewhere). */
async function describeMachine(graph: Record<string, unknown>, step: RecipeStep) {
  const types = [...new Set(Object.values(graph).map((n) => (n as { class_type?: string }).class_type).filter((c): c is string => Boolean(c)))];
  const [gpu, origins] = await Promise.all([gpuName(), Promise.all(types.map(async (node) => ({ node, pack: await packOf(node) })))]);
  if (step.machine) step.machine.gpu = gpu;
  const custom = origins.filter((o): o is { node: string; pack: string } => Boolean(o.pack));
  if (custom.length) step.custom = custom;
}

/** A job's LoRAs (`options.loras`: files in ComfyUI's models/loras and their strengths), checked and capped. */
function lorasOf(job: EngineJob) {
  const list = Array.isArray(job.options?.loras) ? (job.options.loras as unknown[]) : [];
  return list
    .flatMap((l) => {
      const { file, strength } = (l ?? {}) as { file?: unknown; strength?: unknown };
      if (typeof file !== "string" || !file.trim() || file.includes("..")) return [];
      // Sliders go below zero and past 2 (an anatomy fixer at 3).
      const s = typeof strength === "number" && Number.isFinite(strength) ? Math.max(-3, Math.min(3, strength)) : 1;
      return [{ file: file.trim(), strength: s }];
    })
    .slice(0, 6);
}

/**
 * A job's LoRAs this ComfyUI has, by the name it lists them under (a Windows ComfyUI writes a subfolder's files with
 * backslashes), with the words that wake each and the model each goes on (server/loras). One it lacks is left out with a
 * note, not a failed job; a model split across two computers takes none: the other computer's blocks wouldn't get them.
 */
async function usableLoras(job: EngineJob, ctx: EngineContext, pool: PoolHelper | null) {
  const asked = lorasOf(job);
  if (!asked.length) return [];
  if (pool) {
    ctx.progress(0.03, `Drawn without its LoRAs: they can't go on a model split with ${pool.label} yet`);
    return [];
  }
  // Loaded here, not at the top: server/loras reads the model lists, and a top-level import closed a cycle with
  // models/resolve that left /api/models half-loaded.
  const [have, meta] = await Promise.all([
    loraFiles(),
    import("@/lib/server/loras").then((m) => m.loraMeta()).catch(() => new Map<string, { trigger?: string; match?: string; end?: boolean }>()),
  ]);
  const named = new Map([...have].map((f) => [f.replace(/\\/g, "/"), f]));
  return asked.flatMap((l) => {
    const file = named.get(l.file.replace(/\\/g, "/"));
    if (!file) {
      ctx.progress(0.03, `${l.file} isn't on this machine's ComfyUI: drawn without it`);
      return [];
    }
    const m = meta.get(file.replace(/\\/g, "/")) ?? {};
    return [{ file, strength: l.strength, ...(m.trigger ? { trigger: m.trigger, end: Boolean(m.end) } : {}), ...(m.match ? { match: m.match } : {}) }];
  });
}

const loraLists = new Map<string, { at: number; files: Promise<Set<string>> }>();

/** The LoRA files this ComfyUI can load (its LoraLoaderModelOnly's list), asked at most every 30 s. */
export function loraFiles(): Promise<Set<string>> {
  const key = currentTarget().url;
  const hit = loraLists.get(key);
  if (hit && Date.now() - hit.at < 30_000) return hit.files;
  const files = call("/object_info/LoraLoaderModelOnly", { signal: AbortSignal.timeout(20_000) })
    .then(async (res) => {
      const info = (await res.json()) as { LoraLoaderModelOnly?: { input?: { required?: { lora_name?: [unknown] } } } };
      const names = info.LoraLoaderModelOnly?.input?.required?.lora_name?.[0];
      return new Set(Array.isArray(names) ? names.filter((n): n is string => typeof n === "string") : []);
    })
    .catch(() => new Set<string>());
  loraLists.set(key, { at: Date.now(), files });
  return files;
}

const nodeTypes = new Map<string, { at: number; has: Promise<boolean> }>();

/**
 * Whether the ComfyUI has a node type (its `/object_info/<type>` is empty for unknown ones). A yes holds for good; a no, or
 * a check that failed (a timeout while ComfyUI restarts with a new bridge), is asked again after a minute, so it can't
 * turn a node off until Crackio restarts (on a Mac: the Mac tuning, 28 instead of 17 s a step on an M2).
 */
function hasNode(classType: string) {
  const key = `${currentTarget().url} ${classType}`;
  const known = nodeTypes.get(key);
  if (known && (known.at === 0 || Date.now() - known.at < 60_000)) return known.has;
  const has = call(`/object_info/${encodeURIComponent(classType)}`, { signal: AbortSignal.timeout(20_000) })
    .then(async (res) => res.ok && Object.keys((await res.json()) as object).length > 0)
    .catch(() => false);
  const entry = { at: Date.now(), has };
  nodeTypes.set(key, entry);
  void has.then((yes) => void (yes && (entry.at = 0)));
  return has;
}

/**
 * The memory of the NVIDIA card the current ComfyUI runs on (null on a Mac or a CPU) and the RAM it may use, in GB; null
 * when it doesn't say. `mac`: it runs on a Mac's GPU (PyTorch's MPS).
 */
async function machineMemory(signal: AbortSignal): Promise<{ vramGb: number | null; ramGb: number | null; mac: boolean }> {
  try {
    const res = await call("/system_stats", { signal });
    const stats = (await res.json()) as { system?: { ram_total?: number }; devices?: { type?: string; vram_total?: number }[] };
    const dev = stats.devices?.[0];
    const gb = (n?: number) => (n ? Math.round((n / 1024 ** 3) * 10) / 10 : null);
    return { vramGb: dev?.type === "cuda" ? gb(dev.vram_total) : null, ramGb: gb(stats.system?.ram_total), mac: dev?.type === "mps" };
  } catch {
    return { vramGb: null, ramGb: null, mac: false };
  }
}

/** One flat colour, every pixel the same (what NaNs decode to). */
async function blank(data: Buffer) {
  const { channels } = await sharp(data).stats();
  return channels.slice(0, 3).every((c) => c.max - c.min <= 3);
}

/** Download one output file, in parallel byte ranges when it's big. */
export async function downloadOutput(file: OutputFile, signal: AbortSignal): Promise<EngineOutput> {
  const q = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder ?? "", type: file.type ?? "output" });
  const route = `/view?${q}`;
  const mime = MIME_BY_EXT[path.extname(file.filename).toLowerCase()] ?? "application/octet-stream";
  const head = await call(route, { headers: { Range: "bytes=0-0" }, signal });
  const total = Number(/\/(\d+)$/.exec(head.headers.get("content-range") ?? "")?.[1] ?? 0);
  await head.arrayBuffer().catch(() => undefined);
  if (head.status !== 206 || total <= PIECE) {
    return { data: await fetchTried(route, {}, signal, (r) => r.ok, file.filename), mime };
  }
  const count = Math.ceil(total / PIECE);
  const parts: Buffer[] = new Array(count);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(RANGE_PARTS, count) }, async () => {
      while (next < count) {
        const i = next++;
        const start = i * PIECE;
        const end = Math.min(total - 1, start + PIECE - 1);
        parts[i] = await fetchTried(route, { headers: { Range: `bytes=${start}-${end}` } }, signal, (r) => r.status === 206, `part of ${file.filename}`);
      }
    }),
  );
  const data = Buffer.concat(parts);
  if (data.length !== total) throw new EngineError(`Downloaded ${data.length} of ${total} bytes of ${file.filename}.`, "Try again.");
  return { data, mime };
}

export const comfyLocalEngine: Engine = {
  id: "comfy-local",
  label: "ComfyUI",
  supports: () => true,
  async run(job, ctx) {
    const recipe = recipeFor(job.model);
    if (!recipe) throw new EngineError(`Crackio has no ComfyUI workflow for ${job.model}.`, "Pick another model.");
    const target = await pickTarget(job.model, job.options?.machine);
    // A model too big for that GPU, with another computer lending its memory: split across both.
    const pool = await poolFor(recipe.id, target).catch(() => null);
    try {
      return await withTarget(target, () => whileBusy(target.id, () => runRecipe(recipe, job, ctx, pool)));
    } catch (err) {
      // A billed machine that refused the job as it went in (Comfy Cloud on a free plan, no credits) now counts as
      // unavailable: the next machine takes it, as for one that's offline. Once.
      if (!target.metered || ctx.signal.aborted || !refused(err)) throw err;
      const next = await pickTarget(job.model, job.options?.machine);
      if (next.id === target.id || next.metered) throw err;
      ctx.progress(0.05, `${target.label} refused the job: running it on ${next.label}`);
      const nextPool = await poolFor(recipe.id, next).catch(() => null);
      return withTarget(next, () => whileBusy(next.id, () => runRecipe(recipe, job, ctx, nextPool)));
    }
  },
};

/** ComfyUI's answer when a machine won't take a job at all (no plan, no credits, a key it won't take), as `json` words it. */
const refused = (err: unknown) => err instanceof EngineError && /^ComfyUI couldn't (queue the workflow|take the upload) \((401|402|403)\)/.test(err.message);

/** Real-ESRGAN ×4's file on the current ComfyUI, installed first when it's missing (67 MB); null when that fails. */
async function ensureUpscaler(ctx: EngineContext): Promise<string | null> {
  const model = allLocalModels().find((m) => m.id === "realesrgan-x4");
  const variant = model?.variants[0];
  const file = variant?.files[0];
  if (!model || !variant || !file) return null;
  const key = `${file.folder}/${file.name}`;
  if ((await installedFiles().catch(() => new Set<string>())).has(key)) return file.name;
  ctx.progress(0.06, "Installing Real-ESRGAN (67 MB) to enlarge the picture");
  try {
    await installModel(model.id, variant.id, currentTarget().id);
  } catch {
    return null;
  }
  for (let i = 0; i < 90 && !ctx.signal.aborted; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    forgetInstalled();
    if ((await installedFiles().catch(() => new Set<string>())).has(key)) return file.name;
  }
  return null;
}

async function runRecipe(recipe: Recipe, job: EngineJob, ctx: EngineContext, pool: PoolHelper | null = null) {
  // Your words become a full scene description first, as for every other engine (FLUX 3 Klein's makers say short
  // prompts give generic pictures). Swaps and upscales bring their own prompts or none.
  if (job.refine && job.userPrompt.trim() && (job.kind === "image" || job.kind === "video")) {
    ctx.progress(0.03, "Reading the brief");
    job = { ...job, prompt: (await refinePrompt({ text: job.userPrompt, references: job.references, aspect: aspectById(job.aspect).id, signal: ctx.signal, kind: recipe.output })).prompt };
  }
  // The LoRAs chosen for this model that this ComfyUI has: the words that wake them go in now, after the brief is written,
  // so its rewrite can't drop them.
  const loras = await usableLoras(job, ctx, pool);
  const wake = (end: boolean) => [...new Set(loras.filter((l) => Boolean(l.end) === end).map((l) => l.trigger).filter((t): t is string => Boolean(t) && !job.prompt.toLowerCase().includes(t!.toLowerCase())))];
  const [first, last] = [wake(false), wake(true)];
  // "Next Scene:" and "<mva>" lead their prompt with a space: "Next Scene:, The camera…" broke the pattern they learned.
  const glue = (a: string, b: string) => (/[:.!?>]$/.test(a.trim()) ? `${a.trim()} ${b}` : `${a.trim()}, ${b}`);
  if ((first.length || last.length) && job.prompt.trim()) job = { ...job, prompt: last.reduce(glue, first.reduceRight((p, t) => glue(t, p), job.prompt.trim())) };
  // A picture's upscale is as much work as the picture is big (recipes' units): its size, from the picture itself.
  if (job.kind === "upscale" && !job.source && job.references[0]?.path) {
    const { width, height } = await sharp(job.references[0].path).metadata().catch(() => ({ width: undefined, height: undefined }));
    if (width && height) job = { ...job, options: { ...job.options, sourceWidth: width, sourceHeight: height } };
  }
  // A custom node this job may need, installed but not loaded yet: loaded now, before anything goes up.
  await restartIfPending((stage) => ctx.progress(0.03, stage));
  ctx.progress(0.04, pool ? `Splitting ${recipe.name} with ${pool.label}` : "Sending the inputs to ComfyUI");
  // What this model takes here per unit of work (local/estimate: this machine's runs, Crackio's benchmarks of its card,
  // what it's doing now): the bar's pace, and the size recipes give reference pictures on a slow GPU.
  const mode = speedModeFor(recipe.output, job.kind, job.references.length);
  const estimating = await estimateContext(recipe.id).catch(() => null);
  const perUnit = estimating ? (estimateFor(estimating, mode, 1)?.perUnit ?? null) : null;
  const probe = async (graph: Record<string, unknown>) => {
    const { files } = await runWorkflow(graph, { ...ctx, progress: () => undefined }, 30_000, `${recipe.name} (preparing)`);
    const pictures = files.filter((f) => /\.(png|jpe?g|webp)$/i.test(f.filename));
    return Promise.all(pictures.map(async (f) => (await downloadOutput(f, ctx.signal)).data));
  };
  // A recipe's picture edit (SCAIL-2's characters drawn in their people's places) runs on your image model. One on your
  // own GPU runs on this same ComfyUI, before the recipe's graph.
  const target = currentTarget();
  const edit = async (prompt: string, pictures: string[], aspect: AspectId, opts: { prefer?: string[]; stage?: string } = {}) => {
    const [{ resolveModel }, { engineFor }] = await Promise.all([import("@/lib/models/resolve"), import("./registry")]);
    let def: Awaited<ReturnType<typeof resolveModel>> | null = null;
    for (const id of opts.prefer ?? []) {
      def = await resolveModel("image", id).catch(() => null);
      if (def) break;
    }
    def ??= await resolveModel("image", "auto").catch(() => null);
    const engine = def?.via ? engineFor(def.via) : null;
    if (!def || !engine) return null;
    const { width, height } = sizeFor(aspect);
    const result = await engine.run(
      {
        kind: "image",
        model: def.model,
        via: def.via ?? undefined,
        family: def.family,
        prompt,
        userPrompt: prompt,
        refine: false,
        aspect,
        width,
        height,
        count: 1,
        references: pictures.map((p, i) => ({ path: p, label: i ? `character ${i}` : "the video frame", role: i ? "subject" : "edit-target" })),
        mode: "image",
        ...(def.via === "comfy-local" ? { options: { machine: target.id } } : {}),
      },
      { signal: ctx.signal, progress: (v, stage) => ctx.progress(0.04 + v * 0.04, `${opts.stage ?? "Posing the characters"}: ${stage ?? "drawing"}`) },
    );
    return result.outputs[0]?.data ?? null;
  };
  // A picture at the resolution asked: rendered natively up to what the model renders well, its detail drawn in past that.
  const plan = picturePlan(recipe, job, perUnit);
  const { mac, ...memory } = await machineMemory(ctx.signal);
  let graph = (await recipe.build(job, {
    upload: (file, tag) => uploadFile(file, ctx.signal, tag),
    uploadData: (data, name) => uploadInput(data, name, ctx.signal),
    probe,
    hasNode,
    perUnit,
    ...memory,
    pool,
    edit,
    note: (message) => ctx.progress(0.08, message),
    ...(plan ? { size: plan.native } : {}),
    signal: ctx.signal,
  })) as ApiGraph;
  // The Advanced section: steps, guidance, seed, negative prompt (before the detail pass, which copies them but its steps).
  const tuning = { negative: job.options?.negative, steps: job.options?.steps, cfg: job.options?.cfg, seed: job.options?.seed };
  if (Object.values(tuning).some((v) => v !== undefined && v !== "")) graph = tune(graph, tuning);
  // The LoRAs (usableLoras, above) on the graph's model; one made for another version of it (a Wan LoRA for clips from a
  // start frame, on one from words) finds no model of its own and is left out, with a note.
  if (loras.length) {
    graph = withLoras(graph, loras) as ApiGraph;
    const on = new Set(Object.values(graph).flatMap((n) => (n.class_type === "LoraLoaderModelOnly" && typeof n.inputs.lora_name === "string" ? [n.inputs.lora_name] : [])));
    const used = loras.filter((l) => on.has(l.file));
    for (const l of loras) if (!on.has(l.file)) ctx.progress(0.08, `${l.file} is made for another version of this model: drawn without it`);
    if (used.length) ctx.progress(0.08, `With ${used.map((l) => `${l.file.replace(/\.safetensors$/, "")} ${l.strength}`).join(", ")}`);
  }
  let detailed = false;
  if (plan && plan.factor > 1.02) {
    // Drawn over at the size asked by the same model, on a GPU with room for that many pixels (a 4K picture is 8 MP of
    // latents at once); else enlarged, which sharpens what's there.
    // A Mac's GPU memory is its unified memory: 32 GB holds the ~21 GB a 4K detail pass may need beside the model.
    const roomy = plan.detail && ((memory.vramGb ?? 0) >= 16 || (mac && (memory.ramGb ?? 0) >= 32));
    const sharpen = roomy && plan.factor > DETAIL_PASS.sharpenPast ? await ensureUpscaler(ctx) : null;
    const drawn = roomy ? detail(graph, plan.target, DETAIL_PASS.denoise, DETAIL_PASS.steps, sharpen) : null;
    if (drawn) {
      graph = drawn;
      detailed = true;
      ctx.progress(0.08, `${recipe.name} draws ${plan.native.width}×${plan.native.height}, then draws its detail in at ${plan.target.width}×${plan.target.height}`);
    } else {
      const upscaler = plan.factor > 1.35 ? await ensureUpscaler(ctx) : null;
      graph = enlarge(graph, plan.target, plan.factor, upscaler);
      ctx.progress(0.08, `${recipe.name} renders ${plan.native.width}×${plan.native.height}, then ${upscaler ? "Real-ESRGAN" : "a lanczos fit"} enlarges it to ${plan.target.width}×${plan.target.height}`);
    }
  }
  // On a Mac: each model in the precision its chip runs fastest, rests while it's hot, samplers that work without float64.
  if (mac) {
    // PyTorch's fused Metal attention: Crackio starts the ComfyUI it installs with it, but a Mac's ComfyUI started any other
    // way (by hand, or a Mac you added from another computer) would compute ComfyUI's slower sub-quadratic one.
    if (!Object.values(graph).some((n) => n.class_type === "ModelAttentionBackend") && (await hasNode("ModelAttentionBackend"))) graph = stockAttention(graph);
    graph = forMac(graph, await hasNode("CrackioMacTuning"));
  }
  // A detail pass left out for want of room counts as on a GPU too slow for one: not at all.
  const work = jobUnits(recipe, job, recipe.referenceMp?.(job, perUnit), plan?.detail && !detailed ? Infinity : perUnit);
  const usedFiles = new Set(Object.values(graph).flatMap((n) => Object.values((n as { inputs?: Record<string, unknown> }).inputs ?? {}).filter((v): v is string => typeof v === "string")));
  // Loading counts when the last job here ran something else.
  const loaded = await lastRunUsed(usedFiles).catch(() => false);
  const estimate = estimating ? estimateFor({ ...estimating, live: { ...estimating.live, loaded } }, mode, work) : null;
  const expected = estimate ? estimate.seconds * 1000 : recipe.expectedMs(job);
  const { files, ms, warm } = await runWorkflow(graph, ctx, expected, recipe.name);
  // An upscaler given a clip makes a clip.
  const output = job.kind === "upscale" && job.source ? "video" : recipe.output;
  const wanted = files.filter((f) => output === "video" ? /\.(mp4|webm|mov)$/i.test(f.filename) : /\.(png|jpe?g|webp)$/i.test(f.filename));
  if (!wanted.length) throw new EngineError(`The ${recipe.name} workflow finished without a ${output === "video" ? "clip" : "picture"}.`, "Check the workflow's save node.");
  ctx.progress(0.94, "Downloading the result");
  const outputs = await Promise.all(wanted.map((f) => downloadOutput(f, ctx.signal)));
  // A model whose numbers overflowed on this GPU saves a flat black picture: a failure, not a result.
  if (output === "image" && (await Promise.all(outputs.map((o) => blank(o.data)))).every(Boolean)) {
    throw new EngineError(`${recipe.name} made a blank picture on this GPU.`, "Try its other version on the Local page, or another model.");
  }
  // The Local page shows what each model really takes here per unit of work, loaded and from cold, pictures from words
  // and edits apart, and for which of its versions (the one whose model files the graph loads).
  const variant = allLocalModels()
    .find((m) => m.crackio === `local:${recipe.id}`)
    ?.variants.find((v) => v.files.filter((f) => f.role === "model").every((f) => usedFiles.has(f.name)))?.id;
  // A clip's upscale is another kind of work than a picture's: it isn't counted in the picture speeds the Local page shows.
  if (ms && !(job.kind === "upscale" && job.source)) void recordSpeed(recipe.id, { seconds: ms / 1000, work, warm, mode, variant, estimate: estimate?.seconds }).catch(() => undefined);
  return { outputs, usedPrompt: job.prompt || undefined };
}
