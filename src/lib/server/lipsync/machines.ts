import "server-only";
import { comfyTargets, type ComfyTarget } from "../comfy-targets";
import { ask, voiceMachines } from "../voice/machines";
import { lipsyncJobOf } from "./jobs";
import type { LipsyncMachine } from "@/lib/lipsync/machines";
import { bridgeHas } from "@/lib/setup/bridge";

/**
 * Where Lip Sync runs: every ComfyUI Crackio knows, as Crackio bridge 1.9+ describes it (comfyui/crackio_bridge/
 * lipsync.py): whether its engine is installed and checked, which of LatentSync's files it has, the install going on.
 */

export const LIPSYNC_BRIDGE = "1.9.0";
const atLeast = (a: string | null, b: string) => Boolean(a) && a!.localeCompare(b, undefined, { numeric: true }) >= 0;

type Status = {
  engine: { ok: boolean; device?: string; dtype?: string; gpu?: string; full?: boolean; checked?: number } | null;
  install: { state: string; step: string | null; error: string | null };
  check?: { state: string; error: string | null };
  models: Record<"unet" | "whisper" | "vae" | "syncnet" | "face" | "hand", boolean>;
  /** Best quality's files (bridge 1.10.1+): HuMo 17B, Whisper large v3, umt5, Wan 2.1's VAE. */
  best?: Record<"model" | "whisper" | "text" | "vae", boolean>;
  /** Crackio's MXFP8 build of HuMo is there (bridge 1.10.3+). */
  best_fast?: boolean;
  disk_free: number | null;
  platform: { system: string; machine: string };
};

export async function lipsyncMachines(fresh = false): Promise<LipsyncMachine[]> {
  const [voices, targets] = await Promise.all([voiceMachines(fresh), comfyTargets()]);
  return Promise.all(
    voices.map(async (v): Promise<LipsyncMachine> => {
      const t = targets.find((x) => x.id === v.id);
      const ready = v.online && atLeast(v.bridge, LIPSYNC_BRIDGE);
      const s = ready && t ? await ask<Status>(t, "/crackio/lipsync") : null;
      const models = s?.models ?? { unet: false, whisper: false, vae: false, syncnet: false, face: false, hand: false };
      return {
        id: v.id,
        label: v.label,
        online: v.online,
        gpu: v.gpu,
        gpuGb: v.gpuGb,
        unified: v.unified,
        platform: v.platform,
        bridge: v.bridge,
        ready: Boolean(s),
        engine: s?.engine?.ok ? { device: s.engine.device ?? null, dtype: s.engine.dtype ?? null, full: Boolean(s.engine.full), checked: s.engine.checked ?? null } : null,
        installing: s?.install.state === "running" ? (s.install.step ?? "packages") : s?.check?.state === "running" ? "checking" : null,
        installError: s?.install.state === "error" ? s.install.error : s?.check?.state === "error" ? s.check.error : null,
        models,
        hasModels: models.unet && models.whisper && models.vae,
        best: bridgeHas(v.bridge, "lipsyncBest") && Boolean(s?.best && Object.values(s.best).every(Boolean)),
        bestFast: Boolean(s?.best_fast),
        diskGb: s?.disk_free != null ? s.disk_free / 1e9 : null,
        hearing: v.hearing,
        runOn: v.runOn,
        setup: lipsyncJobOf(v.id),
      };
    }),
  );
}

/** The machine a lip sync runs on: the one picked under Run on when it's set up, else the set-up one with the biggest GPU. */
export async function lipsyncMachineFor(): Promise<{ target: ComfyTarget; machine: LipsyncMachine } | null> {
  const machines = (await lipsyncMachines()).filter((m) => m.online && m.ready && m.engine && m.hasModels);
  const pick = machines.find((m) => m.runOn) ?? machines.sort((a, b) => (b.gpuGb ?? 0) - (a.gpuGb ?? 0))[0];
  if (!pick) return null;
  const target = (await comfyTargets()).find((t) => t.id === pick.id);
  return target ? { target, machine: pick } : null;
}
