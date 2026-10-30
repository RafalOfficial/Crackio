import "server-only";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { DATA_DIR } from "../paths";
import { hasObject, presign, putObject, r2 } from "./r2";
import { cancel, health, status, submit, type JobStatus, type ServerlessEndpoint } from "./runpod";
import { acceptSocket, broadcast } from "./ws";

/**
 * A RunPod Serverless endpoint, seen by the rest of Crackio as one more ComfyUI. A small server on this computer speaks the
 * part of ComfyUI's HTTP API Crackio uses (/prompt, /queue, /history, /upload/image, /view, /object_info, /models,
 * /system_stats), and each graph queued on it becomes one RunPod job running the same graph on Crackio's worker
 * (serverless/worker). Inputs go up to R2 and down to the worker by signed links; results come back the same way. So
 * every tool, multi-step ones too, and recipes and the Library work as they do on your own ComfyUI.
 *
 * It listens on 127.0.0.2, not 127.0.0.1: Crackio counts a ComfyUI on 127.0.0.1 as this computer's own.
 */

const HOST = "127.0.0.2";
/**
 * Bumped when this server or what it calls changes: one started by older code (it outlives a code reload, and keeps
 * calling that code) is closed and started again.
 */
const VERSION = 3;
const OUTPUT_SLOTS = 32;
/** How long a list of what the endpoint holds is trusted at start-up before it's asked again. */
const MANIFEST_FRESH_MS = 6 * 3_600_000;
const INLINE_LIMIT = 8 * 1024 * 1024;
const LINK_SECONDS = 6 * 3600;

type Kept = { key?: string; data?: Buffer; mime: string; bytes: number };
type WorkerOutput = {
  prompt_id?: string;
  status?: { status_str?: string; completed?: boolean; messages?: [string, Record<string, unknown>][] };
  outputs?: Record<string, Record<string, unknown>>;
  files_out?: { node: string; key: string; filename: string; subfolder: string; bytes: number; slot?: number; b64?: string }[];
  files?: Manifest["files"];
  gpu?: { name?: string | null; vram?: number | null };
  comfyui?: string | null;
  warm?: boolean;
  error?: { kind?: string; status?: number; body?: string };
};
type Job = {
  promptId: string;
  number: number;
  graph: unknown;
  extra: unknown;
  runpodId?: string;
  state: "pending" | "running" | "done" | "error";
  status?: JobStatus;
  result?: WorkerOutput;
  error?: string;
  at: number;
};
type Manifest = { files: { folder: string; name: string; bytes: number }[]; nodes?: Record<string, string | null>; gpu?: { name?: string | null; vram?: number | null }; comfyui?: string | null; at: number };
type State = {
  ep: ServerlessEndpoint;
  uploads: Map<string, Kept>;
  outputs: Map<string, Kept>;
  jobs: Map<string, Job>;
  counter: number;
  manifest: Manifest | null;
  listing: Promise<void> | null;
  health: { at: number; ok: boolean } | null;
  /** Open /ws connections (Crackio's progress bar), told each job's step progress. */
  sockets?: Set<import("node:net").Socket>;
  server?: http.Server;
  port?: number;
  version?: number;
};

const g = globalThis as unknown as { __crackioShims?: Map<string, State>; __crackioShimStarts?: Map<string, Promise<State>> };
const states = (g.__crackioShims ??= new Map());
const starts = (g.__crackioShimStarts ??= new Map());

const manifestFile = (ep: ServerlessEndpoint) => path.join(DATA_DIR, "serverless", `${ep.endpointId.replace(/[^\w-]/g, "")}.json`);
const portFor = (id: string) => 39_100 + (createHash("sha1").update(id).digest().readUInt16BE(0) % 400);

/** The local address that stands for this endpoint's ComfyUI, its server started on first use. */
export async function shimFor(ep: ServerlessEndpoint): Promise<{ url: string }> {
  let start = starts.get(ep.endpointId);
  const running = start ? await start.catch(() => null) : null;
  if (!running || running.version !== VERSION || running.ep.apiKey !== ep.apiKey) {
    if (running?.server) {
      running.server.closeAllConnections();
      running.server.close();
      await new Promise((r) => setTimeout(r, 150));
    }
    start = launch(ep);
    starts.set(ep.endpointId, start);
    start.catch(() => starts.delete(ep.endpointId));
  }
  const s = await start!;
  return { url: `http://${HOST}:${s.port}` };
}

