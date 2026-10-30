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
const CACHE = path.join(DATA_DIR, "cache", "storyboard-frames");
const WIDTHS = [120, 240];

const g = globalThis as unknown as { __crackioFrameSlots?: { busy: number; waiting: (() => void)[] } };
const slots = (g.__crackioFrameSlots ??= { busy: 0, waiting: [] });

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
  const q = new URL(request.url).searchParams;
  const url = q.get("url") ?? "";
  const t = Math.max(0, Math.round(Number(q.get("t") ?? 0) * 4) / 4);
  const w = WIDTHS.find((x) => x >= Number(q.get("w") ?? 120)) ?? WIDTHS[WIDTHS.length - 1];
  const file = urlToPath(url);
  if (!file || !/\.(mp4|m4v|mov|webm|mkv)$/i.test(file) || !Number.isFinite(t)) return new Response("Not found", { status: 404 });
  const name = `${createHash("sha1").update(`${url}|${t}|${w}`).digest("hex").slice(0, 24)}.jpg`;
  const cached = path.join(CACHE, name);
  let data: Buffer | null = await fs.readFile(cached).catch(() => null);
  if (!data) {
    data = await inSlot(() => frameAt(file, t, w)).catch(() => null);
    if (!data) return new Response("No frame there", { status: 404 });
    await fs.mkdir(CACHE, { recursive: true });
    await fs.writeFile(cached, data).catch(() => {});
  }
  return new Response(new Uint8Array(data), { headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=31536000, immutable" } });
}
