import "server-only";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { ffmpegPath, probe } from "@/lib/motion/ffmpeg";
import { urlToPath } from "@/lib/server/media";
import { DATA_DIR } from "@/lib/server/paths";
import { FPS, filmSize, lengthOf, placed, speedOf, type EditClip, type EditProject } from "./edit";

/**
 * A Storyboard project's timeline as one MP4: every picture and clip in order, each trimmed, sped up or slowed down,
 * filled or fitted to the film's shape and faded as set, with the clips' own sound and the music track mixed under it.
 */

/** Every piece's sound, made the same so they join: 48 kHz stereo. */
const AFMT = "aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo";

const num = (n: number) => (Math.round(n * 1000) / 1000).toString();

/** atempo goes no slower than half speed in one step: a quarter is two halves. */
function tempo(speed: number) {
  if (speed === 1) return "";
  const steps: string[] = [];
  let s = speed;
  while (s < 0.5) {
    steps.push("atempo=0.5");
    s /= 0.5;
  }
  steps.push(`atempo=${num(s)}`);
  return `,${steps.join(",")}`;
}

/** Fades over a piece `length` seconds long, as video (`fade`) or sound (`afade`) filters. */
function fades(filter: "fade" | "afade", c: EditClip, length: number) {
  const out: string[] = [];
  if (c.fadeIn && c.fadeIn > 0) out.push(`${filter}=t=in:st=0:d=${num(c.fadeIn)}`);
  if (c.fadeOut && c.fadeOut > 0) out.push(`${filter}=t=out:st=${num(Math.max(0, length - c.fadeOut))}:d=${num(c.fadeOut)}`);
  return out.length ? `,${out.join(",")}` : "";
}