async function launch(ep: ServerlessEndpoint): Promise<State> {
  const s: State = states.get(ep.endpointId) ?? { ep, uploads: new Map(), outputs: new Map(), jobs: new Map(), counter: 0, manifest: null, listing: null, health: null };
  s.ep = ep;
  states.set(ep.endpointId, s);
  if (!s.manifest) s.manifest = (await fs.readFile(manifestFile(ep), "utf8").then((t) => JSON.parse(t) as Manifest).catch(() => null)) ?? null;
  // Never listed (a fresh data folder), or listed more than 6 hours ago: asked now, in the background (an older list keeps
  // answering meanwhile), so its models show up without anyone opening a picker first. A recent one is used as it is: a
  // live demo starts a Crackio per visitor, and a list job each time would cost a cold start.
  if (!s.manifest || Date.now() - (s.manifest.at ?? 0) > MANIFEST_FRESH_MS) void manifest(s, false, true);
  const server = http.createServer((req, res) => void handle(s, req, res).catch((err) => send(res, 500, { error: { message: (err as Error).message } })));
  server.on("upgrade", (req, socket) => acceptSocket((s.sockets ??= new Set()), req, socket as import("node:net").Socket));
  // One Crackio per demo code means many on one host: each takes the next free port.
  for (let port = portFor(ep.endpointId), tries = 0; tries < 400; port++, tries++) {
    const ok = await new Promise<boolean>((resolve) => {
      const fail = () => resolve(false);
      server.once("error", fail);
      server.listen(port, HOST, () => {
        server.off("error", fail);
        resolve(true);
      });
    });
    if (ok) {
      Object.assign(s, { server, port, version: VERSION });
      return s;
    }
  }
  throw new Error("No free port for the serverless endpoint.");
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
  const url = new URL(req.url ?? "/", "http://shim");
  const route = url.pathname.replace(/^\/api(?=\/)/, "");
  const method = req.method ?? "GET";
  if (route === "/system_stats") return systemStats(s, res);
  if (route === "/prompt" && method === "POST") return prompt(s, JSON.parse((await readBody(req)).toString("utf8") || "{}"), res);
  if (route === "/queue" && method === "GET") return send(res, 200, queue(s));
  if ((route === "/queue" || route === "/interrupt") && method === "POST") {
    const body = JSON.parse((await readBody(req)).toString("utf8") || "{}") as { delete?: string[]; prompt_id?: string; clear?: boolean };
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
  if (route === "/models") return send(res, 200, [...new Set((await manifest(s))?.files.map((f) => f.folder) ?? [])]);
  if (route.startsWith("/models/")) {
    const folder = decodeURIComponent(route.slice("/models/".length));
    return send(res, 200, ((await manifest(s))?.files ?? []).filter((f) => f.folder === folder).map((f) => f.name));
  }
  if (route === "/" || route === "/index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    return res.end(
      `<!doctype html><meta charset="utf-8"><body style="margin:0;display:grid;place-items:center;height:100vh;background:#16131b;color:#c9c3d3;font:14px system-ui;text-align:center"><p>${s.ep.label.replace(/</g, "&lt;")} runs ComfyUI on RunPod Serverless: a GPU starts for each job and stops after.<br>It has no live interface to show; a take's graph opens in the ComfyUI on your own machines.</p></body>`,
    );
  }
  return send(res, 404, { error: "not here" });
}

/** Whether the endpoint answers (RunPod's health, free), looked at once a minute. */
async function healthy(s: State) {
  if (s.health && Date.now() - s.health.at < 60_000) return s.health.ok;
  const ok = await health(s.ep).then(() => true).catch(() => false);
  s.health = { at: Date.now(), ok };
  return ok;
}

async function systemStats(s: State, res: http.ServerResponse) {
  if (!(await healthy(s))) return send(res, 503, { error: "RunPod doesn't answer for this endpoint." });
  const m = s.manifest;
  const vram = m?.gpu?.vram ?? 48 * 1024 ** 3;
  send(res, 200, {
    system: { os: "posix", ram_total: 64 * 1024 ** 3, ram_free: 64 * 1024 ** 3, comfyui_version: m?.comfyui ?? "0.42.1", python_version: "", pytorch_version: "", embedded_python: false, argv: [] },
    devices: [{ name: `cuda:0 ${m?.gpu?.name ?? "RunPod GPU"} : runpod`, type: "cuda", index: 0, vram_total: vram, vram_free: vram, torch_vram_total: 0, torch_vram_free: 0 }],
  });
}

