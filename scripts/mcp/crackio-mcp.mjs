#!/usr/bin/env node
/**
 * Crackio's MCP program: what an agent CLI (Claude Code, Codex, Cursor, Grok, OpenCode, Gemini CLI…) starts to use
 * Crackio. It speaks MCP over stdin/stdout and passes every call to the Crackio that's running (its /api/agent), so the
 * tools themselves live in Crackio and are always the ones that version has.
 *
 * What it does itself:
 *  - finds Crackio: CRACKIO_URL, else the address Crackio wrote to ~/.crackio/server.json, else this computer's usual ports;
 *  - turns local file paths in a call into uploads, and the files in an answer into local paths the agent can open
 *    (on the same computer they're Crackio's own files; from another computer they're downloaded to ~/Crackio/agent);
 *  - hands previews to the agent's model as pictures;
 *  - says plainly when Crackio isn't running or is busy restarting, in the same error shape every Crackio tool uses.
 *
 * Plain Node (18 or newer), no packages: `node crackio-mcp.mjs`. `--check` prints whether Crackio answers and exits.
 * It speaks both MCP eras: the 2026-07-28 revision (no handshake, version on every request) and the earlier ones
 * that start with `initialize`.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const MODERN = "2026-07-28";
const LEGACY = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const META = "io.modelcontextprotocol/";
const HOME = path.join(os.homedir(), ".crackio");
const SAVED = process.env.CRACKIO_FILES || path.join(os.homedir(), "Crackio", "agent");
const NO_IMAGES = process.env.CRACKIO_NO_IMAGES === "1";

const log = (...a) => process.stderr.write(`[crackio-mcp] ${a.join(" ")}\n`);
const slash = (p) => p.replace(/\\/g, "/");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ errors (the shape of src/lib/agent/errors.ts) */

const notRunning = (tried) => ({
  code: "crackio_not_running",
  what: "Crackio isn't running.",
  why: `Nothing answered at ${tried.join(", ")}.`,
  do: "Ask the user to start Crackio (double-click Start Crackio, or run `pnpm dev` in its folder), then call status. If it runs somewhere else, set CRACKIO_URL in this MCP server's settings.",
  retry: true,
  ask_user: true,
});
const restarting = (why) => ({ code: "crackio_restarting", what: "Crackio is busy restarting.", why, do: "Wait 10 seconds and call again.", retry: true, ask_user: false });
const lostAnswer = (tool) => ({
  code: "crackio_restarting",
  what: "Crackio stopped answering in the middle of this call.",
  why: "It may be restarting. The call may or may not have started a job.",
  do: `Wait 10 seconds, then call jobs to see whether a job started before you run ${tool} again.`,
  retry: true,
  ask_user: false,
});
const localFail = (code, what, extra = {}) => ({ code, what, retry: false, ask_user: false, ...extra });

class ToolFailure extends Error {
  constructor(failure) {
    super(failure.what);
    this.failure = failure;
  }
}

/* ------------------------------------------------------------------ finding Crackio */

let base = null; // the address that last answered
let everUp = false;
let door = null; // { at, value }
let sameDisk = null; // null: unknown; string: Crackio's data folder on this computer; false: another computer

function candidates() {
  const list = [];
  const add = (u) => {
    const clean = String(u || "").trim().replace(/\/+$/, "");
    if (clean && !list.includes(clean)) list.push(clean);
  };
  add(process.env.CRACKIO_URL);
  if (base) add(base);
  try {
    const noted = JSON.parse(fs.readFileSync(path.join(HOME, "server.json"), "utf8"));
    for (const s of [...(noted.servers ?? [])].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))) add(s.url);
  } catch {
    // Crackio hasn't written its address (an older one, or it never ran): the usual ports below.
  }
  if (!process.env.CRACKIO_URL) {
    if (process.env.CRACKIO_PORT) add(`http://127.0.0.1:${process.env.CRACKIO_PORT}`);
    add("http://127.0.0.1:3211"); // Start Crackio
    add("http://127.0.0.1:3210"); // pnpm dev -p 3210
    add("http://127.0.0.1:3000"); // pnpm dev
  }
  return list;
}

