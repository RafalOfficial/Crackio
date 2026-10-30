import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { CloudGpu } from "@/lib/local/types";
import { installedComfyUrl } from "./comfy-install";
import { getSettings } from "./settings";
import { sshTunnel } from "./ssh";
import { serverlessEndpoints } from "./serverless/endpoints";
import { shimFor } from "./serverless/shim";
import { comfyCloudFor } from "./serverless/comfy-cloud";
import { demoOn } from "@/lib/demo/config";

/**
 * The ComfyUIs Crackio runs Local models on: the one COMFYUI_URL names (a rented GPU box, or this computer's own), the one
 * Crackio installed on this computer, and any added on the Local page (a Mac on the same network, a rented GPU). Each
 * keeps its own models; the Local page installs on the one you pick, and a job runs on one that has its model
 * (comfy-local picks).
 *
 * Code that talks to "the" ComfyUI asks `currentTarget()`: the job's or the request's machine inside `withTarget`, the
 * main one outside it.
 */
export type ComfyTarget = {
  id: string;
  url: string;
  token?: string;
  label: string;
  source: "main" | "installed" | "added";
  /** The main one without COMFYUI_URL: ComfyUI's usual address, looked at in case one already runs there. */
  implicit?: boolean;
  /** A rented GPU connected on the Local page. */
  cloud?: CloudGpu;
  /** Its address is this computer's end of an SSH tunnel: the ComfyUI itself runs on the box. */
  tunnel?: boolean;
  /**
   * A RunPod Serverless endpoint (server/serverless): its address is a small server on this computer that speaks ComfyUI's
   * API and runs each graph as a job there. Jobs go to it only when it's picked (Run on), never by Auto: each costs money.
   */
  serverless?: { endpointId: string };
  /**
   * Billed per job (a RunPod endpoint, Comfy Cloud on your Comfy credits): never picked by Auto, never relayed to the
   * ComfyUI page, and a take's graph opens in your own ComfyUI instead.
   */
  metered?: "runpod" | "comfy-cloud";
};

const store = new AsyncLocalStorage<ComfyTarget>();

const clean = (url: string) => url.trim().replace(/\/+$/, "");
/** Host and port, with this computer's names made one. */
const place = (url: string) => {
  try {
    const u = new URL(url);
    const host = /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(u.hostname) ? "127.0.0.1" : u.hostname.toLowerCase();
    return `${host}:${u.port || (u.protocol === "https:" ? "443" : "80")}`;
  } catch {
    return url;
  }
};
const idOf = (url: string) => place(url).replace(/[^a-z0-9]+/gi, "-").toLowerCase();
/** A machine added on the Local page: by its address, or by its SSH login when it's reached through a tunnel. */
export const addedId = (m: { url: string; cloud?: CloudGpu }) =>
  m.cloud?.tunnel && m.cloud.ssh ? `ssh-${m.cloud.ssh.host}-${m.cloud.ssh.port}`.replace(/[^a-z0-9]+/gi, "-").toLowerCase() : idOf(m.url);

export function mainTarget(): ComfyTarget {
  const url = process.env.COMFYUI_URL?.trim();
  return { id: "main", url: clean(url || "http://127.0.0.1:8188"), token: process.env.COMFYUI_TOKEN?.trim() || undefined, label: "ComfyUI", source: "main", ...(url ? {} : { implicit: true }) };
}

/** The ComfyUI the current job or request works with; the main one outside of one. */
export const currentTarget = () => store.getStore() ?? mainTarget();
export const withTarget = <T>(target: ComfyTarget, fn: () => T): T => store.run(target, fn);

const g = globalThis as unknown as { __crackioComfyTargets?: { at: number; list: Promise<ComfyTarget[]> } };

