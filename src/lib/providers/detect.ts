import "server-only";
import type { ConnectionStatus } from "./types";
import { getSettings } from "@/lib/server/settings";
import { verifyKey } from "./verify";
import { comfyTargets } from "@/lib/server/comfy-targets";
import { demoFull, demoOn } from "@/lib/demo/config";

export function comfyLocalUrl() {
  return (process.env.COMFYUI_URL || "http://127.0.0.1:8188").replace(/\/$/, "");
}

const localGlobal = globalThis as unknown as { __crackioComfyLocal?: { at: number; status: ConnectionStatus } };

/** One ComfyUI's answer: its version and GPU, or null. */
async function askComfy(url: string, token: string | undefined) {
  try {
    const remote = !/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(url);
    const res = await fetch(`${url}/system_stats`, {
      signal: AbortSignal.timeout(remote ? 4000 : 700),
      cache: "no-store",
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    });
    if (!res.ok) return null;
    const stats = (await res.json()) as { system?: { comfyui_version?: string }; devices?: { name?: string }[] };
    let gpu = stats.devices?.[0]?.name?.replace(/^cuda:\d+\s*/, "").replace(/\s*:\s*\w+$/, "") ?? "GPU";
    // PyTorch calls every Mac's GPU "mps": Crackio's bridge knows the chip ("Apple M2").
    if (/^(mps|xpu|cpu)$/i.test(gpu)) {
      const info = await fetch(`${url}/crackio/info`, { signal: AbortSignal.timeout(remote ? 4000 : 1500), cache: "no-store", headers: token ? { Authorization: `Bearer ${token}` } : undefined })
        .then((r) => (r.ok ? (r.json() as Promise<{ gpus?: { name?: string }[] }>) : null))
        .catch(() => null);
      gpu = info?.gpus?.[0]?.name || gpu;
    }
    return { gpu, version: stats.system?.comfyui_version ? ` v${stats.system.comfyui_version}` : "" };
  } catch {
    return null;
  }
}

/** Connected when any ComfyUI Crackio knows answers (COMFYUI_URL's, the one it installed, machines added on Local). */
async function detectComfyLocal(): Promise<ConnectionStatus> {
  const targets = await comfyTargets();
  const url = targets[0].url;
  // Every model list asks; a rented box is a few hundred ms away, so the answer is kept briefly.
  const hit = localGlobal.__crackioComfyLocal;
  if (hit && Date.now() - hit.at < (hit.status.state === "connected" ? 20_000 : 5_000) && hit.status.detail.includes(url)) return hit.status;
  const base = {
    id: "comfy-local",
    name: "ComfyUI (local)",
    auth: "local-server",
    capabilities: ["image", "edit", "video"],
    setup: { label: "Start ComfyUI", url: "https://github.com/Comfy-Org/ComfyUI", envVar: "COMFYUI_URL" },
  } as const;
  // All at once; once one has answered, the others get a moment more, not their full timeout (a stopped box takes 4 s).
  const got: (Awaited<ReturnType<typeof askComfy>> | undefined)[] = targets.map(() => undefined);
  await new Promise<void>((resolve) => {
    let done = 0;
    let grace: ReturnType<typeof setTimeout> | null = null;
    targets.forEach((t, i) =>
      void askComfy(t.url, t.token).then((a) => {
        got[i] = a;
        if (++done === targets.length) resolve();
        else if (a && !grace) grace = setTimeout(resolve, 700);
      }),
    );
  });
  // Billed machines (Comfy Cloud, RunPod Serverless) aren't your ComfyUI: they have their own rows in Connections.
  const up = targets.map((t, i) => ({ t, a: got[i] })).filter((x) => x.a && !x.t.metered);
  const status: ConnectionStatus = up.length
    ? {
        ...base,
        state: "connected",
        detail: up
          .map(({ t, a }) => `Running at ${t.url}${a!.version} on ${t.cloud ? `a rented ${a!.gpu.replace(/^NVIDIA (GeForce )?/i, "")} (${({ vast: "vast.ai", runpod: "RunPod" } as Record<string, string>)[t.cloud.provider] ?? "cloud"})` : a!.gpu}.`)
          .join(" "),
      }
    : { ...base, state: "missing", detail: `Nothing is answering at ${url}.` };
  localGlobal.__crackioComfyLocal = { at: Date.now(), status };
  return status;
}

async function detectComfyCloud(): Promise<ConnectionStatus> {
  const saved = (await getSettings()).keys.comfy;
  const fromEnv = saved ? undefined : process.env.COMFY_API_KEY;
  const key = saved || fromEnv;
  const verdict = key ? await verifyKey("comfy", key) : "unknown";
  return {
    id: "comfy-cloud",
    name: "Comfy Router",
    auth: "api-key",
    state: !key ? "missing" : verdict === "invalid" ? "attention" : "connected",
    detail: !key
      ? "One Comfy API key reaches FLUX 3, GPT Image 2.5, Grok Imagine and more."
      : verdict === "invalid"
        ? `Comfy rejected this key${fromEnv ? " (from COMFY_API_KEY)" : ""}. Replace it.`
        : "Key accepted. Tools run on Comfy Router through the Comfy SDK.",
    capabilities: ["image", "edit", "video"],
    setup: { label: "Get an API key", url: "https://platform.comfy.org", envVar: "COMFY_API_KEY" },
  };
}

export async function detectConnections(): Promise<ConnectionStatus[]> {
  const all = await Promise.all([detectComfyCloud(), detectComfyLocal()]);
  // The live demo runs only its own ComfyUI: a cloud model would bill this server's keys (lib/demo).
  // It doesn't say where its own ComfyUI answers either.
  // The full demo (one process per code) runs the visitor's own Comfy key too: it's theirs to spend.
  if (demoFull()) return all.map((c) => (c.id === "comfy-local" ? { ...c, detail: c.state === "connected" ? "The live demo's GPU." : "The live demo's GPU isn't answering right now." } : c));
  return demoOn()
    ? all.map((c) =>
        c.id === "comfy-local"
          ? { ...c, detail: c.state === "connected" ? "The live demo's GPU." : "The live demo's GPU isn't answering right now." }
          : { ...c, state: "missing" as const, detail: "Not part of the live demo.", account: undefined },
      )
    : all;
}
