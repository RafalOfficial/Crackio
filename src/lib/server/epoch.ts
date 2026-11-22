/**
 * A counter that goes up whenever something the model lists and machine looks depend on changes: settings (defaults,
 * keys, Run on), machines added or removed, a machine going online or offline, a model installed or removed, a set-up
 * finishing. Caches remember the epoch they were built in and are thrown away once it moves, so a model installed a
 * second ago is in the next list.
 */
const g = globalThis as unknown as { __crackioEpoch?: number };

export const epoch = () => g.__crackioEpoch ?? 0;

export function bumpEpoch() {
  g.__crackioEpoch = epoch() + 1;
}
