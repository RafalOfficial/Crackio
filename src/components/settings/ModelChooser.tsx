"use client";

import type { ModelOption, OptionVariant, ReqStatus } from "@/lib/setup/types";

/**
 * Picking a model for one part of a tool (ToolSheet shows the choice): Crackio's pick is picked until you pick another,
 * and a pick that differs from it, and isn't there yet, is what a set-up gets instead.
 */

export type Choice = { model: string; variant: string };

/** Crackio's pick for a part (the model there, else the one a set-up gets), or null when nothing runs. */
export function defaultChoice(r: ReqStatus): Choice | null {
  const o = r.options?.find((x) => x.pick);
  return o ? { model: o.model, variant: o.variant } : null;
}

/** Whether a part has a real choice to show: two models, or two versions of one. */
export const hasChoice = (r: ReqStatus) => Boolean(r.options && (r.options.length > 1 || (r.options[0]?.variants.length ?? 0) > 1));

export const sameChoice = (a: Choice | null | undefined, b: Choice | null | undefined) => Boolean(a && b && a.model === b.model && a.variant === b.variant);

/** The option and version a choice points at. */
export function chosen(r: ReqStatus, c: Choice | null | undefined): { option: ModelOption; variant: OptionVariant } | null {
  const option = c ? r.options?.find((o) => o.model === c.model) : undefined;
  const variant = option?.variants.find((v) => v.id === c!.variant);
  return option && variant ? { option, variant } : null;
}

/** "Needs 23 GB of RAM" → "needs 23 GB of RAM" (RAM, GB and names keep their capitals). */
export const lowerFirst = (s: string) => (/^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);
