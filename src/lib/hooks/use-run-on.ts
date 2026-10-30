"use client";

import { useSyncExternalStore } from "react";

/**
 * Which machine local jobs run on (settings `runOn`: a machine's id, or "auto"), set from any "Run on" picker. Every picker
 * and time line on the page hears the change and looks again.
 */
const EVENT = "crackio:run-on";
let version = 0;

/** api/local/eta's answers by job, shared for a moment by everyone asking the same (the time line, the Advanced section). */
const answers = new Map<string, { at: number; answer: Promise<unknown> }>();
const SHARED_MS = 3000;

export async function setRunOn(target: string) {
  await fetch("/api/local", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "run-on", target }) });
  version += 1;
  answers.clear();
  window.dispatchEvent(new Event(EVENT));
}

function subscribe(changed: () => void) {
  window.addEventListener(EVENT, changed);
  return () => window.removeEventListener(EVENT, changed);
}

/** A number that changes whenever the machine to run on does: part of a fetch's key, it looks again. */
export function useRunOnVersion() {
  return useSyncExternalStore(
    subscribe,
    () => version,
    () => 0,
  );
}

/** A local job as api/local/eta takes it: the settings on screen that change its time. */
export type EtaAsk = {
  model: string | null | undefined;
  kind?: "image" | "video" | "upscale";
  count?: number;
  references?: number;
  duration?: number;
  resolution?: string;
  /** The picture's shape (width / height): a 4K picture is 8.3 MP at 16:9 and 14.7 MP square. */
  ratio?: number;
  /** An upscale's picture and factor: its work grows with them. */
  source?: { width: number; height: number };
  scale?: number;
};

/** The request for a job, built the same way by every asker so they share one answer. Null for models that don't run locally. */
export function etaBody(a: EtaAsk): string | null {
  if (!a.model?.startsWith("local:")) return null;
  return JSON.stringify({
    model: a.model,
    kind: a.kind ?? "image",
    count: a.count ?? 1,
    references: a.references ?? 0,
    duration: a.duration,
    resolution: a.resolution,
    ...(a.resolution && a.ratio ? { ratio: Math.round(a.ratio * 1000) / 1000 } : {}),
    ...(a.source ? { source: { width: a.source.width, height: a.source.height } } : {}),
    ...(a.scale ? { scale: a.scale } : {}),
  });
}

/** api/local/eta for a job's request: one fetch for everyone who asks the same within a few seconds. */
export function askEta<T>(body: string): Promise<T> {
  const now = Date.now();
  for (const [k, v] of answers) if (now - v.at > SHARED_MS) answers.delete(k);
  const had = answers.get(body);
  if (had) return had.answer as Promise<T>;
  const answer = fetch("/api/local/eta", { method: "POST", headers: { "Content-Type": "application/json" }, body }).then((r) => {
    if (!r.ok) throw new Error(`eta ${r.status}`);
    return r.json() as Promise<T>;
  });
  answers.set(body, { at: now, answer });
  answer.catch(() => answers.delete(body));
  return answer;
}
