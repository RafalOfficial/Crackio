import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { frameAt } from "@/lib/motion/ffmpeg";
import { urlToPath } from "@/lib/server/media";
import { DATA_DIR } from "@/lib/server/paths";

/**
 * A frame of one of Crackio's clips at `t` seconds, `w` pixels wide: the strips of frames on the Storyboard timeline.
 * Each is made once and kept (clips are written once under their own name), a few at a time so a long timeline
 * opening doesn't start dozens of ffmpegs at once.
 */
const CACHE = path.join(/*turbopackIgnore: true*/ DATA_DIR, "cache", "storyboard-frames");
const WIDTHS = [120, 240];
/** A safety valve only: far more frames waiting than any timeline asks for at once (lazy images ask for what's on screen). */
const MAX_WAITING = 400;
/** A frame that couldn't be made isn't tried again for a while (a clip shorter than it says, a broken file). */
const MISS_MS = 10 * 60_000;

const g = globalThis as unknown as {
  __crackioFrameSlots?: { busy: number; waiting: (() => void)[] };
  __crackioFrameWork?: Map<string, Promise<Buffer | null>>;
  __crackioFrameMisses?: Map<string, number>;
};
const slots = (g.__crackioFrameSlots ??= { busy: 0, waiting: [] });
// The same frame asked for twice at once (two strips of the same clip) is made once.
const inFlight = (g.__crackioFrameWork ??= new Map());
const misses = (g.__crackioFrameMisses ??= new Map());

async function inSlot<T>(work: () => Promise<T>): Promise<T> {
  if (slots.busy >= 3) await new Promise<void>((resolve) => slots.waiting.push(resolve));
  slots.busy++;
  try {
    return await work();
  } finally {
    slots.busy--;
    slots.waiting.shift()?.();
  }
}

export async function GET(request: Request) {
  // Only Crackio's own pages: another website pointing <img> tags here could otherwise keep ffmpeg busy and fill the cache.
  if (request.headers.get("sec-fetch-site") === "cross-site") return new Response("Not found", { status: 404 });
  const q = new URL(request.url).searchParams;
  const url = q.get("url") ?? "";
  const t = Math.max(0, Math.round(Number(q.get("t") ?? 0) * 4) / 4);
  const w = WIDTHS.find((x) => x >= Number(q.get("w") ?? 120)) ?? WIDTHS[WIDTHS.length - 1];
  const file = urlToPath(url);
  if (!file || !/\.(mp4|m4v|mov|webm|mkv)$/i.test(file) || !Number.isFinite(t)) return new Response("Not found", { status: 404 });
  const name = `${createHash("sha1").update(`${url}|${t}|${w}`).digest("hex").slice(0, 24)}.jpg`;
  const cached = path.join(/*turbopackIgnore: true*/ CACHE, name);
  let data: Buffer | null = await fs.readFile(/*turbopackIgnore: true*/ cached).catch(() => null);
  if (!data) {
    const missed = misses.get(name);
    if (missed && Date.now() - missed < MISS_MS) return new Response("No frame there", { status: 404 });
    let work = inFlight.get(name);
    if (!work) {
      if (slots.waiting.length >= MAX_WAITING) return new Response("Busy", { status: 503, headers: { "Retry-After": "2" } });
      work = (async () => {
        const made = await inSlot(() => frameAt(file, t, w)).catch(() => null);
        if (!made) {
          misses.set(name, Date.now());
          if (misses.size > 2000) misses.delete(misses.keys().next().value!);
          return null;
        }
        await fs.mkdir(/*turbopackIgnore: true*/ CACHE, { recursive: true });
        await fs.writeFile(/*turbopackIgnore: true*/ cached, made).catch(() => {});
        return made;
      })().finally(() => inFlight.delete(name));
      inFlight.set(name, work);
    }
    data = await work;
    if (!data) return new Response("No frame there", { status: 404 });
  }
  return new Response(new Uint8Array(data), { headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=31536000, immutable" } });
}