async function getJson(url, { timeoutMs = 4000, ...init } = {}) {
  const res = await fetch(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Not JSON: Next's error page while a file doesn't compile, or something that isn't Crackio.
  }
  return { status: res.status, json, text };
}

/** Crackio's tool list and instructions, from the first address that answers as Crackio. Throws a ToolFailure otherwise. */
async function getDoor(force = false) {
  if (!force && door && Date.now() - door.at < 30_000) return door.value;
  const tried = candidates();
  let busy = null;
  for (const url of tried) {
    try {
      // The first ask after a start compiles the route: give the address we know more time than a guess.
      const { status, json } = await getJson(`${url}/api/agent`, { timeoutMs: url === base || url === process.env.CRACKIO_URL?.replace(/\/+$/, "") ? 20_000 : 3000 });
      if (json?.name === "crackio" && Array.isArray(json.tools)) {
        if (base !== url) sameDisk = null;
        base = url;
        everUp = true;
        door = { at: Date.now(), value: json };
        rememberDoor(json);
        return json;
      }
      if (status >= 500 || status === 404) busy = `${url} answered ${status}: it's starting up or recompiling.`;
    } catch (err) {
      if (err?.name === "TimeoutError" && (url === base || everUp)) busy = `${url} didn't answer in time.`;
    }
  }
  door = null;
  throw new ToolFailure(busy || everUp ? restarting(busy ?? "It answered a moment ago and doesn't now.") : notRunning(tried));
}

/** The last tool list seen, kept on disk: an agent that connects while Crackio is off still sees the tools. */
const doorFile = path.join(HOME, "door.json");
function rememberDoor(value) {
  try {
    // Not this computer's folder or mark, nor a switch the user may have flipped since.
    const text = JSON.stringify({ ...value, dataDir: undefined, instance: undefined, off: undefined });
    if (fs.existsSync(doorFile) && fs.readFileSync(doorFile, "utf8") === text) return;
    fs.mkdirSync(HOME, { recursive: true });
    fs.writeFileSync(doorFile, text);
  } catch {
    // Only a convenience.
  }
}
function rememberedDoor() {
  try {
    const v = JSON.parse(fs.readFileSync(doorFile, "utf8"));
    if (Array.isArray(v.tools)) return v;
  } catch {
    // None yet.
  }
  return null;
}

const FALLBACK = {
  name: "crackio",
  title: "Crackio",
  version: "0",
  instructions: "Crackio is the user's own AI studio (pictures, clips, voices, edits on their own GPUs). It isn't running right now: call status to see how to start it.",
  tools: [{ name: "status", title: "Crackio status", description: "Start here: whether Crackio is running, and its machines.", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }],
};

async function doorOrRemembered() {
  try {
    return await getDoor();
  } catch {
    return rememberedDoor() ?? FALLBACK;
  }
}

/** Crackio's data folder when it's on this computer's disk (its mark there matches the server's), else false. */
function dataDir(d) {
  if (sameDisk !== null) return sameDisk;
  sameDisk = false;
  try {
    if (d?.dataDir && JSON.parse(fs.readFileSync(path.join(d.dataDir, "cache", "agent", "instance.json"), "utf8")).id === d.instance) sameDisk = d.dataDir;
  } catch {
    // Another computer's Crackio.
  }
  return sameDisk;
}

/* ------------------------------------------------------------------ files in: local paths become Crackio files */

const MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", avif: "image/avif", bmp: "image/bmp", mp4: "video/mp4", m4v: "video/x-m4v", webm: "video/webm", mov: "video/quicktime", mkv: "video/x-matroska", mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", aac: "audio/aac", ogg: "audio/ogg", flac: "audio/flac", opus: "audio/opus" };
const uploaded = new Map(); // "path|size|mtime" -> Crackio address
const savedAs = new Map(); // a downloaded copy's path -> the Crackio address it came from

