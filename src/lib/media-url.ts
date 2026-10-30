/**
 * Light copies of Crackio's own media for the places that show it small (cards, strips, chips): a
 * WebP still, or a short muted preview of a clip, a few hundred pixels wide. The server makes each
 * one once and keeps it (lib/server/previews); viewers and downloads keep using the original.
 * Anything that isn't Crackio's media (site assets, blob: previews, remote URLs) passes through.
 */

/** The widths copies are made at; a request snaps up to the next one, so the cache stays small. */
export const PREVIEW_WIDTHS = [160, 320, 480, 640, 960, 1280] as const;

export const previewWidth = (w: number) => PREVIEW_WIDTHS.find((p) => p >= w) ?? PREVIEW_WIDTHS[PREVIEW_WIDTHS.length - 1];

const OWN = /^\/api\/media\/(?:out|uploads|templates)\//;

/** `url` at `width` pixels wide; `poster` asks for a clip's opening frame as a still. */
export function previewUrl(url: string, width: number, variant?: "poster") {
  if (!OWN.test(url)) return url;
  const [path, hash] = url.split("#");
  // (`v` is taken: some URLs carry their file's version in it.)
  const q = `w=${previewWidth(width)}${variant === "poster" ? "&poster=1" : ""}`;
  return `${path}${path.includes("?") ? "&" : "?"}${q}${hash ? `#${hash}` : ""}`;
}

/** A clip's opening frame as a still, to show until it plays (none for media that isn't Crackio's). */
export const posterUrl = (url: string, width: number) => (OWN.test(url) ? previewUrl(url, width, "poster") : undefined);

/** A `srcset` of the copies, for the browser to pick from by the slot's size and the screen's density. */
export function previewSrcSet(url: string, widths: readonly number[] = [320, 480, 640, 960], variant?: "poster") {
  if (!OWN.test(url)) return undefined;
  return widths.map((w) => `${previewUrl(url, w, variant)} ${previewWidth(w)}w`).join(", ");
}
