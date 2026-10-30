// The live demo's front router (docs/DEMO.md): one address for every access code. A code can have its own private
// studio, a Crackio process with its own data folder (scripts/demo/studio.sh). Signing in with it sends that visitor
// there from then on, and a cookie remembers which studio; everyone else gets the shared demo.
//
// Studios run only while they're used: the router starts one when its visitor arrives and stops it after IDLE_MINUTES
// without a request. It starts one only while at least FREE_SHARE of the memory would stay free (and at most
// MAX_STUDIOS at once); otherwise the visitor waits in line on a page that refreshes itself, or runs Crackio at home.
//
//   ROUTER_PORT (3299)  ROUTER_SHARED_PORT (3300)  ROUTER_HOME (/opt/crackio-demo)  ROUTER_APP (<home>/app-full)
//   ROUTER_FREE_SHARE (0.2)  ROUTER_STUDIO_MB (450)  ROUTER_MAX_STUDIOS (6)  ROUTER_IDLE_MINUTES (20)
//
// <home>/studios.json is { "studios": [{ "id", "port", "code": sha256 of the code in capitals, "label" }] }, re-read when
// it changes; each studio's settings are in <home>/studios/<id>/env. The cookie only picks a studio: each studio still
// checks its own signed sign-in, so a forged cookie gets nothing.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const PORT = Number(process.env.ROUTER_PORT || 3299);
const SHARED = Number(process.env.ROUTER_SHARED_PORT || 3300);
const HOME = process.env.ROUTER_HOME || "/opt/crackio-demo";
const APP = process.env.ROUTER_APP || path.join(HOME, "app-full");
const MAP = path.join(HOME, "studios.json");
const FREE_SHARE = Number(process.env.ROUTER_FREE_SHARE || 0.2);
const STUDIO_MB = Number(process.env.ROUTER_STUDIO_MB || 450);
const MAX_STUDIOS = Number(process.env.ROUTER_MAX_STUDIOS || 6);
const IDLE_MS = Number(process.env.ROUTER_IDLE_MINUTES || 20) * 60_000;
const REPO = process.env.CRACKIO_REPO || "https://github.com/RafalOfficial/Crackio";
const COOKIE = "crk_studio";

let studios = [];
const load = () => {
  try {
    studios = JSON.parse(fs.readFileSync(MAP, "utf8")).studios ?? [];
  } catch {
    studios = [];
  }
};
load();
fs.watchFile(MAP, { interval: 2000 }, load);

