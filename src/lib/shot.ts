/** Shared vocabulary for framing a shot: aspect ratios, counts and modes. */

export const ASPECTS = [
  { id: "1:1", w: 1, h: 1, label: "Square" },
  { id: "4:5", w: 4, h: 5, label: "Portrait post" },
  { id: "2:3", w: 2, h: 3, label: "Portrait" },
  { id: "9:16", w: 9, h: 16, label: "Story / Reel" },
  { id: "3:2", w: 3, h: 2, label: "Photo" },
  { id: "16:9", w: 16, h: 9, label: "Widescreen" },
  { id: "21:9", w: 21, h: 9, label: "Cinema" },
] as const;

export type AspectId = (typeof ASPECTS)[number]["id"];

export const aspectById = (id: string) => ASPECTS.find((a) => a.id === id) ?? ASPECTS[4];

/** Pixel size for an aspect at a given long edge, snapped to multiples of 16. */
export function sizeFor(aspect: AspectId, longEdge = 1536) {
  const a = aspectById(aspect);
  const snap = (n: number) => Math.max(256, Math.round(n / 16) * 16);
  return a.w >= a.h
    ? { width: snap(longEdge), height: snap((longEdge * a.h) / a.w) }
    : { width: snap((longEdge * a.w) / a.h), height: snap(longEdge) };
}
