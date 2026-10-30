import "server-only";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type net from "node:net";
import path from "node:path";
import { Readable } from "node:stream";
import { Comfy, ComfyError, type Job, type Output } from "@comfyorg/sdk";
import { acceptSocket, broadcast } from "./ws";

/**
 * Comfy Cloud as one more ComfyUI of Crackio's: a small server on this computer speaks the part of ComfyUI's API Crackio
 * uses, and runs each graph on Comfy's GPUs through the official SDK (Comfy API v2, @comfyorg/sdk): inputs go up as
 * assets and are referenced in the graph as `core/ASSET`, jobs are submitted and followed, results come back as signed
 * links. Every tool, recipes and the Library work as on your own ComfyUI. Paid with your Comfy credits (a plan with API
 * access), so it runs jobs only when picked under Run on, never by Auto.
 *
 * Which models it has comes from Comfy Cloud's public model list, so the pickers offer only what runs there. It listens
 * on 127.0.0.3 (127.0.0.1 counts as this computer's own ComfyUI).
 */

const HOST = "127.0.0.3";
const BASE_PORT = 39_600;
/** Comfy Cloud's own routes (its model list, stats, nodes). For a test, a ComfyUI of yours, with COMFY_BASE_URL at comfy-api-proxy. */
const CLOUD = process.env.CRACKIO_COMFY_CLOUD_URL?.trim().replace(/\/+$/, "") || "https://cloud.comfy.org";
/** Bumped when this server changes: one started by older code is closed and started again. */
const VERSION = 5;
/** Comfy Cloud's rate for API jobs: 736.39 credits an hour of GPU time (RTX PRO 6000 Blackwell 96 GB), Oct 2026. */
export const CREDITS_PER_MS = 736.39 / 3_600_000;
const FOLDERS = ["checkpoints", "diffusion_models", "text_encoders", "vae", "loras", "upscale_models", "latent_upscale_models", "controlnet", "clip_vision", "model_patches", "audio_encoders", "style_models"];

/** An input Crackio put on Comfy Cloud: its asset, and when it was last seen there (assets expire). */
type Uploaded = { id: string; filePath: string; seen: number };
type CloudJob = {
  promptId: string;
  number: number;
  graph: unknown;
  extra: unknown;
  job?: Job;
  state: "pending" | "running" | "done" | "error";
  error?: { message: string; node?: string; type?: string };
  outputs?: Record<string, { images: { filename: string; subfolder: string; type: "output" }[] }>;
  startedAt?: number;
  completedAt?: number;
  executionMs?: number;
  queueMs?: number;
};
type State = {
  key: string;
  /** Comfy Cloud refused a job for good (a free plan, no credits, a key it won't take): unavailable until then. */
  blocked?: { reason: string; until: number } | null;
  client: Comfy;
  uploads: Map<string, Uploaded>;
  outputs: Map<string, Output>;
  jobs: Map<string, CloudJob>;
  counter: number;
  models: { at: number; files: Record<string, string[]> } | null;
  nodes: { at: number; modules: Record<string, string | null> } | null;
  version: string | null;
  sockets: Set<net.Socket>;
  server?: http.Server;
  port?: number;
  build?: number;
};

const g = globalThis as unknown as { __crackioComfyCloud?: { state: State | null; start: Promise<State> | null } };
const box = (g.__crackioComfyCloud ??= { state: null, start: null });

/** The local address that stands for Comfy Cloud, its server started on first use (and again when the key changes). */
export async function comfyCloudFor(key: string): Promise<{ url: string }> {
  const running = box.start ? await box.start.catch(() => null) : null;
  if (!running || running.build !== VERSION || running.key !== key) {
    if (running?.server) {
      running.server.closeAllConnections();
      running.server.close();
      await new Promise((r) => setTimeout(r, 150));
    }
    box.start = launch(key);
    box.start.catch(() => (box.start = null));
  }
  const s = await box.start!;
  return { url: `http://${HOST}:${s.port}` };
}

