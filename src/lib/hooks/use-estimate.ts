"use client";

import { useEffect, useState } from "react";
import type { JobSpec, SetupEstimate } from "@/lib/setup/knobs";
import type { ApiQuote } from "@/lib/setup/api-prices";

/**
 * Settings' estimate for one model version and job on one machine (/api/setup/estimate), asked a moment after the
 * settings stop changing. Answers are kept for the page's life, so going back to a setting shows its number at once;
 * while a new one comes, the last stays on screen (no flicker).
 */

export type EstimateAnswer = { estimate: SetupEstimate | null; api?: ApiQuote | null; why?: string; error?: string };
export type EstimateAsk = { machine: string; model: string; variant: string } & JobSpec;

const answers = new Map<string, EstimateAnswer>();

export function useEstimate(ask: EstimateAsk | null) {
  const key = ask ? JSON.stringify(ask) : "";
  const [shown, setShown] = useState<EstimateAnswer | null>(null);
  const known = key ? answers.get(key) : undefined;
  useEffect(() => {
    if (!key || answers.has(key)) return;
    const stop = new AbortController();
    const t = window.setTimeout(async () => {
      const res = await fetch("/api/setup/estimate", { method: "POST", headers: { "Content-Type": "application/json" }, body: key, signal: stop.signal }).catch(() => null);
      if (stop.signal.aborted) return;
      const body = (await res?.json().catch(() => null)) as EstimateAnswer | null;
      const answer: EstimateAnswer = body ?? { estimate: null, error: "Crackio didn't answer." };
      answers.set(key, answer);
      if (answers.size > 300) answers.delete(answers.keys().next().value!);
      setShown(answer);
    }, 220);
    return () => {
      window.clearTimeout(t);
      stop.abort();
    };
  }, [key]);
  return { answer: known ?? shown, loading: Boolean(key) && !known };
}
