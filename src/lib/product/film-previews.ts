import manifest from "./film-previews.json";
import type { FilmAxis } from "./film";

/**
 * Video mode's previews: every option filmed through the real pipeline from sample pictures that
 * were themselves made in Image mode (scripts/assets/film-previews.mjs). The manifest says which
 * pictures each option was filmed from and what the director made of each.
 */
type Entry = { idea?: string; seconds?: number };
type StillEntry = { product: string; aspect: string; idea: string };
const M = manifest as unknown as Record<string, Record<string, Entry> | StillEntry>;

const BASE = "/assets/product/film";

/** The sample pictures: creators with products, products on their own, hands at work. */
export const FILM_STILLS = Object.entries(M)
  .filter(([k]) => k.startsWith("still-"))
  .map(([k, v]) => {
    const s = v as StillEntry;
    const id = k.slice(6);
    const [w, h] = s.aspect.split(":").map(Number);
    return { id, product: s.product, aspect: s.aspect, ratio: w / h, idea: s.idea, url: `${BASE}/stills/${id}.webp`, thumb: `${BASE}/stills/${id}-t.webp` };
  });

export type FilmStill = (typeof FILM_STILLS)[number];
export const stillById = (id: string) => FILM_STILLS.find((s) => s.id === id);

export type FilmPreview = { still: string; clip: string; poster: string; idea: string; ratio: number };

/** An option's preview clips, the picture each was filmed from first. */
export function filmPreviews(axis: FilmAxis, id: string): FilmPreview[] {
  const entry = M[`${axis}-${id}`] as Record<string, Entry> | undefined;
  if (!entry) return [];
  return Object.entries(entry).map(([still, e]) => ({
    still,
    clip: `${BASE}/${axis}-${id}-${still}.mp4`,
    poster: `${BASE}/${axis}-${id}-${still}.webp`,
    idea: e.idea ?? "",
    ratio: stillById(still)?.ratio ?? 9 / 16,
  }));
}

/** The preview a tile shows: one filmed from a picture like yours when there is one, else one per tile in turn. */
export function tilePreview(list: FilmPreview[], like: string | null, index: number): FilmPreview | null {
  if (!list.length) return null;
  const mine = like ? list.find((p) => stillById(p.still)?.product === like) : undefined;
  return mine ?? list[index % list.length];
}
