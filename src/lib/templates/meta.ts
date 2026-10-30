import type { Template } from "./types";

/** What a template swaps, in a word or two, for its card: "1 person", "2 people", "1–3 pets", "Car", "Kit". */
export function swapLabel(t: Template) {
  if (t.kind === "kit") return "Kit";
  if (t.kind === "effect") return "Effect";
  const people = t.slots.filter((s) => s.kind === "person" && !s.optional).length;
  if (people >= 2) return `${people} people`;
  const first = t.slots[0];
  if (!first) return "Swap";
  if (first.kind === "face") return "Face";
  if (first.kind === "pet") {
    const pets = t.slots.filter((s) => s.kind === "pet").length;
    return pets > 1 ? `1–${pets} pets` : "Pet";
  }
  if (first.kind === "object") return /car/i.test(first.label) ? "Car" : "Product";
  if (first.kind === "place") return "Place";
  return "1 person";
}

/** How lively a template is (1–5). `now` (unknown while a page prerenders) gives a seasonal one its last-week push. */
export function heatOf(t: Template, now?: number | null) {
  const heat = t.trend.heat;
  const left = t.seasonal && now ? (Date.parse(t.seasonal.end) - now) / 86_400_000 : Infinity;
  return left >= 0 && left <= 10 ? Math.min(5, heat + 1) : heat;
}

/** Whether a template is in season (seasonal ones hide once their date passes; all show until the time is known). */
export const inSeason = (t: Template, now?: number | null) => !t.seasonal || !now || now <= Date.parse(t.seasonal.end) + 86_400_000;

/** The card's badge, when it has one: "Halloween · until Oct 31". */
export function heatBadge(t: Template): string | null {
  if (t.trend.views) return t.seasonal ? `${t.trend.views} · ${t.seasonal.label.split(" · ")[0]}` : t.trend.views;
  if (t.seasonal) return t.seasonal.label;
  return null;
}