const MEDIA_URL = /^\/api\/media\/(out|uploads|templates)\/[^?#\s]+$/;

async function upload(file, field) {
  const st = await fsp.stat(file).catch(() => null);
  if (!st?.isFile()) throw new ToolFailure(localFail("file_not_found", `There's no file at ${slash(file)}.`, { field, do: "Check the path (it's read on the computer the agent runs on).", retry: true }));
  const ext = path.extname(file).slice(1).toLowerCase();
  const type = MIME[ext];
  if (!type) throw new ToolFailure(localFail("file_wrong_type", `Crackio can't use a .${ext || "?"} file.`, { field, do: "Use a picture (png, jpg, webp), a clip (mp4, webm, mov) or a sound file (wav, mp3, m4a, flac)." }));
  const limit = type.startsWith("image/") ? 25 : 500;
  if (st.size > limit * 1024 * 1024) throw new ToolFailure(localFail("file_too_large", `${path.basename(file)} is ${Math.round(st.size / 1e6)} MB; the most is ${limit} MB.`, { field, do: "Use a smaller file." }));
  const key = `${file}|${st.size}|${st.mtimeMs}`;
  const hit = uploaded.get(key);
  if (hit) return hit;
  const blob = typeof fs.openAsBlob === "function" ? await fs.openAsBlob(file, { type }) : new Blob([await fsp.readFile(file)], { type });
  const form = new FormData();
  form.append("file", blob, path.basename(file));
  let res;
  try {
    res = await getJson(`${base}/api/uploads`, { method: "POST", body: form, timeoutMs: 10 * 60_000 });
  } catch {
    throw new ToolFailure(restarting("The upload didn't get through."));
  }
  const url = res.json?.items?.[0]?.url;
  if (!url) {
    const said = res.json?.error ?? `Crackio answered ${res.status}.`;
    throw new ToolFailure(res.status === 413 ? localFail("file_too_large", said, { field, do: "Use a smaller file." }) : res.status === 415 || res.status === 422 ? localFail("file_wrong_type", said, { field, do: "Use a picture, a clip or a sound file Crackio reads." }) : restarting(said));
  }
  uploaded.set(key, url);
  return url;
}

/** One file argument as a Crackio address: its own addresses pass, a file in Crackio's folders maps straight back, anything else uploads. */
async function fileIn(value, field, d) {
  if (typeof value !== "string" || !value.trim()) return value;
  let v = value.trim();
  if (MEDIA_URL.test(v) || v.startsWith("/assets/")) return v;
  if (/^https?:\/\//i.test(v)) {
    if (base && v.startsWith(`${base}/api/media/`)) return v.slice(base.length);
    // A link on the web: fetched here, by the agent's computer, then uploaded like any file.
    const tmp = path.join(os.tmpdir(), `crackio-${createHash("sha1").update(v).digest("hex").slice(0, 12)}${path.extname(new URL(v).pathname).slice(0, 6) || ".bin"}`);
    try {
      const res = await fetch(v, { signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw new Error(String(res.status));
      await fsp.writeFile(tmp, Buffer.from(await res.arrayBuffer()));
    } catch (err) {
      throw new ToolFailure(localFail("file_not_found", `Couldn't download ${v.slice(0, 120)} (${err.message}).`, { field, do: "Check the link, or save the file and pass its path.", retry: true }));
    }
    return upload(tmp, field);
  }
  if (v.startsWith("file://")) v = decodeURIComponent(v.replace(/^file:\/\/\/?/, process.platform === "win32" ? "" : "/"));
  const abs = path.resolve(v.replace(/^~(?=$|[\\/])/, os.homedir()));
  const from = savedAs.get(slash(abs));
  if (from) return from;
  const dir = dataDir(d);
  if (dir) {
    const rel = (root) => {
      const r = path.relative(path.join(dir, root), abs);
      return r && !r.startsWith("..") && !path.isAbsolute(r) ? slash(r) : null;
    };
    const out = rel("media");
    if (out) return `/api/media/out/${out}`;
    const up = rel("uploads");
    if (up) return `/api/media/uploads/${up}`;
    if (rel(path.join("cache", "agent"))) {
      throw new ToolFailure(localFail("file_wrong_type", "That's a small preview made for you to look at, not the real file.", { field, do: 'Pass the result\'s own "file" path instead.', retry: true }));
    }
  }
  return upload(abs, field);
}

/** Every file argument of a call (the tool's `files` paths, "*" for each item of a list), made a Crackio address. */
async function filesIn(args, patterns, d) {
  if (!patterns?.length || !args || typeof args !== "object") return args;
  const out = structuredClone(args);
  const walk = async (node, parts, trail) => {
    if (node == null) return;
    const [head, ...rest] = parts;
    const keys = head === "*" ? (Array.isArray(node) ? node.map((_, i) => i) : []) : [head];
    for (const k of keys) {
      if (node[k] == null) continue;
      const at = [...trail, k];
      if (rest.length) await walk(node[k], rest, at);
      else node[k] = await fileIn(node[k], at.join("."), d);
    }
  };
  for (const p of patterns) await walk(out, p.split("."), []);
  return out;
}

/* ------------------------------------------------------------------ files out: Crackio addresses become local paths */

const OUT_URL = /\/api\/(?:media\/(out|uploads|templates)|agent\/(file))\/([A-Za-z0-9._-]+)/g;

async function download(url, to) {
  if (fs.existsSync(to)) return true;
  try {
    const res = await fetch(`${base}${url}`, { signal: AbortSignal.timeout(10 * 60_000) });
    if (!res.ok) return false;
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.writeFile(to, Buffer.from(await res.arrayBuffer()));
    return true;
  } catch {
    return false;
  }
}

/**
 * The answer's text with every Crackio file address made a path on this computer. Same computer: the file where Crackio
 * keeps it. Another computer: previews and up to 8 result files are downloaded; past that, full links are given.
 */
async function pathsOut(text, d) {
  const dir = dataDir(d);
  const found = [...new Set([...text.matchAll(OUT_URL)].map((m) => m[0]))];
  if (!found.length) return text;
  const map = new Map();
  let fetched = 0;
  for (const url of found) {
    const [, media, shown, name] = /\/api\/(?:media\/(out|uploads|templates)|agent\/(file))\/(.+)$/.exec(url);
    if (dir) {
      const folder = shown ? path.join("cache", "agent") : media === "out" ? "media" : media;
      map.set(url, slash(path.join(dir, folder, name)));
      continue;
    }
    const to = path.join(SAVED, shown ? "previews" : "", name);
    if ((shown || fetched < 8) && (await download(url, to))) {
      if (!shown) {
        fetched++;
        savedAs.set(slash(to), url);
      }
      map.set(url, slash(to));
    } else map.set(url, `${base}${url}`);
  }
  // Longest first, so one address never rewrites the start of another.
  return text.replace(OUT_URL, (m) => map.get(m) ?? m);
}

async function imageBytes(url, d) {
  const dir = dataDir(d);
  const name = url.split("/").pop();
  if (dir) return fsp.readFile(path.join(dir, "cache", "agent", name));
  const res = await fetch(`${base}${url}`, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`preview ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/* ------------------------------------------------------------------ calling a tool */

let clientName = "agent";

const errorResult = (failure) => ({ content: [{ type: "text", text: JSON.stringify({ error: failure }) }], isError: true });

/**
 * Calls that change nothing, so they're safe to send twice: reads, dry runs, a Retouch find, a product reading, waiting
 * on a job or a Motion step. What Crackio worked out the first time is kept there, so the second ask is answered at once.
 */
function safeAgain(name, args, def) {
  if (def?.annotations?.readOnlyHint || args?.dry_run === true) return true;
  if (name === "retouch") return !args?.changes?.length && !args?.also;
  if (name === "product") return args?.action === "read";
  if (name === "motion") return ["projects", "open", "tools", "wait"].includes(args?.action);
  if (name === "loras") return args?.note === undefined;
  return false;
}

async function callTool(name, args, signal) {
  try {
    const d = await getDoor();
    if (d.off) return errorResult(d.off);
    const def = d.tools.find((t) => t.name === name);
    const sent = await filesIn(args ?? {}, def?.files, d);
    let answer = null;
    // A call that never reached Crackio (refused, or its error page while a file recompiles) is safe to send again.
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await getJson(`${base}/api/agent`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tool: name, args: sent, client: clientName }), timeoutMs: 120_000, signal });
        if (res.json && typeof res.json.ok === "boolean") {
          answer = res.json;
          break;
        }
        if (attempt >= 3) return errorResult(restarting(`It answered ${res.status} without a result (it may be recompiling).`));
      } catch (err) {
        if (signal?.aborted) return errorResult({ code: "job_cancelled", what: "The call was cancelled.", do: "Call jobs to see whether a job had already started.", retry: true, ask_user: false });
        const refused = /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH/.test(String(err?.cause?.code ?? err?.cause?.message ?? err?.message));
        // An answer lost on the way (a connection dropped, a long call cut short): a call that changes nothing is asked
        // again. A Retouch find that took 45 s came back as "stopped answering" although Crackio had answered.
        if (!refused && attempt < 2 && safeAgain(name, sent, def)) {
          await sleep(2000);
          continue;
        }
        if (!refused) return errorResult(def?.annotations?.readOnlyHint ? restarting("The call didn't get an answer.") : lostAnswer(name));
        if (attempt >= 3) {
          door = null;
          return errorResult(restarting("It stopped answering."));
        }
      }
      await sleep(1500 * (attempt + 1));
    }
    if (!answer.ok) return errorResult(answer.error);
    const images = NO_IMAGES ? [] : (answer.images ?? []);
    const body = typeof answer.data === "string" ? answer.data : JSON.stringify(images.length ? { ...answer.data, previews: (answer.images ?? []).map((i) => ({ shows: i.label ?? "A preview.", file: i.url })) } : answer.data);
    const content = [{ type: "text", text: await pathsOut(body.replaceAll("{{crackio}}", base), d) }];
    for (const img of images) {
      try {
        content.push({ type: "image", data: (await imageBytes(img.url, d)).toString("base64"), mimeType: "image/jpeg" });
      } catch (err) {
        log(`couldn't attach a preview: ${err.message}`);
      }
    }
    return { content };
  } catch (err) {
    if (err instanceof ToolFailure) return errorResult(err.failure);
    log(`call ${name} failed: ${err?.stack ?? err}`);
    return errorResult({ code: "unknown", what: "The Crackio MCP program hit a problem of its own.", raw: String(err?.message ?? err).slice(0, 300), do: "Tell the user what you tried and what this says.", retry: false, ask_user: true });
  }
}

/* ------------------------------------------------------------------ MCP over stdio */

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const running = new Map(); // request id -> AbortController
let listedTools = null; // what the client last got, to tell it when the list changes

const listed = (d) => d.tools.map((t) => ({ ...t, files: undefined }));
const serverInfo = (d) => ({ name: "crackio", title: "Crackio", version: d.version });

async function handle(msg) {
  const { id, method, params } = msg;
  const meta = params?._meta ?? {};
  const version = meta[`${META}protocolVersion`];
  const modern = version !== undefined;
  const reply = (result) => send({ jsonrpc: "2.0", id, result: modern ? { resultType: "complete", ...result, _meta: { ...result._meta, [`${META}serverInfo`]: serverInfoNow } } : result });
  const fail = (code, message, data) => send({ jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } });

  // Notifications: nothing to answer.
  if (id === undefined) {
    if (method === "notifications/cancelled") running.get(params?.requestId)?.abort();
    return;
  }
  if (modern && version !== MODERN) return fail(-32022, "Unsupported protocol version", { supported: [MODERN, ...LEGACY], requested: version });
  const who = meta[`${META}clientInfo`]?.name;
  if (who) clientName = who;

  let serverInfoNow = serverInfo(door?.value ?? rememberedDoor() ?? FALLBACK);
  switch (method) {
    case "initialize": {
      const d = await doorOrRemembered();
      serverInfoNow = serverInfo(d);
      if (params?.clientInfo?.name) clientName = params.clientInfo.name;
      const asked = params?.protocolVersion;
      return reply({ protocolVersion: LEGACY.includes(asked) ? asked : LEGACY[0], capabilities: { tools: { listChanged: true } }, serverInfo: serverInfoNow, instructions: d.instructions });
    }
    case "server/discover": {
      const d = await doorOrRemembered();
      serverInfoNow = serverInfo(d);
      return reply({ supportedVersions: [MODERN, ...LEGACY], capabilities: { tools: { listChanged: false } }, instructions: d.instructions, ttlMs: 60_000, cacheScope: "private" });
    }
    case "ping":
      return reply({});
    case "tools/list": {
      const d = await doorOrRemembered();
      serverInfoNow = serverInfo(d);
      listedTools = JSON.stringify(listed(d));
      return reply({ tools: listed(d), ...(modern ? { ttlMs: 60_000, cacheScope: "private" } : {}) });
    }
    case "tools/call": {
      if (typeof params?.name !== "string") return fail(-32602, "tools/call needs a tool name");
      const ctrl = new AbortController();
      running.set(id, ctrl);
      // Some clients count a silent call as stuck: a note every few seconds while Crackio works.
      const token = meta.progressToken;
      let beat = 0;
      const timer = token !== undefined ? setInterval(() => send({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: token, progress: ++beat, message: "Crackio is working" } }), 5000) : null;
      try {
        const result = await callTool(params.name, params.arguments, ctrl.signal);
        if (ctrl.signal.aborted) return; // cancelled: nothing more is sent for it
        reply(result);
        // Crackio came up, or got new tools, since the client last listed them.
        if (!modern && listedTools && door && JSON.stringify(listed(door.value)) !== listedTools) {
          listedTools = JSON.stringify(listed(door.value));
          send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
        }
      } finally {
        if (timer) clearInterval(timer);
        running.delete(id);
      }
      return;
    }
    // Asked by some clients whatever a server says it has: Crackio has tools only.
    case "resources/list":
      return reply({ resources: [] });
    case "resources/templates/list":
      return reply({ resourceTemplates: [] });
    case "prompts/list":
      return reply({ prompts: [] });
    case "logging/setLevel":
      return reply({});
    default:
      return fail(-32601, `Method not found: ${method}`);
  }
}

async function check() {
  try {
    const d = await getDoor(true);
    const where = dataDir(d) ? "on this computer" : "on another computer";
    process.stdout.write(`${JSON.stringify({ ok: !d.off, url: base, version: d.version, tools: d.tools.length, where, ...(d.off ? { off: d.off.what } : {}) })}\n`);
    process.exit(d.off ? 2 : 0);
  } catch (err) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: err.failure ?? { what: String(err.message ?? err) } })}\n`);
    process.exit(1);
  }
}

if (process.argv.includes("--check")) {
  await check();
} else {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    }
    for (const m of Array.isArray(msg) ? msg : [msg]) {
      if (!m || typeof m !== "object" || typeof m.method !== "string") continue; // a response or junk: this program asks nothing
      handle(m).catch((err) => {
        log(`${m.method} failed: ${err?.stack ?? err}`);
        if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, error: { code: -32603, message: "Internal error" } });
      });
    }
  });
  // The client closed its end: nothing left to serve. Calls still running are dropped (their jobs keep going in
  // Crackio), and the exit waits a moment for open handles: an exit in the same tick trips a libuv assertion on Windows.
  rl.on("close", () => {
    for (const c of running.values()) c.abort();
    setTimeout(() => process.exit(0), 150);
  });
}
