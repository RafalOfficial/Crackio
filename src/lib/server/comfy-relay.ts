import "server-only";
import { createHash } from "node:crypto";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { targetById } from "./comfy-targets";
import { readRecipe } from "./recipes";

/**
 * Each of your ComfyUIs' own interface, shown inside Crackio (the ComfyUI page): a small relay on this computer, one port per
 * machine, that passes everything (the page, its API, its websocket) to that machine's ComfyUI. It adds the machine's token
 * (a vast.ai box's portal wants one, which a browser frame can't send), so a rented GPU, a Mac on the network, a box behind
 * an SSH tunnel and this computer's own ComfyUI all open the same way, from any device that reaches Crackio.
 *
 * The page it relays carries a few lines of Crackio's (FOLLOW below): they open the graph of the job Crackio is running there,
 * so its nodes light up as ComfyUI works through them.
 */

type Relay = { server: http.Server; port: number; version?: number };
/** Bumped when the relay itself changes: one started by older code (it outlives a code reload) is closed and started again. */
const VERSION = 3;
const g = globalThis as unknown as { __crackioComfyRelays?: Map<string, Promise<Relay>>; __crackioFollowScript?: string };
const relays = (g.__crackioComfyRelays ??= new Map());

/** The same port for a machine every time (ComfyUI's interface keeps its settings per address), near 38500. */
const portFor = (machine: string) => 38_500 + (createHash("sha1").update(machine).digest().readUInt16BE(0) % 400);

/**
 * The relay for a machine, started on first use. `everywhere`: also for other devices on your network (when Crackio itself
 * was opened from one), else on this computer only.
 */