const codeHash = (code) => crypto.createHash("sha256").update(String(code ?? "").trim().toUpperCase()).digest("hex");
const cookieOf = (req) => (req.headers.cookie ?? "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([\\w-]+)`))?.[1];
const studioOf = (req) => studios.find((s) => s.id === cookieOf(req));
const remember = (id) => `${COOKIE}=${id}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`;
const forget = `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

// --- Running studios ------------------------------------------------------------------------------------------------
/** id → { child, ready: Promise<boolean>, seen } */
const running = new Map();
/** Studios waiting for room, first come first served: id → last time its visitor asked. */
const line = new Map();

function memory() {
  try {
    const info = fs.readFileSync("/proc/meminfo", "utf8");
    const kb = (key) => Number(info.match(new RegExp(`^${key}:\\s+(\\d+)`, "m"))?.[1] ?? 0);
    return { total: kb("MemTotal") / 1024, free: kb("MemAvailable") / 1024 };
  } catch {
    return { total: os.totalmem() / 2 ** 20, free: os.freemem() / 2 ** 20 };
  }
}

function hasRoom() {
  if (running.size >= MAX_STUDIOS) return false;
  const { total, free } = memory();
  return free - STUDIO_MB >= total * FREE_SHARE;
}

function readEnv(file) {
  const env = {};
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

function start(studio) {
  const dir = path.join(HOME, "studios", studio.id);
  const env = { ...readEnv(path.join(dir, "env")), PATH: process.env.PATH, NODE_ENV: "production", HOME: path.join(dir, "data") };
  const log = fs.openSync(path.join(dir, "data", "studio.log"), "a");
  const child = spawn(process.execPath, [path.join(APP, "node_modules/next/dist/bin/next"), "start", "-H", "127.0.0.1", "-p", String(studio.port)], {
    cwd: APP,
    env,
    stdio: ["ignore", log, log],
  });
  const entry = { child, seen: Date.now(), ready: null };
  entry.ready = (async () => {
    for (let i = 0; i < 60; i++) {
      if (child.exitCode !== null) return false;
      const ok = await new Promise((resolve) => {
        const r = http.get({ host: "127.0.0.1", port: studio.port, path: "/api/demo/session", timeout: 2000 }, (res) => {
          res.resume();
          resolve(res.statusCode === 200);
        });
        r.on("error", () => resolve(false));
        r.on("timeout", () => r.destroy());
      });
      if (ok) return true;
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  })();
  child.on("exit", () => {
    running.delete(studio.id);
    fs.closeSync(log);
  });
  running.set(studio.id, entry);
  console.log(`studio ${studio.id} (${studio.label}) starting on :${studio.port}, ${running.size} running`);
  return entry;
}

/** The studio, running and ready, or its place in line (1 = next). */
async function open(studio) {
  const now = Date.now();
  let entry = running.get(studio.id);
  if (!entry) {
    // The line keeps who came first; each ask refreshes when that visitor was last seen.
    line.set(studio.id, now);
    for (const [id, seen] of line) if (now - seen > 90_000) line.delete(id);
    const order = [...line.keys()];
    if (order[0] !== studio.id || !hasRoom()) return { place: order.indexOf(studio.id) + 1 };
    line.delete(studio.id);
    entry = start(studio);
  }
  entry.seen = now;
  if (await entry.ready) return { port: studio.port };
  // It didn't come up: stop it, so the next ask starts it afresh.
  entry.child.kill("SIGKILL");
  running.delete(studio.id);
  return { place: 1 };
}

// Idle studios stop, which frees their memory for the next in line.
setInterval(() => {
  for (const [id, entry] of running) {
    if (Date.now() - entry.seen < IDLE_MS) continue;
    console.log(`studio ${id} idle, stopping`);
    entry.child.kill("SIGTERM");
    setTimeout(() => entry.child.exitCode === null && entry.child.kill("SIGKILL"), 10_000).unref();
  }
}, 60_000).unref();

// --- Requests -------------------------------------------------------------------------------------------------------
function forward(req, res, port, body, cookie) {
  const up = http.request({ host: "127.0.0.1", port, method: req.method, path: req.url, headers: req.headers }, (from) => {
    const headers = { ...from.headers };
    if (cookie) headers["set-cookie"] = [...[].concat(headers["set-cookie"] ?? []), cookie];
    res.writeHead(from.statusCode ?? 502, headers);
    from.pipe(res);
  });
  up.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    res.end("This studio is starting. Try again in a moment.");
  });
  req.on("aborted", () => up.destroy());
  if (body) up.end(body);
  else req.pipe(up);
}

const busyText = (place) =>
  `The demo is busy right now${place > 0 ? `: you're #${place} in line` : ""}. Your studio opens as soon as there's room, usually within a few minutes. Or run Crackio free on your own computer: ${REPO}`;

function busy(req, res, place, cookie) {
  const headers = { "cache-control": "no-store", "retry-after": "20", ...(cookie ? { "set-cookie": cookie } : {}) };
  const page = req.method === "GET" && (req.headers.accept ?? "").includes("text/html");
  if (!page) {
    res.writeHead(503, { ...headers, "content-type": "application/json" });
    return res.end(JSON.stringify({ error: busyText(place), place }));
  }
  res.writeHead(503, { ...headers, "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="20"><title>Crackio · In line</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f0e12;color:#ecebf0;font:16px/1.5 system-ui,sans-serif}
main{max-width:30rem;padding:2rem 1.25rem;text-align:center}h1{font-size:1.6rem;margin:0 0 .5rem}p{color:#a8a6b3}
b{color:#ff5a2a}a{color:#ecebf0}</style></head><body><main>
<h1>The demo is busy right now</h1>
${place > 0 ? `<p>You're <b>#${place}</b> in line. This page checks again by itself every 20 seconds.</p>` : "<p>This page checks again by itself every 20 seconds.</p>"}
<p>Your private studio opens as soon as there's room, usually within a few minutes.</p>
<p>Or run Crackio free on your own computer: <a href="${REPO}">${REPO.replace(/^https:\/\//, "")}</a></p>
</main></body></html>`);
}

const server = http.createServer(async (req, res) => {
  const where = (req.url ?? "/").split("?")[0];
  if (req.method === "POST" && where === "/api/demo/session") {
    // Signing in: the code says whose studio this is.
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 4096) req.destroy();
      else chunks.push(chunk);
    });
    req.on("end", async () => {
      const body = Buffer.concat(chunks);
      let code = "";
      try {
        code = JSON.parse(body.toString("utf8")).code;
      } catch {}
      const studio = studios.find((s) => s.code === codeHash(code));
      if (!studio) return forward(req, res, SHARED, body, forget);
      const got = await open(studio);
      if (!got.port) return busy(req, res, got.place, remember(studio.id));
      forward(req, res, got.port, body, remember(studio.id));
    });
    return;
  }
  const studio = studioOf(req);
  if (req.method === "DELETE" && where === "/api/demo/session") {
    const port = studio && running.has(studio.id) ? studio.port : SHARED;
    return forward(req, res, port, null, forget);
  }
  if (!studio) return forward(req, res, SHARED);
  const got = await open(studio);
  if (!got.port) return busy(req, res, got.place);
  forward(req, res, got.port);
});

// A page that opens a WebSocket talks to the same studio (only one that's already running).
server.on("upgrade", (req, socket, head) => {
  const studio = studioOf(req);
  const port = studio && running.has(studio.id) ? studio.port : SHARED;
  const up = net.connect(port, "127.0.0.1", () => {
    const lines = Object.entries(req.headers).flatMap(([k, v]) => [].concat(v).map((one) => `${k}: ${one}`));
    up.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${lines.join("\r\n")}\r\n\r\n`);
    if (head?.length) up.write(head);
    socket.pipe(up).pipe(socket);
  });
  up.on("error", () => socket.destroy());
  socket.on("error", () => up.destroy());
});

const stopAll = () => {
  for (const { child } of running.values()) child.kill("SIGTERM");
  process.exit(0);
};
process.on("SIGTERM", stopAll);
process.on("SIGINT", stopAll);

server.listen(PORT, "127.0.0.1", () =>
  console.log(`Demo router on 127.0.0.1:${PORT}: shared demo on :${SHARED}, ${studios.length} studios, at most ${MAX_STUDIOS} running, ${Math.round(FREE_SHARE * 100)}% memory kept free`),
);