/** What the endpoint's worker holds (files, nodes, GPU): from its last answer, else asked once with a "list" job. */
async function manifest(s: State, wait = false, refresh = false) {
  if ((!s.manifest || refresh) && !s.listing) {
    s.listing = (async () => {
      const sent = await submit(s.ep, { action: "list" }, 10 * 60_000);
      const done = await settle(s, sent.id);
      if (done.status === "COMPLETED") remember(s, done.output as WorkerOutput & Manifest);
    })()
      .catch((err) => console.warn(`[serverless] couldn't list ${s.ep.label}: ${(err as Error).message}`))
      .finally(() => void (s.listing = null));
  }
  if (wait && s.listing) await s.listing;
  return s.manifest;
}

/** Keeps what a worker's answer says it holds (every job's answer carries it). */
function remember(s: State, out: Partial<Manifest> & { files?: Manifest["files"] }) {
  const next: Manifest = {
    files: out.files ?? s.manifest?.files ?? [],
    nodes: out.nodes ?? s.manifest?.nodes,
    gpu: out.gpu?.name ? out.gpu : s.manifest?.gpu,
    comfyui: out.comfyui ?? s.manifest?.comfyui,
    at: Date.now(),
  };
  s.manifest = next;
  const file = manifestFile(s.ep);
  void fs.mkdir(path.dirname(file), { recursive: true }).then(() => fs.writeFile(file, JSON.stringify(next)));
}

async function settle(s: State, id: string, onStatus?: (st: JobStatus) => void): Promise<JobStatus> {
  for (let misses = 0; ; ) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const st = await status(s.ep, id);
      misses = 0;
      onStatus?.(st);
      if (!["IN_QUEUE", "IN_PROGRESS"].includes(st.status)) return st;
    } catch (err) {
      if (++misses >= 30) throw err;
    }
  }
}

function objectInfo(s: State, cls: string, res: http.ServerResponse) {
  const nodes = s.manifest?.nodes;
  if (!nodes) void manifest(s);
  if (!cls) return send(res, 200, Object.fromEntries(Object.entries(nodes ?? {}).map(([k, v]) => [k, { name: k, python_module: v }])));
  send(res, 200, nodes && cls in nodes ? { [cls]: { name: cls, python_module: nodes[cls] } } : {});
}

/** Every string in a graph (a file name the worker needs is one of them). */
function strings(value: unknown, out = new Set<string>()) {
  if (typeof value === "string") out.add(value);
  else if (Array.isArray(value)) value.forEach((v) => strings(v, out));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => strings(v, out));
  return out;
}

async function prompt(s: State, body: { prompt?: unknown; prompt_id?: string; extra_data?: unknown }, res: http.ServerResponse) {
  if (!body.prompt || typeof body.prompt !== "object") return send(res, 400, { error: { message: "No workflow." }, node_errors: {} });
  const cfg = r2();
  const promptId = body.prompt_id ?? randomUUID();
  if (s.jobs.has(promptId)) return send(res, 200, { prompt_id: promptId, number: s.jobs.get(promptId)!.number, node_errors: {} });
  const used = strings(body.prompt);
  const inputs: { name: string; url?: string; b64?: string }[] = [];
  let inline = 0;
  for (const [name, kept] of s.uploads) {
    if (!used.has(name)) continue;
    if (kept.key && cfg) inputs.push({ name, url: presign(cfg, "GET", kept.key, LINK_SECONDS) });
    else if (kept.data) {
      inline += kept.data.length;
      inputs.push({ name, b64: kept.data.toString("base64") });
    }
  }
  if (inline > INLINE_LIMIT) return send(res, 400, { error: { message: "These inputs are too big to send without R2.", details: "Set R2_ENDPOINT, R2_BUCKET and its keys." }, node_errors: {} });
  const outputs = cfg ? Array.from({ length: OUTPUT_SLOTS }, (_, i) => presign(cfg, "PUT", `out/${promptId}/${i}`, LINK_SECONDS)) : [];
  const job: Job = { promptId, number: ++s.counter, graph: body.prompt, extra: body.extra_data ?? {}, state: "pending", at: Date.now() };
  s.jobs.set(promptId, job);
  try {
    const sent = await submit(s.ep, { action: "run", graph: body.prompt, prompt_id: promptId, inputs, outputs });
    job.runpodId = sent.id;
  } catch (err) {
    s.jobs.delete(promptId);
    return send(res, 502, { error: { message: (err as Error).message }, node_errors: {} });
  }
  void follow(s, job);
  send(res, 200, { prompt_id: promptId, number: job.number, node_errors: {} });
}