async function launch(key: string): Promise<State> {
  const old = box.state;
  const s: State =
    old && old.key === key
      ? old
      : { key, client: new Comfy({ apiKey: key, clientInfo: "crackio" }), uploads: new Map(), outputs: new Map(), jobs: new Map(), counter: 0, models: null, nodes: null, version: null, sockets: new Set() };
  box.state = s;
  const server = http.createServer((req, res) => void handle(s, req, res).catch((err) => send(res, 500, { error: { message: (err as Error).message } })));
  server.on("upgrade", (req, socket) => acceptSocket(s.sockets, req, socket as net.Socket));
  // One Crackio per demo code means many on one host: each takes the next free port.
  for (let port = BASE_PORT, tries = 0; tries < 400; port++, tries++) {
    const ok = await new Promise<boolean>((resolve) => {
      const fail = () => resolve(false);
      server.once("error", fail);
      server.listen(port, HOST, () => {
        server.off("error", fail);
        resolve(true);
      });
    });
    if (ok) {
      Object.assign(s, { server, port, build: VERSION });
      return s;
    }
  }
  throw new Error("No free port for Comfy Cloud.");
}

function send(res: http.ServerResponse, code: number, body: unknown) {
  if (res.headersSent) return res.destroy();
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

const readBody = async (req: http.IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
};

async function handle(s: State, req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? "/", "http://cloud");
  const route = url.pathname.replace(/^\/api(?=\/)/, "");
  const method = req.method ?? "GET";
  if (route === "/system_stats") return systemStats(s, res);
  if (route === "/prompt" && method === "POST") return prompt(s, JSON.parse((await readBody(req)).toString("utf8") || "{}"), res);
  if (route === "/queue" && method === "GET") return send(res, 200, queue(s));
  if ((route === "/queue" || route === "/interrupt") && method === "POST") {
    const body = JSON.parse((await readBody(req)).toString("utf8") || "{}") as { delete?: string[]; prompt_id?: string };
    for (const id of [...(body.delete ?? []), ...(body.prompt_id ? [body.prompt_id] : [])]) stop(s, id);
    return send(res, 200, {});
  }
  if (route === "/history" && method === "GET") {
    const last = [...s.jobs.values()].filter((j) => j.state === "done").sort((a, b) => b.number - a.number)[0];
    return send(res, 200, last ? history(last) : {});
  }
  if (route.startsWith("/history/")) {
    const job = s.jobs.get(decodeURIComponent(route.slice("/history/".length)));
    return send(res, 200, job && (job.state === "done" || job.state === "error") ? history(job) : {});
  }
  if (route === "/upload/image" && method === "POST") return upload(s, req, res);
  if (route === "/view") return view(s, url, req, res);
  if (route.startsWith("/object_info")) return objectInfo(s, decodeURIComponent(route.slice("/object_info".length).replace(/^\//, "")), res);
  if (route === "/models") return send(res, 200, FOLDERS);
  if (route.startsWith("/models/")) return send(res, 200, (await models(s))[decodeURIComponent(route.slice("/models/".length))] ?? []);
  if (route === "/" || route === "/index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    return res.end(
      `<!doctype html><meta charset="utf-8"><body style="margin:0;display:grid;place-items:center;height:100vh;background:#16131b;color:#c9c3d3;font:14px system-ui;text-align:center"><p>Crackio runs these jobs on Comfy Cloud. Its own interface is at <a style="color:#fff" href="${CLOUD}" target="_blank" rel="noreferrer">cloud.comfy.org</a>.</p></body>`,
    );
  }
  return send(res, 404, { error: "not here" });
}

/** Comfy Cloud's public model list, folder by folder (no key needed), looked at again every 10 minutes. */
async function models(s: State) {
  if (s.models && Date.now() - s.models.at < 10 * 60_000) return s.models.files;
  const lists = await Promise.all(
    FOLDERS.map(async (f) => {
      const res = await fetch(`${CLOUD}/api/experiment/models/${f}`, { signal: AbortSignal.timeout(20_000), cache: "no-store" }).catch(() => null);
      const body = res?.ok ? ((await res.json().catch(() => [])) as ({ name?: string } | string)[]) : [];
      return [f, body.map((x) => (typeof x === "string" ? x : (x.name ?? ""))).filter(Boolean)] as const;
    }),
  );
  const files = Object.fromEntries(lists);
  if (Object.values(files).some((l) => l.length)) s.models = { at: Date.now(), files };
  return files;
}

async function systemStats(s: State, res: http.ServerResponse) {
  // Unavailable after a refusal: jobs then go elsewhere, as for a machine that's offline.
  if (comfyCloudBlocked()) return send(res, 503, { error: s.blocked!.reason });
  // Online when Comfy Cloud answers. Named "Comfy Cloud", not by the card it runs jobs on: it's Comfy's servers, paid with
  // your Comfy plan, and a GPU's name here read as one of your own.
  const stats = (await fetch(`${CLOUD}/api/system_stats`, { signal: AbortSignal.timeout(10_000), cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)) as { system?: { comfyui_version?: string } } | null;
  if (!stats) return send(res, 503, { error: "Comfy Cloud doesn't answer." });
  s.version = stats.system?.comfyui_version?.replace(/^v/, "") ?? s.version;
  const vram = 96 * 1024 ** 3;
  send(res, 200, {
    system: { os: "posix", ram_total: 192 * 1024 ** 3, ram_free: 192 * 1024 ** 3, comfyui_version: s.version ?? "", python_version: "", pytorch_version: "", embedded_python: false, argv: [] },
    devices: [{ name: "cuda:0 Comfy Cloud : cloud", type: "cuda", index: 0, vram_total: vram, vram_free: vram, torch_vram_total: 0, torch_vram_free: 0 }],
  });
}

/** Which node classes Comfy Cloud has and their modules (its /api/object_info, with your key), kept an hour. */
async function objectInfo(s: State, cls: string, res: http.ServerResponse) {
  if (!s.nodes || Date.now() - s.nodes.at > 3_600_000) {
    const info = (await fetch(`${CLOUD}/api/object_info`, { headers: { "X-API-Key": s.key }, signal: AbortSignal.timeout(60_000), cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)) as Record<string, { python_module?: string }> | null;
    if (info) s.nodes = { at: Date.now(), modules: Object.fromEntries(Object.entries(info).map(([k, v]) => [k, v.python_module ?? null])) };
  }
  const nodes = s.nodes?.modules;
  if (!cls) return send(res, 200, Object.fromEntries(Object.entries(nodes ?? {}).map(([k, v]) => [k, { name: k, python_module: v }])));
  send(res, 200, nodes && cls in nodes ? { [cls]: { name: cls, python_module: nodes[cls] } } : {});
}

/** The graph with every file Crackio uploaded swapped for its asset (`core/ASSET`), the way Comfy API v2 takes inputs. */
function withAssets(value: unknown, uploads: Map<string, Uploaded>): unknown {
  if (typeof value === "string") {
    const up = uploads.get(value);
    return up ? { __type: "core/ASSET", info: { id: up.id, file_path: up.filePath } } : value;
  }
  if (Array.isArray(value)) return value.map((v) => withAssets(v, uploads));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withAssets(v, uploads)]));
  return value;
}

/**
 * An error from Comfy's API, told by its fields: not `instanceof ComfyError`, since the client outlives a code reload and its
 * errors then come from an older copy of the SDK's classes.
 */
function comfyError(err: unknown) {
  const e = err as (Error & { code?: string; httpStatus?: number | null; details?: unknown }) | null;
  return e && typeof e === "object" && (typeof e.httpStatus === "number" || e instanceof ComfyError) ? e : null;
}

/**
 * A refusal that will repeat for every job (no API on a free plan, no credits left, a key it won't take): Comfy Cloud counts
 * as unavailable for an hour, or until the key changes, so pickers and Run on fall back as they do for an offline machine.
 */
function block(s: State, err: unknown) {
  const e = comfyError(err);
  if (!e) return;
  const reason =
    e.httpStatus === 403 && /free tier/i.test(e.message)
      ? "Needs a paid Comfy Cloud plan"
      : e.code === "insufficient_credits" || e.httpStatus === 402
        ? "Out of Comfy credits"
        : e.httpStatus === 401
          ? "Comfy Cloud refused the key"
          : e.httpStatus === 403
            ? "Comfy Cloud refused the job"
            : null;
  if (reason) s.blocked = { reason, until: Date.now() + 3_600_000 };
}

/** Why Comfy Cloud can't take jobs now (shown under Run on), or null. */
export function comfyCloudBlocked(): string | null {
  const b = box.state?.blocked;
  return b && b.until > Date.now() ? b.reason : null;
}

/** What Comfy Cloud said, as ComfyUI's /prompt says it (Crackio shows the message and the node). */
function refusal(err: unknown) {
  const e = err as ComfyError & { code?: string; details?: unknown; httpStatus?: number | null };
  const status = comfyError(err) ? (e.httpStatus ?? 400) : 502;
  const hint =
    e.code === "insufficient_credits"
      ? "Your Comfy credits ran out: top up at platform.comfy.org."
      : status === 429
        ? "Comfy Cloud is busy, or your plan has no API access (Standard or higher)."
        : status === 401
          ? "Comfy Cloud refused the key."
          : status === 403 && /free tier/i.test(e.message)
            ? "Running jobs needs a paid Comfy Cloud plan, Standard or higher (comfy.org/cloud/pricing)."
            : "";
  return { status, body: { error: { message: `${e.message}${hint ? ` ${hint}` : ""}`, details: e.details ? JSON.stringify(e.details).slice(0, 400) : "" }, node_errors: {} } };
}

async function prompt(s: State, body: { prompt?: unknown; prompt_id?: string; extra_data?: unknown }, res: http.ServerResponse) {
  if (!body.prompt || typeof body.prompt !== "object") return send(res, 400, { error: { message: "No workflow." }, node_errors: {} });
  const promptId = body.prompt_id ?? randomUUID();
  if (s.jobs.has(promptId)) return send(res, 200, { prompt_id: promptId, number: s.jobs.get(promptId)!.number, node_errors: {} });
  const graph = withAssets(body.prompt, s.uploads) as Record<string, unknown>;
  const job: CloudJob = { promptId, number: ++s.counter, graph: body.prompt, extra: body.extra_data ?? {}, state: "pending" };
  s.jobs.set(promptId, job);
  try {
    job.job = await s.client.submit(s.client.workflows.fromJson(graph), { idempotencyKey: promptId });
  } catch (err) {
    s.jobs.delete(promptId);
    block(s, err);
    // Inputs Comfy Cloud no longer has are forgotten, so the next try sends them again.
    const missing = ((err as { details?: { missing_ids?: string[] } }).details?.missing_ids ?? []) as string[];
    for (const [name, up] of s.uploads) if (missing.includes(up.id)) s.uploads.delete(name);
    const r = refusal(err);
    return send(res, r.status, r.body);
  }
  void follow(s, job);
  send(res, 200, { prompt_id: promptId, number: job.number, node_errors: {} });
}

async function follow(s: State, j: CloudJob) {
  const job = j.job!;
  try {
    for (let misses = 0; ; ) {
      await new Promise((r) => setTimeout(r, 1500));
      try {
        await job.refresh();
        misses = 0;
      } catch (err) {
        if (++misses >= 40) throw err;
        continue;
      }
      if (job.status === "running" || job.status === "canceling") {
        j.state = "running";
        const p = job.progress;
        if (p) {
          const steps = p.steps && p.step != null ? { value: p.step, max: p.steps } : { value: Math.round(p.value * 100), max: 100 };
          broadcast(s.sockets, { type: "progress", data: { prompt_id: j.promptId, node: p.currentNode ?? "", ...steps } });
        }
      }
      if (!["queued", "running", "canceling"].includes(job.status)) break;
    }
    j.startedAt = job.startedAt?.getTime();
    j.completedAt = job.completedAt?.getTime();
    j.executionMs = job.metrics?.execution_ms ?? (j.startedAt && j.completedAt ? j.completedAt - j.startedAt : undefined);
    j.queueMs = job.metrics?.queue_ms ?? undefined;
    if (job.status !== "succeeded") {
      j.state = "error";
      j.error = job.status === "canceled" ? { message: "Cancelled." } : { message: job.error?.message ?? `The job ended ${job.status}.`, node: job.error?.node_id ?? undefined, type: job.error?.class_type ?? undefined };
      return;
    }
    const outputs: CloudJob["outputs"] = {};
    for (const o of job.outputs) {
      const name = o.name.replace(/\\/g, "/");
      const filename = path.posix.basename(name);
      const subfolder = path.posix.dirname(name) === "." ? "" : path.posix.dirname(name);
      s.outputs.set(subfolder ? `${subfolder}/${filename}` : filename, o);
      (outputs[o.nodeId || "0"] ??= { images: [] }).images.push({ filename, subfolder, type: "output" });
    }
    j.outputs = outputs;
    j.state = "done";
  } catch (err) {
    j.state = "error";
    j.error = { message: (err as Error).message };
  } finally {
    setTimeout(() => {
      s.jobs.delete(j.promptId);
      for (const imgs of Object.values(j.outputs ?? {})) for (const f of imgs.images) s.outputs.delete(f.subfolder ? `${f.subfolder}/${f.filename}` : f.filename);
    }, 3_600_000).unref();
  }
}

function stop(s: State, id: string) {
  const j = s.jobs.get(id);
  if (!j || j.state === "done" || j.state === "error") return;
  void j.job?.cancel().catch(() => undefined);
  j.state = "error";
  j.error = { message: "Cancelled." };
}

const entry = (j: CloudJob) => [j.number, j.promptId, j.graph, j.extra, []];

function queue(s: State) {
  const jobs = [...s.jobs.values()].sort((a, b) => a.number - b.number);
  return { queue_running: jobs.filter((j) => j.state === "running").map(entry), queue_pending: jobs.filter((j) => j.state === "pending").map(entry) };
}

/** A finished job as ComfyUI's /history tells it, with the GPU time Comfy Cloud ran it for (`crackio_comfy_cloud`). */
function history(j: CloudJob) {
  const billing = ["crackio_comfy_cloud", { executionMs: j.executionMs ?? 0, queueMs: j.queueMs ?? 0, credits: Math.round((j.executionMs ?? 0) * CREDITS_PER_MS * 100) / 100 }];
  const timing = j.startedAt && j.completedAt ? [["execution_start", { timestamp: j.startedAt }], ["execution_success", { timestamp: j.completedAt }]] : [];
  const failed = j.state === "error";
  return {
    [j.promptId]: {
      prompt: entry(j),
      outputs: failed ? {} : (j.outputs ?? {}),
      status: {
        status_str: failed ? "error" : "success",
        completed: !failed,
        messages: failed ? [["execution_error", { node_type: j.error?.type ?? "Comfy Cloud", node_id: j.error?.node, exception_message: j.error?.message ?? "failed" }], billing] : [...timing, billing],
      },
    },
  };
}

async function upload(s: State, req: http.IncomingMessage, res: http.ServerResponse) {
  const form = await new Request("http://cloud/upload/image", {
    method: "POST",
    headers: req.headers as Record<string, string>,
    body: Readable.toWeb(req) as ReadableStream,
    duplex: "half",
  } as RequestInit & { duplex: "half" }).formData();
  const file = form.get("image");
  if (!(file instanceof Blob)) return send(res, 400, { error: "No file." });
  const filename = path.basename((file as File).name || "upload.bin");
  const subfolder = String(form.get("subfolder") ?? "").replace(/^\/+|\/+$/g, "");
  const asset = s.client.assets.fromBytes(new Uint8Array(await file.arrayBuffer()), { filename, contentType: file.type || undefined });
  try {
    const id = await asset.commit();
    s.uploads.set(subfolder ? `${subfolder}/${filename}` : filename, { id, filePath: asset.filePath, seen: Date.now() });
  } catch (err) {
    block(s, err);
    const r = refusal(err);
    return send(res, r.status, r.body);
  }
  send(res, 200, { name: filename, subfolder, type: "input" });
}

/**
 * Whether an input is still on Comfy Cloud (Crackio asks before sending the same file again): looked at there at most every
 * 10 minutes, since assets expire. One that's gone is forgotten, so it goes up again.
 */
async function stillThere(s: State, name: string) {
  const up = s.uploads.get(name);
  if (!up) return false;
  if (Date.now() - up.seen < 10 * 60_000) return true;
  const ok = await s.client.assets.get(up.id).then(() => true, (err) => comfyError(err)?.httpStatus !== 404);
  if (ok) up.seen = Date.now();
  else s.uploads.delete(name);
  return ok;
}

async function view(s: State, url: URL, req: http.IncomingMessage, res: http.ServerResponse) {
  const sub = (url.searchParams.get("subfolder") ?? "").replace(/^\/+|\/+$/g, "");
  const name = sub ? `${sub}/${url.searchParams.get("filename") ?? ""}` : (url.searchParams.get("filename") ?? "");
  if ((url.searchParams.get("type") ?? "output") === "input") return send(res, (await stillThere(s, name)) ? 200 : 404, {});
  const out = s.outputs.get(name);
  if (!out) return send(res, 404, { error: "not found" });
  // A signed link of Comfy's: fetched without the key, with the range asked for.
  const { url: signed } = await out.getDownloadUrl();
  const range = req.headers.range;
  const up = await fetch(signed, { method: req.method === "HEAD" ? "HEAD" : "GET", headers: range ? { Range: range } : {} });
  const headers: Record<string, string> = { "content-type": out.contentType || "application/octet-stream", "accept-ranges": "bytes", "cache-control": "no-store" };
  for (const h of ["content-length", "content-range"]) {
    const v = up.headers.get(h);
    if (v) headers[h] = v;
  }
  res.writeHead(up.status, headers);
  if (req.method === "HEAD" || !up.body) return res.end();
  Readable.fromWeb(up.body as import("node:stream/web").ReadableStream).pipe(res);
}