/** Every ComfyUI Crackio knows, main first (looked up at most every 10 s). */
export function comfyTargets(): Promise<ComfyTarget[]> {
  const hit = g.__crackioComfyTargets;
  if (hit && Date.now() - hit.at < 10_000) return hit.list;
  const list = (async () => {
    const out = [mainTarget()];
    const known = (url: string) => out.some((t) => place(t.url) === place(url));
    const mine = await installedComfyUrl().catch(() => null);
    if (mine && !known(mine)) out.push({ id: "this-computer", url: mine, label: "This computer", source: "installed" });
    for (const m of (await getSettings()).comfyMachines ?? []) {
      const ssh = m.cloud?.ssh;
      if (m.cloud?.tunnel && ssh) {
        out.push({ id: addedId(m), url: tunnelUrl(ssh, m.cloud.tunnel), label: m.label || "Cloud GPU", source: "added", cloud: m.cloud, tunnel: true });
      } else if (m.url && !known(m.url)) {
        out.push({ id: addedId(m), url: clean(m.url), token: m.token || undefined, label: m.label || "ComfyUI", source: "added", ...(m.cloud ? { cloud: m.cloud } : {}) });
      }
    }
    for (const ep of await serverlessEndpoints()) {
      const shim = await shimFor(ep).catch((err) => void console.warn(`[serverless] ${ep.label}: ${(err as Error).message}`));
      // On the live demo, the endpoint the server is set up with is its own GPU: Auto runs jobs there and Connections
      // counts it as the demo's ComfyUI. Everywhere else it's billed, so only picked under Run on.
      const own = ep.fromEnv && demoOn();
      if (shim) out.push({ id: serverlessId(ep.endpointId), url: shim.url, label: ep.label, source: "added", serverless: { endpointId: ep.endpointId }, ...(own ? {} : { metered: "runpod" as const }) });
    }
    // Comfy Cloud, with the Comfy key entered under Connections (not a server's env key: a hosted Crackio offers none).
    const comfyKey = (await getSettings()).keys.comfy?.trim();
    if (comfyKey) {
      const cloud = await comfyCloudFor(comfyKey).catch((err) => void console.warn(`[comfy-cloud] ${(err as Error).message}`));
      if (cloud) out.push({ id: "comfy-cloud", url: cloud.url, label: "Comfy Cloud", source: "added", metered: "comfy-cloud" });
    }
    return out;
  })();
  g.__crackioComfyTargets = { at: Date.now(), list };
  return list;
}

/** The live demo's own GPU (the RunPod endpoint the server is set up with), by its machine id; null without one. */
export function demoGpuId(): string | null {
  const id = process.env.RUNPOD_ENDPOINT_ID?.trim();
  return id ? serverlessId(id) : null;
}

/**
 * A RunPod endpoint as a machine id: "runpod-" and the first 8 hex of its id's SHA-256, never the id itself (machine ids
 * reach pages, job settings and a demo's open API; the endpoint id stays on the server, in `serverless.endpointId`).
 */
export const serverlessId = (endpointId: string) => `runpod-${createHash("sha256").update(endpointId.trim()).digest("hex").slice(0, 8)}`;

/** One of them by id; the main one when the id is missing or unknown. */
export async function targetById(id?: string | null): Promise<ComfyTarget> {
  const all = await comfyTargets();
  return all.find((t) => t.id === id) ?? all[0];
}

/** After machines are added or removed. */
export function forgetTargets() {
  g.__crackioComfyTargets = undefined;
}

export const samePlace = (a: string, b: string) => place(a) === place(b);
export const isLocalUrl = (url: string) => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test(url);
/** Whether a ComfyUI runs on this computer (a tunnel's end is here, its ComfyUI isn't). */
export const isHere = (t: Pick<ComfyTarget, "url" | "tunnel">) => isLocalUrl(t.url) && !t.tunnel;

const g2 = globalThis as unknown as { __crackioTunnelPorts?: Map<string, number> };
const tunnelPorts = (g2.__crackioTunnelPorts ??= new Map());

/**
 * This computer's end of the tunnel to a box's ComfyUI. The tunnel opens in the background: until it's up, the address
 * goes nowhere (the machine shows as not answering) rather than holding up every model list.
 */
function tunnelUrl(ssh: NonNullable<CloudGpu["ssh"]>, remotePort: number) {
  const key = `${ssh.user}@${ssh.host}:${ssh.port}>${remotePort}`;
  void sshTunnel(ssh, remotePort)
    .then((port) => {
      if (tunnelPorts.get(key) !== port) {
        tunnelPorts.set(key, port);
        forgetTargets();
      }
    })
    .catch(() => tunnelPorts.delete(key));
  return `http://127.0.0.1:${tunnelPorts.get(key) ?? 9}`;
}
