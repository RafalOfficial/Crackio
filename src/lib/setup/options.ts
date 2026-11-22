import type { ModelOption, ReqStatus, SetupMachine } from "./types";

/**
 * A model part's choices on a machine, whole: each of the part's references (ReqStatus.options) with the machine's entry
 * for that model (SetupMachine.models), the part's own pick and version on top. A snapshot describes a model once per
 * machine, however many tools can use it; this puts the two back together for whoever shows or checks a choice
 * (Settings' Tools sheet, a set-up's plan). Client-safe. Empty when the snapshot is the light one, or the part isn't a
 * model part.
 */
export function optionsOf(machine: Pick<SetupMachine, "models"> | null | undefined, part: Pick<ReqStatus, "options"> | null | undefined): ModelOption[] {
  const table = machine?.models;
  const refs = part?.options;
  if (!table || !refs?.length) return [];
  let made = MADE.get(refs);
  if (!made || made.table !== table) {
    const list: ModelOption[] = [];
    for (const ref of refs) {
      const o = table[ref.model];
      if (o) list.push({ ...o, pick: Boolean(ref.pick), variant: ref.variant, knobs: ref.edit ? { ...o.knobs, edit: true } : o.knobs });
    }
    MADE.set(refs, (made = { table, list }));
  }
  return made.list;
}

/** Made once per look: a part's references are a new array only when a new snapshot came. */
const MADE = new WeakMap<object, { table: Record<string, ModelOption>; list: ModelOption[] }>();
