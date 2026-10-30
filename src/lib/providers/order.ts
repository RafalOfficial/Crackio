import type { ProviderId } from "./types";

/** Engine preference when a tool is left on Auto: your Comfy key, then your own ComfyUIs. */
export const AUTO_ORDER: ProviderId[] = ["comfy-cloud", "comfy-local"];

export const byAutoOrder = <T extends { id: ProviderId }>(items: T[]) =>
  [...items].sort((a, b) => AUTO_ORDER.indexOf(a.id) - AUTO_ORDER.indexOf(b.id));
