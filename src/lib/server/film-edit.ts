import "server-only";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { probe, runFfmpeg } from "@/lib/motion/ffmpeg";

/**
 * Product Studio's cutting room for Video mode: the edits a creator would make on their phone,
 * done exactly instead of hoping a video model does them: the picture's own shape kept, punch-ins
 * on the key words, a snap zoom on the first beat, parts joined into one clip.
 */

/** A zoom held over part of a clip: `zoom` 1.25 crops to 80 %, centered on (`x`, `y`) in 0–1. */
export type Punch = { from: number; to: number; zoom: number; x: number; y: number; ramp?: number };

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

async function temp<T>(fn: (dir: string) => Promise<T>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "crackio-film-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const ENCODE = ["-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart"];

/**
 * The clip at its picture's shape. Some models hand back a start frame's clip in a nearby standard
 * shape, stretched (Grok returns a 4:5 picture as 3:4); scaling it back undoes the stretch exactly.
 */
export async function keepShape(data: Buffer, ratio: number): Promise<{ data: Buffer; width: number; height: number }> {
  return temp(async (dir) => {
    const src = path.join(dir, "in.mp4");
    await fs.writeFile(src, data);
    const info = await probe(src);
    const w = info.width ?? 0;
    const h = info.height ?? 0;
    if (!w || !h || Math.abs(Math.log(w / h / ratio)) < 0.015) return { data, width: w, height: h };
    // Keep the long edge; the other edge follows the picture's shape.
    const width = ratio >= w / h ? w : even(h * ratio);
    const height = ratio >= w / h ? even(w / ratio) : h;
    const out = path.join(dir, "out.mp4");
    const run = await runFfmpeg(["-y", "-i", src, "-vf", `scale=${width}:${height}:flags=lanczos,setsar=1`, ...ENCODE, "-c:a", "copy", out]);
    if (run.code !== 0) return { data, width: w, height: h };
    return { data: await fs.readFile(out), width, height };
  });
}

/**
 * Punch-ins and snap zooms: per frame, the picture is cropped in by `zoom` around a point and scaled
 * back up, like a phone's digital zoom (a ramp makes it a fast push instead of a cut).
 */
export async function punchIns(data: Buffer, punches: Punch[]): Promise<Buffer> {
  if (!punches.length) return data;
  return temp(async (dir) => {
    const src = path.join(dir, "in.mp4");
    await fs.writeFile(src, data);
    const info = await probe(src);
    const W = info.width ?? 0;
    const H = info.height ?? 0;
    if (!W || !H) return data;
    const span = (p: Punch) => `between(it,${p.from.toFixed(3)},${p.to.toFixed(3)})`;
    // zoom(t): 1 outside the punches; inside, the punch's zoom (ramped in over `ramp` seconds when asked).
    const z = punches
      .map((p) => `${span(p)}*${(p.zoom - 1).toFixed(3)}*${p.ramp && p.ramp > 0 ? `min(1,(it-${p.from.toFixed(3)})/${p.ramp.toFixed(3)})` : "1"}`)
      .join("+");
    // Where each punch looks (between punches the zoom is 1, so the center doesn't matter).
    const inside = punches.map(span).join("+");
    const cx = `if(gt(${inside},0),${punches.map((p) => `${span(p)}*${p.x.toFixed(3)}`).join("+")},0.5)`;
    const cy = `if(gt(${inside},0),${punches.map((p) => `${span(p)}*${p.y.toFixed(3)}`).join("+")},0.5)`;
    // One output frame per input frame (d=1), the window kept inside the picture.
    const filter = `zoompan=z='1+${z}':x='max(0,min(iw-iw/zoom,iw*(${cx})-iw/zoom/2))':y='max(0,min(ih-ih/zoom,ih*(${cy})-ih/zoom/2))':d=1:s=${W}x${H}:fps=${Math.round(info.fps ?? 24)},setsar=1`;
    const out = path.join(dir, "out.mp4");
    const run = await runFfmpeg(["-y", "-i", src, "-vf", filter, ...ENCODE, "-c:a", "copy", out]);
    if (run.code !== 0) {
      console.warn(`[film] punch-ins failed: ${run.stderr.split("\n").filter(Boolean).slice(-2).join(" ")}`);
      return data;
    }
    return fs.readFile(out);
  });
}

/** Parts of one take, one after another, picture and sound; each part from its `in` to its `out` (seconds). */
export async function joinParts(parts: { data: Buffer; in?: number; out?: number }[], { width, height, fade = 0 }: { width: number; height: number; fade?: number }): Promise<Buffer> {
  if (parts.length === 1 && parts[0].in === undefined && parts[0].out === undefined) return parts[0].data;
  return temp(async (dir) => {
    const inputs: string[] = [];
    const chains: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      const file = path.join(dir, `p${i}.mp4`);
      await fs.writeFile(file, parts[i].data);
      const info = await probe(file);
      const from = Math.max(0, parts[i].in ?? 0);
      const to = Math.min(info.duration ?? 9999, parts[i].out ?? info.duration ?? 9999);
      inputs.push("-i", file);
      const fit = `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},fps=24,setsar=1,format=yuv420p`;
      chains.push(`[${i}:v:0]trim=start=${from.toFixed(3)}:end=${to.toFixed(3)},setpts=PTS-STARTPTS,${fit}[v${i}]`);
      chains.push(
        info.audio
          ? `[${i}:a:0]atrim=start=${from.toFixed(3)}:end=${to.toFixed(3)},asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo${fade ? `,afade=t=in:d=${fade},afade=t=out:st=${Math.max(0, to - from - fade).toFixed(3)}:d=${fade}` : ""}[a${i}]`
          : `anullsrc=r=48000:cl=stereo,atrim=duration=${(to - from).toFixed(3)}[a${i}]`,
      );
    }
    const n = parts.length;
    const graph = `${chains.join(";")};${Array.from({ length: n }, (_, i) => `[v${i}][a${i}]`).join("")}concat=n=${n}:v=1:a=1[v][a]`;
    const out = path.join(dir, "joined.mp4");
    const run = await runFfmpeg(["-y", ...inputs, "-filter_complex", graph, "-map", "[v]", "-map", "[a]", ...ENCODE, "-c:a", "aac", "-b:a", "192k", out]);
    if (run.code !== 0) throw new Error(`Couldn't join the parts: ${run.stderr.split("\n").filter(Boolean).slice(-2).join(" ")}`);
    return fs.readFile(out);
  });
}

/** A clip's last good frame as a PNG file (the next part starts from it). */
export async function lastFrame(data: Buffer, dest: string, at?: number): Promise<string> {
  return temp(async (dir) => {
    const src = path.join(dir, "in.mp4");
    await fs.writeFile(src, data);
    const info = await probe(src);
    const t = Math.max(0, Math.min(at ?? (info.duration ?? 1) - 0.06, (info.duration ?? 1) - 0.06));
    const grab = (s: number) => runFfmpeg(["-hide_banner", "-loglevel", "error", "-ss", s.toFixed(3), "-i", src, "-frames:v", "1", "-f", "image2pipe", "-c:v", "png", "-"], { timeoutMs: 30_000 });
    let r = await grab(t);
    if (!r.stdout.length && t > 0.2) r = await grab(t - 0.2);
    if (!r.stdout.length) throw new Error("Couldn't read the clip's last frame.");
    await fs.writeFile(dest, r.stdout);
    return dest;
  });
}

/** Seconds of a clip held in memory. */
export async function lengthOf(data: Buffer): Promise<number> {
  return temp(async (dir) => {
    const src = path.join(dir, "in.mp4");
    await fs.writeFile(src, data);
    return (await probe(src)).duration ?? 0;
  });
}
