import "server-only";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Ripple's paste-back outline, from its recipe to the runner. A swap made inside a 720p copy of a bigger clip is laid
 * onto the clip at its own size after the run (clip.finishAtSize). Keyed by the job's prepared clip (its path) and
 * taken once.
 * `file`: the outline as a clip in the clip's own frame order; `reach` and `height`: as layOnto had them (the made clip's
 * pixels).
 */
export type PasteMask = { file: string; reach: number; height: number };

const masks: Map<string, PasteMask> = ((globalThis as { __crackioPasteMasks?: Map<string, PasteMask> }).__crackioPasteMasks ??= new Map());

export function keepPasteMask(clip: string, mask: PasteMask) {
  const key = path.resolve(clip);
  const old = masks.get(key);
  if (old && old.file !== mask.file) void dropPasteMask(old);
  masks.set(key, mask);
}

export function takePasteMask(clip: string): PasteMask | null {
  const key = path.resolve(clip);
  const mask = masks.get(key) ?? null;
  masks.delete(key);
  return mask;
}

/** The outline's own folder, once it's used. */
export async function dropPasteMask(mask: PasteMask) {
  await fs.rm(path.dirname(mask.file), { recursive: true, force: true }).catch(() => {});
}