async function follow(s: State, job: Job) {
  try {
    const st = await settle(s, job.runpodId!, (now) => {
      job.status = now;
      if (now.status === "IN_PROGRESS" && job.state === "pending") job.state = "running";
      const p = now.status === "IN_PROGRESS" ? progressOf(now.output) : null;
      if (p) broadcast(s.sockets, { type: "progress", data: { prompt_id: job.promptId, ...p } });
    });
    job.status = st;
    const out = (st.output ?? {}) as WorkerOutput;
    if (st.status !== "COMPLETED") {
      job.state = "error";
      job.error = st.status === "CANCELLED" ? "Cancelled." : st.status === "TIMED_OUT" ? "The job ran past the endpoint's time limit." : `The worker failed: ${String(st.error ?? "no reason given").slice(0, 500)}`;
      return;
    }
    remember(s, { files: out.files, gpu: out.gpu, comfyui: out.comfyui });
    if (out.error) {
      job.state = "error";
      job.error = `ComfyUI on RunPod refused the workflow (${out.error.status ?? out.error.kind}): ${(out.error.body ?? "").slice(0, 600)}`;
      return;
    }
    for (const f of out.files_out ?? []) {
      const name = f.subfolder ? `${f.subfolder}/${f.filename}` : f.filename;
      const mime = mimeOf(f.filename);
      if (typeof f.slot === "number") s.outputs.set(name, { key: `out/${job.promptId}/${f.slot}`, mime, bytes: f.bytes });
      else if (f.b64) s.outputs.set(name, { data: Buffer.from(f.b64, "base64"), mime, bytes: f.bytes });
    }
    job.result = out;
    job.state = out.status?.status_str === "error" ? "error" : "done";
    if (job.state === "error") job.error = "ComfyUI on RunPod failed.";
  } catch (err) {
    job.state = "error";
    job.error = (err as Error).message;
  } finally {
    // Jobs and what they made are forgotten after an hour (Crackio downloads results as soon as a job finishes).
    setTimeout(() => {
      s.jobs.delete(job.promptId);
      for (const f of job.result?.files_out ?? []) s.outputs.delete(f.subfolder ? `${f.subfolder}/${f.filename}` : f.filename);
    }, 3_600_000).unref();
  }
}

/** The worker's last step update (handler `progress_update`), as RunPod's status carries it while a job runs. */
function progressOf(output: unknown): { node: string; value: number; max: number } | null {
  let o = output;
  if (typeof o === "string") {
    try {
      o = JSON.parse(o);
    } catch {
      return null;
    }
  }
  const p = o as { node?: unknown; value?: unknown; max?: unknown } | null;
  return p && typeof p.value === "number" && typeof p.max === "number" && p.max > 0 ? { node: String(p.node ?? ""), value: p.value, max: p.max } : null;
}

function stop(s: State, id: string) {
  const job = s.jobs.get(id);
  if (!job || job.state === "done" || job.state === "error") return;
  if (job.runpodId) void cancel(s.ep, job.runpodId);
  job.state = "error";
  job.error = "Cancelled.";
}

const entry = (j: Job) => [j.number, j.promptId, j.graph, j.extra, []];

function queue(s: State) {
  const jobs = [...s.jobs.values()].sort((a, b) => a.number - b.number);
  return { queue_running: jobs.filter((j) => j.state === "running").map(entry), queue_pending: jobs.filter((j) => j.state === "pending").map(entry) };
}

/** A finished job as ComfyUI's /history tells it, with what RunPod billed for it (`crackio_serverless`). */
function history(j: Job) {
  const billing = ["crackio_serverless", { executionTime: j.status?.executionTime ?? 0, delayTime: j.status?.delayTime ?? 0, gpu: j.result?.gpu?.name ?? null, warm: j.result?.warm ?? null }];
  const messages = j.result?.status?.messages ?? [];
  const failed = j.state === "error";
  return {
    [j.promptId]: {
      prompt: entry(j),
      outputs: failed ? {} : (j.result?.outputs ?? {}),
      status: {
        status_str: failed ? "error" : "success",
        completed: !failed,
        messages: failed && !messages.some(([k]) => k === "execution_error") ? [...messages, ["execution_error", { node_type: "RunPod", exception_message: j.error ?? "failed" }], billing] : [...messages, billing],
      },
    },
  };
}

