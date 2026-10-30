"use client";

import { useEffect, useState } from "react";
import { create } from "zustand";
import type { DepthMap } from "./reconstruct";
import type { ElementKind } from "./types";

/**
 * Client side of Crackio's local vision service (/api/vision): depth maps that turn photos into
 * 3D sets, and cutouts that lift people and things off their backgrounds.
 */
export type ModelStatus = { state: "missing" | "downloading" | "loading" | "ready" | "error"; received: number; total: number; error?: string };
export type CutoutResult = { url: string; width: number; height: number; cutout: boolean; note?: string };

type VisionStore = { busy: number; models: Record<"depth" | "cutout", ModelStatus> | null };
export const useVision = create<VisionStore>(() => ({ busy: 0, models: null }));

let poll: ReturnType<typeof setInterval> | null = null;

async function refresh() {
  try {
    const res = await fetch("/api/vision", { cache: "no-store" });
    const data = (await res.json()) as { models: VisionStore["models"] };
    useVision.setState({ models: data.models });
  } catch {
    /* the next tick tries again */
  }
}

/** Count work in flight and watch model downloads while anything is pending. */
function track<T>(p: Promise<T>): Promise<T> {
  useVision.setState((s) => ({ busy: s.busy + 1 }));
  poll ??= setInterval(refresh, 700);
  return p.finally(() => {
    useVision.setState((s) => ({ busy: Math.max(0, s.busy - 1) }));
    if (useVision.getState().busy === 0 && poll) {
      clearInterval(poll);
      poll = null;
      void refresh();
    }
  });
}

async function call<T>(task: "depth" | "cutout" | "mask" | "read", url: string): Promise<T> {
  const res = await fetch("/api/vision", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ task, url }),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? "The 3D tools didn't answer.");
  return data;
}

function decodeDepth({ width, height, data }: { width: number; height: number; data: string }): DepthMap {
  const bin = atob(data);
  const out = new Float32Array(width * height);
  for (let i = 0; i < out.length; i++) out[i] = (bin.charCodeAt(i * 2) | (bin.charCodeAt(i * 2 + 1) << 8)) / 65535;
  return { width, height, data: out };
}

const depths = new Map<string, Promise<DepthMap>>();
/** Depth maps that have arrived, for code that can't wait (placing someone on set). */
export const readyDepths = new Map<string, DepthMap>();

export function loadDepth(url: string) {
  let p = depths.get(url);
  if (!p) {
    p = track(call<{ width: number; height: number; data: string }>("depth", url))
      .then(decodeDepth)
      .then((d) => {
        readyDepths.set(url, d);
        return d;
      });
    p.catch(() => depths.delete(url));
    depths.set(url, p);
  }
  return p;
}

const cutouts = new Map<string, Promise<CutoutResult>>();

export function makeCutout(url: string) {
  let p = cutouts.get(url);
  if (!p) {
    p = track(call<CutoutResult>("cutout", url));
    p.catch(() => cutouts.delete(url));
    cutouts.set(url, p);
  }
  return p;
}

export type SubjectRead = { kind: ElementKind; noun: string; identity: string; height: number | null; around: number | null };

/** What a cast picture shows, read by a vision model (null when none is connected). Never throws. */
export function readSubject(url: string): Promise<SubjectRead | null> {
  return call<{ read: SubjectRead | null }>("read", url).then(
    (r) => r.read,
    () => null,
  );
}

/** Where an image's subject is: 0…1 coverage per pixel over the whole frame (all 0 when nothing stands out). */
export type SubjectMask = { width: number; height: number; data: Uint8Array };

const masks = new Map<string, Promise<SubjectMask>>();

export function loadMask(url: string) {
  let p = masks.get(url);
  if (!p) {
    p = track(call<{ width: number; height: number; data: string }>("mask", url)).then(({ width, height, data }) => ({
      width,
      height,
      data: Uint8Array.from(atob(data), (c) => c.charCodeAt(0)),
    }));
    p.catch(() => masks.delete(url));
    masks.set(url, p);
  }
  return p;
}

/** The subject matte for an image once it's ready; null while it loads or if it failed. */
export function useMask(url: string | null | undefined) {
  const [state, setState] = useState<{ url: string | null; mask: SubjectMask | null; failed: boolean }>({ url: null, mask: null, failed: false });
  useEffect(() => {
    if (!url) return;
    let live = true;
    loadMask(url).then(
      (mask) => live && setState({ url, mask, failed: false }),
      () => live && setState({ url, mask: null, failed: true }),
    );
    return () => {
      live = false;
    };
  }, [url]);
  const current = state.url === url;
  return { mask: current ? state.mask : null, failed: current && state.failed };
}

/** The depth map for an image once it's ready. */
export function useDepth(url: string | null | undefined) {
  const [state, setState] = useState<{ url: string | null; depth: DepthMap | null; error: string | null }>({ url: null, depth: null, error: null });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!url) return;
    let live = true;
    loadDepth(url).then(
      (depth) => live && setState({ url, depth, error: null }),
      (err: Error) => live && setState({ url, depth: null, error: err.message }),
    );
    return () => {
      live = false;
    };
  }, [url, attempt]);
  const current = state.url === url;
  return {
    depth: current ? state.depth : null,
    error: current ? state.error : null,
    retry: () => setAttempt((a) => a + 1),
  };
}

/** A one-line description of what the vision service is doing, for progress UI. */
export function visionMessage(models: VisionStore["models"]) {
  if (!models) return null;
  const downloading = (["depth", "cutout"] as const).filter((m) => models[m].state === "downloading");
  if (downloading.length) {
    const received = downloading.reduce((s, m) => s + models[m].received, 0);
    const total = downloading.reduce((s, m) => s + models[m].total, 0);
    return `Getting the 3D tools ready (one time) · ${Math.round((received / Math.max(1, total)) * 100)}%`;
  }
  if ((["depth", "cutout"] as const).some((m) => models[m].state === "loading")) return "Warming up the 3D tools";
  return null;
}
