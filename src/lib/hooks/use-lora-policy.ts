"use client";

import { create } from "zustand";
import type { LoraPolicy } from "@/lib/local/loras";
import { forgetLoraSearches } from "./use-lora-library";

/**
 * What the LoRA library may show of adult LoRAs on this computer (Settings → Preferences; server/lora-policy): your age
 * as you say it, whether you chose to see adult LoRAs, and whether they show blurred. Saving it drops the searches
 * kept in this browser, so the next one is made under the new choice.
 */
type Store = { policy: LoraPolicy | null; error: string | null };
export const useLoraPolicyStore = create<Store>(() => ({ policy: null, error: null }));

let asked = false;
export function loadLoraPolicy(force = false) {
  if (asked && !force) return;
  asked = true;
  void fetch("/api/local/loras/policy", { cache: "no-store" })
    .then((res) => (res.ok ? (res.json() as Promise<LoraPolicy>) : null))
    .then((policy) => policy && useLoraPolicyStore.setState({ policy }))
    .catch(() => undefined);
}

export async function saveLoraPolicy(change: { age?: "adult" | "minor"; adult?: boolean; blur?: boolean }) {
  const res = await fetch("/api/local/loras/policy", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(change) }).catch(() => null);
  const body = res ? ((await res.json().catch(() => ({}))) as Partial<LoraPolicy> & { error?: string }) : {};
  if (!res?.ok) {
    useLoraPolicyStore.setState({ error: body.error ?? "Crackio didn't answer." });
    return;
  }
  useLoraPolicyStore.setState({ policy: body as LoraPolicy, error: null });
  forgetLoraSearches();
}