const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".wav": "audio/wav", ".flac": "audio/flac", ".mp3": "audio/mpeg" };
const mimeOf = (name: string) => MIME[path.extname(name).toLowerCase()] ?? "application/octet-stream";

async function upload(s: State, req: http.IncomingMessage, res: http.ServerResponse) {
  const form = await new Request("http://shim/upload/image", {
    method: "POST",
    headers: req.headers as Record<string, string>,
    body: Readable.toWeb(req) as ReadableStream,
    duplex: "half",
  } as RequestInit & { duplex: "half" }).formData();
  const file = form.get("image");
  if (!(file instanceof Blob)) return send(res, 400, { error: "No file." });
  const filename = path.basename((file as File).name || "upload.bin");
  const subfolder = String(form.get("subfolder") ?? "").replace(/^\/+|\/+$/g, "");
  const data = Buffer.from(await file.arrayBuffer());
  const mime = mimeOf(filename);
  const name = subfolder ? `${subfolder}/${filename}` : filename;
  const cfg = r2();
  if (cfg) {
    const key = `in/${createHash("sha256").update(data).digest("hex")}${path.extname(filename).toLowerCase()}`;
    if (!(await hasObject(cfg, key))) await putObject(cfg, key, data, mime);
    s.uploads.set(name, { key, mime, bytes: data.length });
  } else s.uploads.set(name, { data, mime, bytes: data.length });
  send(res, 200, { name: filename, subfolder, type: "input" });
}

async function view(s: State, url: URL, req: http.IncomingMessage, res: http.ServerResponse) {
  const sub = (url.searchParams.get("subfolder") ?? "").replace(/^\/+|\/+$/g, "");
  const name = sub ? `${sub}/${url.searchParams.get("filename") ?? ""}` : (url.searchParams.get("filename") ?? "");
  const kept = (url.searchParams.get("type") ?? "output") === "input" ? s.uploads.get(name) : s.outputs.get(name);
  if (!kept) return send(res, 404, { error: "not found" });
  const range = req.headers.range;
  const cfg = r2();
  if (kept.key && cfg) {
    const up = await fetch(presign(cfg, req.method === "HEAD" ? "HEAD" : "GET", kept.key, 600), { method: req.method === "HEAD" ? "HEAD" : "GET", headers: range ? { Range: range } : {} });
    const headers: Record<string, string> = { "content-type": kept.mime, "accept-ranges": "bytes", "cache-control": "no-store" };
    for (const h of ["content-length", "content-range"]) {
      const v = up.headers.get(h);
      if (v) headers[h] = v;
    }
    res.writeHead(up.status, headers);
    if (req.method === "HEAD" || !up.body) return res.end();
    return void Readable.fromWeb(up.body as import("node:stream/web").ReadableStream).pipe(res);
  }
  const data = kept.data ?? Buffer.alloc(0);
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null;
  if (m) {
    const start = m[1] ? Number(m[1]) : Math.max(0, data.length - Number(m[2]));
    const end = m[1] && m[2] ? Math.min(Number(m[2]), data.length - 1) : data.length - 1;
    res.writeHead(206, { "content-type": kept.mime, "content-range": `bytes ${start}-${end}/${data.length}`, "content-length": String(end - start + 1), "accept-ranges": "bytes" });
    return res.end(req.method === "HEAD" ? undefined : data.subarray(start, end + 1));
  }
  res.writeHead(200, { "content-type": kept.mime, "content-length": String(data.length), "accept-ranges": "bytes" });
  res.end(req.method === "HEAD" ? undefined : data);
}

/** For Connections: the endpoint's state and what its worker holds. */
export async function serverlessInfo(ep: ServerlessEndpoint, refresh = false) {
  await shimFor(ep);
  const s = states.get(ep.endpointId)!;
  if (refresh) s.manifest = null;
  const ok = await healthy(s);
  return { ok, manifest: await manifest(s, refresh), jobs: s.jobs.size };
}

/** Model files into the endpoint's volume (one "fetch" job): Crackio's catalog says where each comes from. */
export async function fetchModels(ep: ServerlessEndpoint, files: { url: string; folder: string; name: string; bytes?: number }[]) {
  await shimFor(ep);
  const s = states.get(ep.endpointId)!;
  const sent = await submit(ep, { action: "fetch", files }, 60 * 60_000);
  const done = await settle(s, sent.id);
  if (done.status === "COMPLETED") remember(s, done.output as WorkerOutput & Manifest);
  return done;
}
