import { AUTO_PREFERENCE, type ModelAvailability, type ModelKind } from "./catalog";

/**
 * What "Auto" runs: your saved default, then a tool's own favorites (`prefer`), then Crackio's preference order, then
 * the first connected model. `fits` leaves out models a tool can't use (Cast needs one that takes pictures).
 * Shared by the pickers (what Auto says) and the server (what Auto runs), so the two never disagree.
 */
export function pickAuto(
  kind: ModelKind,
  models: ModelAvailability[],
  defaults: Partial<Record<ModelKind, string>>,
  prefer: string[] = [],
  fits: (m: ModelAvailability) => boolean = () => true,
): ModelAvailability | null {
  const usable = (m: ModelAvailability | undefined): m is ModelAvailability => Boolean(m?.available && m.kind === kind && fits(m));
  const byId = new Map(models.map((m) => [m.id, m]));
  for (const id of [defaults[kind], ...prefer, ...AUTO_PREFERENCE[kind]]) {
    const m = id ? byId.get(id) : undefined;
    if (usable(m)) return m;
  }
  return models.find(usable) ?? null;
}