export async function relayFor(machine: string, everywhere: boolean): Promise<Relay> {
  const key = `${machine}|${everywhere ? "all" : "local"}`;
  const old = relays.get(key);
  if (old) {
    const running = await old.catch(() => null);
    if (running?.version === VERSION) return running;
    relays.delete(key);
    // Its port frees as soon as it stops listening; open connections (a page's websocket) end with it.
    if (running) {
      running.server.closeAllConnections();
      running.server.close();
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  const relay = start(machine, everywhere ? "0.0.0.0" : "127.0.0.1");
  relays.set(key, relay);
  relay.catch(() => relays.delete(key));
  return relay;
}

async function start(machine: string, host: string): Promise<Relay> {
  const server = http.createServer((req, res) => void forward(machine, req, res));
  server.on("upgrade", (req, socket, head) => void tunnel(machine, req, socket as net.Socket, head));
  for (let port = portFor(machine), tries = 0; tries < 40; port++, tries++) {
    const ok = await new Promise<boolean>((resolve) => {
      const fail = () => resolve(false);
      server.once("error", fail);
      server.listen(port, host, () => {
        server.off("error", fail);
        resolve(true);
      });
    });
    if (ok) return { server, port, version: VERSION };
  }
  throw new Error("No free port for the ComfyUI relay.");
}

/** Headers for the machine: its own Host, its token, no Origin (ComfyUI refuses a page whose Origin isn't its own host). */
function upstreamHeaders(req: http.IncomingMessage, base: URL, token: string | undefined) {
  const headers: http.OutgoingHttpHeaders = { ...req.headers, host: base.host };
  delete headers.origin;
  delete headers.referer;
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

async function forward(machine: string, req: http.IncomingMessage, res: http.ServerResponse) {
  const t = await targetById(machine).catch(() => null);
  if (!t || t.id !== machine) return unavailable(res, "That machine isn't one of Crackio's any more.");
  // Never relayed: its "ComfyUI" runs paid RunPod jobs, and a relay can listen beyond this computer.
  if (t.metered || t.serverless) return unavailable(res, t.metered === "comfy-cloud" ? "Comfy Cloud's own interface is at cloud.comfy.org." : `${t.label} runs ComfyUI on RunPod Serverless, one GPU per job: it has no interface to show here.`);
  const base = new URL(t.url);
  const path = req.url || "/";
  // A Library item's graph, for the page to open (FOLLOW's `crackio_recipe`): from Crackio, not the machine.
  if (req.method === "GET" && path.startsWith("/crackio/recipe?")) return void recipeGraph(path, res);
  // The interface's page, read whole so Crackio's lines go in.
  const page = req.method === "GET" && /^\/(index\.html)?(\?|$)/.test(path);
  const headers = upstreamHeaders(req, base, t.token);
  if (page) headers["accept-encoding"] = "identity";
  const client = base.protocol === "https:" ? https : http;
  const up = client.request(
    { protocol: base.protocol, hostname: base.hostname, port: base.port || undefined, method: req.method, path, headers, timeout: 60_000 },
    (upRes) => {
      const out = { ...upRes.headers };
      // The machine's own address in a redirect, as one through the relay.
      if (typeof out.location === "string" && out.location.startsWith(t.url)) out.location = out.location.slice(t.url.length) || "/";
      delete out["x-frame-options"];
      if (page && /text\/html/.test(String(upRes.headers["content-type"] ?? ""))) {
        const chunks: Buffer[] = [];
        upRes.on("data", (c: Buffer) => chunks.push(c));
        upRes.on("end", () => {
          const html = Buffer.concat(chunks).toString("utf8");
          // The newest lines, also for a relay started before Crackio's code last changed.
          const script = `<script>${g.__crackioFollowScript ?? FOLLOW}</script>`;
          const body = Buffer.from(html.includes("</head>") ? html.replace("</head>", `${script}</head>`) : html + script, "utf8");
          delete out["content-encoding"];
          out["content-length"] = String(body.length);
          out["cache-control"] = "no-store";
          res.writeHead(upRes.statusCode ?? 200, out);
          res.end(body);
        });
        return;
      }
      res.writeHead(upRes.statusCode ?? 502, out);
      upRes.pipe(res);
    },
  );
  up.on("timeout", () => up.destroy(new Error("timed out")));
  up.on("error", (err) => (res.headersSent ? res.destroy() : unavailable(res, `${t.label} isn't answering (${err.message}).`)));
  req.pipe(up);
}

/** One step's graph of a Library item's recipe (server/recipes), with the name its tab gets. */
async function recipeGraph(path: string, res: http.ServerResponse) {
  const q = new URL(path, "http://relay").searchParams;
  const recipe = await readRecipe(q.get("gen") ?? "");
  const index = q.get("step") ? Number(q.get("step")) : (recipe?.main ?? 0);
  const step = recipe?.steps[index];
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  if (!recipe || !step?.graph) return send(404, { error: "No graph kept for that take." });
  const part = recipe.steps.length > 1 ? ` · step ${index + 1} of ${recipe.steps.length}` : "";
  send(200, { graph: step.graph, name: `Crackio · ${step.name}${part} · ${recipe.id.slice(-6)}` });
}

/** A websocket (ComfyUI's live progress): the handshake goes to the machine with its token, then bytes flow both ways. */
async function tunnel(machine: string, req: http.IncomingMessage, socket: net.Socket, head: Buffer) {
  const t = await targetById(machine).catch(() => null);
  if (!t || t.id !== machine || t.metered || t.serverless) return socket.destroy();
  const base = new URL(t.url);
  const secure = base.protocol === "https:";
  const port = Number(base.port || (secure ? 443 : 80));
  const upstream = secure ? tls.connect({ host: base.hostname, port, servername: base.hostname }) : net.connect(port, base.hostname);
  const close = () => {
    socket.destroy();
    upstream.destroy();
  };
  upstream.once(secure ? "secureConnect" : "connect", () => {
    const headers = upstreamHeaders(req, base, t.token);
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (const [k, v] of Object.entries(headers)) for (const one of Array.isArray(v) ? v : [v]) if (one !== undefined) lines.push(`${k}: ${one}`);
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on("error", close);
  socket.on("error", close);
  socket.on("close", () => upstream.destroy());
  upstream.on("close", () => socket.destroy());
}

function unavailable(res: http.ServerResponse, why: string) {
  if (res.headersSent) return res.destroy();
  res.writeHead(502, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(
    `<!doctype html><meta charset="utf-8"><body style="margin:0;display:grid;place-items:center;height:100vh;background:#16131b;color:#c9c3d3;font:14px system-ui"><p>${why.replace(/</g, "&lt;")}</p></body>`,
  );
}

/**
 * Runs inside ComfyUI's page. When a job Crackio sent (its `extra_data.crackio`) runs here, it opens that job's graph as a
 * tab of its own ("Crackio · <model>"), and its nodes light up as they run; Crackio's page can also ask for one job
 * ({type: "crackio:show", promptId}) or turn following off ({type: "crackio:follow", on: false}). Your own workflows stay
 * in their tabs.
 *
 * Crackio's jobs carry no client id, and for those ComfyUI tells every window only how far each node is (`progress_state`),
 * not which one is running: those messages say when a job starts and which node runs, and this passes them on as the
 * interface's own "execution_start" and "executing" (node ids as the loaded graph has them: "12:3" becomes "12_3").
 */
const FOLLOW = String.raw`(() => {
  // Inside Crackio's page, leaving it doesn't ask about unsaved workflows: ComfyUI keeps its open tabs and restores them,
  // and the job tabs Crackio opens would ask every time.
  if (window.top !== window) {
    const add = window.addEventListener.bind(window);
    window.addEventListener = (type, fn, opts) => (type === "beforeunload" ? undefined : add(type, fn, opts));
    Object.defineProperty(window, "onbeforeunload", { configurable: true, get: () => null, set: () => {} });
  }
  const params = new URLSearchParams(location.search);
  let follow = params.get("crackio_follow") !== "0";
  let shown = null, loading = null, running;
  const checked = new Set();
  const api = () => window.comfyAPI && window.comfyAPI.api && window.comfyAPI.api.api;
  const ready = () => window.app && typeof window.app.loadApiJson === "function" && api();
  async function job(id) {
    const q = await (await fetch("api/queue", { cache: "no-store" })).json();
    const item = [...(q.queue_running || []), ...(q.queue_pending || [])].find((p) => p[1] === id);
    if (item) return { graph: item[2], extra: item[3] || {} };
    const h = await (await fetch("api/history/" + encodeURIComponent(id), { cache: "no-store" })).json();
    const done = h[id];
    return done ? { graph: done.prompt[2], extra: done.prompt[3] || {} } : null;
  }
  async function show(id, onlyCrackio) {
    if (!ready() || !id || id === shown || id === loading) return;
    loading = id;
    try {
      const found = await job(id);
      if (!found || (onlyCrackio && !found.extra.crackio)) return;
      const name = found.extra.crackio && found.extra.crackio.model ? "Crackio · " + found.extra.crackio.model : "Crackio job";
      await window.app.loadApiJson(found.graph, name.replace(/[\\/:*?"<>|]/g, " ") + ".json");
      shown = id;
      running = undefined;
      api().dispatchCustomEvent("execution_start", { prompt_id: id, timestamp: Date.now() });
    } catch (err) {
      console.warn("[crackio] couldn't open the job", err);
    } finally {
      if (loading === id) loading = null;
    }
  }
  // A Library item's graph (crackio_recipe, its step crackio_step), kept by Crackio: opened as a tab of its own.
  async function recipe(gen, step) {
    if (!ready()) return setTimeout(() => recipe(gen, step), 500);
    try {
      const res = await fetch("crackio/recipe?gen=" + encodeURIComponent(gen) + (step ? "&step=" + encodeURIComponent(step) : ""), { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const found = await res.json();
      await window.app.loadApiJson(found.graph, String(found.name).replace(/[\\/:*?"<>|]/g, " ") + ".json");
      shown = "recipe:" + gen;
    } catch (err) {
      console.warn("[crackio] couldn't open the take's graph", err);
    }
  }
  let finished = null;
  async function finish(id) {
    try {
      const h = await (await fetch("api/history/" + encodeURIComponent(id), { cache: "no-store" })).json();
      const done = h[id];
      if (!done || id !== shown) return;
      finished = id;
      for (const [node, output] of Object.entries(done.outputs || {})) {
        const local = String(node).replace(/:/g, "_");
        api().dispatchCustomEvent("executed", { node: local, display_node: local, output, prompt_id: id });
      }
      running = null;
      api().dispatchCustomEvent("executing", null);
      api().dispatchCustomEvent("execution_success", { prompt_id: id, timestamp: Date.now() });
    } catch (err) {
      console.warn("[crackio] couldn't read the job's results", err);
    }
  }
  function mirror(d) {
    const nodes = Object.entries(d.nodes || {});
    const now = nodes.find(([, n]) => n.state === "running");
    const node = now ? String(now[0]).replace(/:/g, "_") : null;
    if (node === running) return;
    running = node;
    api().dispatchCustomEvent("executing", node);
  }
  window.addEventListener("message", (e) => {
    const d = e.data || {};
    if (d.type === "crackio:show") show(d.promptId, false);
    if (d.type === "crackio:follow") follow = Boolean(d.on);
  });
  const hook = () => {
    if (!ready()) return setTimeout(hook, 500);
    api().addEventListener("progress_state", (e) => {
      const d = e.detail || {};
      const id = d.prompt_id;
      if (!id) return;
      if (id === shown) return mirror(d);
      // Each job is looked at once: the interface's own jobs send these too.
      if (follow && !checked.has(id)) {
        checked.add(id);
        show(id, true);
      }
    });
    // A change in the queue: the job may have finished. Its results go into their nodes (ComfyUI sends those only to the
    // window that queued a job), and the running node goes dark.
    api().addEventListener("status", () => {
      if (shown && shown !== finished) finish(shown);
    });
    const asked = params.get("crackio_prompt");
    const kept = params.get("crackio_recipe");
    if (kept) {
      follow = false;
      recipe(kept, params.get("crackio_step"));
    } else if (asked) show(asked, false);
    else if (follow) {
      fetch("api/queue", { cache: "no-store" })
        .then((r) => r.json())
        .then((q) => {
          const running = (q.queue_running || [])[0];
          if (running && running[3] && running[3].crackio) show(running[1], true);
        })
        .catch(() => {});
    }
  };
  hook();
})();`;

g.__crackioFollowScript = FOLLOW;
