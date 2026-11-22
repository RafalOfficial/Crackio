import "server-only";
import type { ConnectionStatus } from "./types";
import { getSettings } from "@/lib/server/settings";
import { verifyKey } from "./verify";
import { comfyTargets, type ComfyTarget } from "@/lib/server/comfy-targets";
import { machineLook } from "@/lib/server/machine-probe";
import { epoch } from "@/lib/server/epoch";
import { demoFull, demoOn } from "@/lib/demo/config";

export function comfyLocalUrl() {
  return (process.env.COMFYUI_URL || "http://127.0.0.1:8188").replace(/\/$/, "");
}

const localGlobal = globalThis as unknown as {
  __crackioComfyLocal?: { at: number; key: string; status: ConnectionStatus };
  __crackioComfyLocalPending?: { key: string; value: Promise<ConnectionStatus> };
};

/** One ComfyUI's answer, from the shared look at it (lib/server/machine-probe): its version and GPU, or null. */
async function askComfy(t: ComfyTarget) {
  const { stats, bridge } = await machineLook(t);
  if (!stats) return null;
  let gpu = stats.devices?.[0]?.name?.replace(/^cuda:\d+\s*/, "").replace(/\s*:\s*\w+$/, "") ?? "GPU";
  // PyTorch calls every Mac's GPU "mps": Crackio's bridge knows the chip ("Apple M2").
  if (/^(mps|xpu|cpu)$/i.test(gpu)) gpu = bridge?.gpus?.[0]?.name || gpu;
  return { gpu, version: stats.system?.comfyui_version ? ` v${stats.system.comfyui_version}` : "" };
}

/** Connected when any ComfyUI Crackio knows answers (COMFYUI_URL's, the one it installed, machines added on Local). */
async function detectComfyLocal(): Promise<ConnectionStatus> {
  const targets = await comfyTargets();
  // Every model list asks: the answer is kept while the machines are the same ones and none came online or went away
  // (the epoch). It used to be kept only while its text named the main address, which never matched when only another
  // ComfyUI answered (this computer's own on 8189), so every list asked every machine again.
  const key = `${targets.map((t) => `${t.id}=${t.url}`).join("|")}#${epoch()}`;
  const hit = localGlobal.__crackioComfyLocal;
  if (hit && hit.key === key && Date.now() - hit.at < (hit.status.state === "connected" ? 20_000 : 5_000)) return hit.status;
  const pending = localGlobal.__crackioComfyLocalPending;
  if (pending?.key === key) return pending.value;
  const value = lookAtComfyLocal(targets, key);
  localGlobal.__crackioComfyLocalPending = { key, value };
  void value
    .catch(() => undefined)
    .finally(() => {
      if (localGlobal.__crackioComfyLocalPending?.value === value) localGlobal.__crackioComfyLocalPending = undefined;
    });
  return value;
}

async function lookAtComfyLocal(all: ComfyTarget[], key: string): Promise<ConnectionStatus> {
  const url = all[0].url;
  // Billed machines (Comfy Cloud, RunPod Serverless) aren't your ComfyUI and have their own rows: one is asked only when
  // it's the machine chosen under Run on, where every job goes. Then the open models on it are ready to pick, with no
  // GPU of your own switched on (asking costs nothing: RunPod's health check and the worker's last file list).
  const runOn = (await getSettings()).runOn;
  const targets = all.filter((t) => !t.metered || t.id === runOn);
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
    if (!targets.length) return resolve();
    let done = 0;
    let grace: ReturnType<typeof setTimeout> | null = null;
    targets.forEach((t, i) =>
      void askComfy(t).then((a) => {
        got[i] = a;
        if (++done === targets.length) resolve();
        else if (a && !grace) grace = setTimeout(resolve, 700);
      }),
    );
  });
  const up = targets.map((t, i) => ({ t, a: got[i] })).filter((x) => x.a);
  const status: ConnectionStatus = up.length
    ? {
        ...base,
        state: "connected",
        detail: up
          .map(({ t, a }) =>
            t.metered
              ? `Jobs run on ${t.label} (chosen under Run on), billed per job.`
              : `Running at ${t.url}${a!.version} on ${t.cloud ? `a rented ${a!.gpu.replace(/^NVIDIA (GeForce )?/i, "")} (${({ vast: "vast.ai", runpod: "RunPod" } as Record<string, string>)[t.cloud.provider] ?? "cloud"})` : a!.gpu}.`,
          )
          .join(" "),
      }
    : { ...base, state: "missing", detail: `Nothing is answering at ${url}.` };
  localGlobal.__crackioComfyLocal = { at: Date.now(), key, status };
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