export async function renderEdit(
  doc: EditProject,
  quality: "720p" | "1080p",
  { signal, progress }: { signal?: AbortSignal; progress?: (share: number) => void } = {},
): Promise<{ data: Buffer; width: number; height: number; duration: number }> {
  const [W, H] = filmSize(doc.aspect, quality);
  const list = placed(doc.timeline.main.filter((c) => c.kind !== "audio"));
  if (!list.length) throw new Error("Put some pictures or clips on the timeline first.");
  const total = list[list.length - 1].end;
  const frame = (fit: EditClip["fit"]) =>
    fit === "fit"
      ? `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p`
      : `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,format=yuv420p`;

  // Working files next to Crackio's data (the system temp folder can sit on a nearly full drive).
  const root = path.join(DATA_DIR, "cache", "storyboard-export");
  await fs.mkdir(root, { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, "film-"));
  try {
    const args = ["-hide_banner", "-y"];
    const graph: string[] = [];
    const pieces: string[] = [];
    let n = 0;
    for (const [i, p] of list.entries()) {
      const c = p.clip;
      const file = urlToPath(c.url);
      const there = file ? await fs.stat(file).then((st) => st.isFile()).catch(() => false) : false;
      if (!file || !there) throw new Error(`“${c.name ?? "A piece of the film"}” isn't on this computer anymore: take it off the timeline and export again.`);
      const length = p.end - p.start;
      const D = num(length);
      const silence = `anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=${D},${AFMT}[a${i}]`;
      if (c.kind === "image") {
        // Any picture Crackio keeps (WebP, AVIF, a cut-out with alpha) as a plain PNG ffmpeg reads the same everywhere.
        const still = path.join(dir, `still-${i}.png`);
        await sharp(file, { failOn: "none" }).rotate().flatten({ background: "#000000" }).png().toFile(still);
        if (c.push) {
          // A slow push in, drawn at twice the size so it glides instead of stepping.
          const frames = Math.max(1, Math.round(length * FPS));
          args.push("-i", still);
          graph.push(
            `[${n}:v]scale=${W * 2}:${H * 2}:force_original_aspect_ratio=increase,crop=${W * 2}:${H * 2},zoompan=z='1+0.06*on/${frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${W}x${H}:fps=${FPS},setsar=1,format=yuv420p,trim=duration=${D},setpts=PTS-STARTPTS${fades("fade", c, length)}[v${i}]`,
          );
        } else {
          args.push("-loop", "1", "-framerate", String(FPS), "-t", D, "-i", still);
          graph.push(`[${n}:v]${frame(c.fit)},fps=${FPS},trim=duration=${D},setpts=PTS-STARTPTS${fades("fade", c, length)}[v${i}]`);
        }
        graph.push(silence);
      } else {
        const info = await probe(file).catch(() => null);
        const s = speedOf(c);
        args.push("-i", file);
        // Held on its last frame if the file runs out early, so the sound and picture stay together.
        graph.push(
          `[${n}:v]trim=start=${num(c.in)}:end=${num(c.out)},setpts=(PTS-STARTPTS)/${num(s)},${frame(c.fit)},fps=${FPS},tpad=stop_mode=clone:stop_duration=${D},trim=duration=${D},setpts=PTS-STARTPTS${fades("fade", c, length)}[v${i}]`,
        );
        const volume = c.muted ? 0 : (c.volume ?? 1);
        if (info?.audio && volume > 0) {
          graph.push(
            `[${n}:a]atrim=start=${num(c.in)}:end=${num(c.out)},asetpts=PTS-STARTPTS${tempo(s)},volume=${num(volume)},${AFMT},apad,atrim=duration=${D}${fades("afade", c, length)}[a${i}]`,
          );
        } else graph.push(silence);
      }
      pieces.push(`[v${i}][a${i}]`);
      n++;
    }
    graph.push(`${pieces.join("")}concat=n=${pieces.length}:v=1:a=1[vout][amain]`);

    // The music track, each sound from where it starts in the film.
    const mixes: string[] = [];
    for (const [j, m] of doc.timeline.music.entries()) {
      const volume = m.muted ? 0 : (m.volume ?? 0.8);
      const file = urlToPath(m.url);
      const there = file ? await fs.stat(file).then((st) => st.isFile()).catch(() => false) : false;
      if (!file || !there || volume <= 0 || (m.at ?? 0) >= total) continue;
      args.push("-i", file);
      graph.push(
        `[${n}:a]atrim=start=${num(m.in)}:end=${num(m.out)},asetpts=PTS-STARTPTS${tempo(speedOf(m))},volume=${num(volume)}${fades("afade", m, lengthOf(m))},${AFMT},adelay=${Math.round((m.at ?? 0) * 1000)}:all=1[m${j}]`,
      );
      mixes.push(`[m${j}]`);
      n++;
    }
    let sound = "[amain]";
    if (mixes.length) {
      graph.push(`[amain]${mixes.join("")}amix=inputs=${mixes.length + 1}:duration=first:dropout_transition=0:normalize=0[aout]`);
      sound = "[aout]";
    }

    // The graph goes in a file: a long film's would pass the length Windows allows a command line.
    const script = path.join(dir, "graph.txt");
    await fs.writeFile(script, graph.join(";\n"));
    const out = path.join(dir, "film.mp4");
    args.push(
      "-filter_complex_script",
      script,
      "-map",
      "[vout]",
      "-map",
      sound,
      "-c:v",
      "libx264",
      "-preset",
      "fast",
      "-crf",
      "18",
      "-pix_fmt",
      "yuv420p",
      "-r",
      String(FPS),
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-movflags",
      "+faststart",
      "-t",
      num(total),
      out,
    );
    await ffmpegWithProgress(args, total, { signal, progress });
    return { data: await fs.readFile(out), width: W, height: H, duration: total };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** ffmpeg, reading how far it got from its log as it goes. */
function ffmpegWithProgress(args: string[], total: number, { signal, progress }: { signal?: AbortSignal; progress?: (share: number) => void }) {
  return new Promise<void>((resolve, reject) => {
    const proc = spawn(/*turbopackIgnore: true*/ ffmpegPath(), args, { windowsHide: true });
    let log = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      log = (log + text).slice(-20_000);
      const at = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
      if (at && total > 0) progress?.(Math.min(1, (Number(at[1]) * 3600 + Number(at[2]) * 60 + Number(at[3])) / total));
    });
    proc.stdout.resume();
    const kill = () => proc.kill("SIGKILL");
    const timer = setTimeout(kill, 40 * 60_000);
    signal?.addEventListener("abort", kill, { once: true });
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", kill);
      if (code === 0) return resolve();
      const why = log
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(-3)
        .join(" ");
      reject(new Error(signal?.aborted ? "Cancelled." : `ffmpeg couldn't put the film together: ${why}`));
    });
    proc.stdin.end();
  });
}
