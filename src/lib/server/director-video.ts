import "server-only";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { DATA_DIR } from "./paths";
import { saveFileUpload, saveUpload, urlToPath } from "./media";
import { imageJob } from "./director";
import { stageOf, studioState } from "./director-real";
import { probe, runFfmpeg } from "@/lib/motion/ffmpeg";
import { sceneAt } from "@/lib/director/timeline";
import { aspectById } from "@/lib/shot";
import { askText } from "@/lib/engines/refine";
import type { Scene } from "@/lib/director/types";
import type { Generation } from "@/lib/generations/types";
import { EngineError, type Engine, type EngineContext, type EngineJob, type EngineResult } from "@/lib/engines/types";

const DIR = path.join(/*turbopackIgnore: true*/ DATA_DIR, "cache", "director-video");

/** The model the re-shoot runs (local/catalog `director-video`), and the one that draws its first frame from the new angle. */
export const VIDEO_MODEL = "local:director-video";
const LOOK_MODEL = "local:director-world";
/** Layout to Render's frame rate (its card: "Prefer 24 fps"); the clip is brought to it. */
export const RESHOOT_FPS = 24;
/** The longest re-shoot, in frames at 24 fps (8k+1): a draft runs only the first stage, so it can be longer. */
export const RESHOOT_CAP = { draft: 241, final: 121 } as const;

/** What the Director sends with a video re-shoot (Generation params `reshoot`). */
export type ReshootSpec = {
  version: 1;
  /** The video you dropped (as uploaded). */
  videoUrl: string;
  /** MoGe's meters per unit of the stage's 3D set (lib/director/moge-scale), so the Camera moves as far as you set it. */
  meters?: number;
  /** "draft": the first stage only, at about 0.5 MP. Else both stages (about 2 MP). */
  quality?: "draft" | "final";
  /** Also give the model the last frame from the new angle, so the picture holds to the end (their card's tip). */
  hold?: boolean;
};

/** 8k+1 frames, at most `cap`: LTX's frame grid. */
export const onGrid = (frames: number, cap: number) => Math.max(9, Math.floor((Math.min(frames, cap) - 1) / 8) * 8 + 1);

/**
 * The first stage's size for a frame shape: both sides on the 32 grid (so the second stage's are on 64), the shape kept
 * within a hair, about Lightricks' 960×544 (0.52 MP) in area: 960×544 for 16:9, 544×960 for 9:16.
 */
export function stageSize(aspect: number) {
  let best = { width: 960, height: 544, score: Infinity };
  for (let h = 320; h <= 1280; h += 32) {
    const w = Math.round((h * aspect) / 32) * 32;
    if (w < 320 || w > 1280) continue;
    const score = Math.abs(Math.log(w / h / aspect)) * 12 + Math.abs(Math.log((w * h) / (960 * 544)));
    if (score < best.score) best = { width: w, height: h, score };
  }
  return { width: best.width, height: best.height };
}

type Prepared = { clip: string; frame0: string; middle: string; last: string; audio: string | null; frames: number; width: number; height: number };

/**
 * The clip as the re-shoot takes it: 24 fps, its first `frames` frames (8k+1), at most 1280 on its long side, no sound;
 * its first, middle and last frames as pictures, and its sound on its own (put back on the result). Kept by the file's
 * content.
 */
async function prepareClip(file: string, cap: number, signal: AbortSignal): Promise<Prepared> {
  const info = await probe(file);
  if (info.kind !== "video" || !info.duration) throw new EngineError("That file isn't a video Crackio can read.");
  const frames = onGrid(Math.floor(info.duration * RESHOOT_FPS), cap);
  const st = await fs.stat(/*turbopackIgnore: true*/ file);
  const key = createHash("sha256").update(`${file}|${st.size}|${st.mtimeMs}|${frames}|v1`).digest("hex").slice(0, 16);
  const dir = path.join(/*turbopackIgnore: true*/ DIR, key);
  const clip = path.join(/*turbopackIgnore: true*/ dir, "clip.mp4");
  const frame0 = path.join(/*turbopackIgnore: true*/ dir, "frame0.png");
  const middle = path.join(/*turbopackIgnore: true*/ dir, "middle.png");
  const last = path.join(/*turbopackIgnore: true*/ dir, "last.png");
  const audio = path.join(/*turbopackIgnore: true*/ dir, "audio.m4a");
  const have = async (p: string) => (await fs.stat(/*turbopackIgnore: true*/ p).catch(() => null))?.size ?? 0;
  if (!(await have(clip)) || !(await have(frame0)) || !(await have(middle)) || !(await have(last))) {
    await fs.mkdir(/*turbopackIgnore: true*/ dir, { recursive: true });
    const scale = "scale='if(gt(iw,ih),min(1280,iw),-2)':'if(gt(iw,ih),-2,min(1280,ih))':flags=lanczos";
    const run = async (args: string[]) => {
      const r = await runFfmpeg(["-hide_banner", "-loglevel", "error", "-y", ...args], { signal, timeoutMs: 10 * 60_000 });
      if (r.code !== 0) throw new EngineError(`Couldn't prepare the video: ${r.stderr.trim().slice(0, 200)}`);
    };
    await run(["-i", file, "-vf", `fps=${RESHOOT_FPS},${scale},setsar=1`, "-frames:v", String(frames), "-an", "-c:v", "libx264", "-crf", "12", "-preset", "medium", "-pix_fmt", "yuv420p", clip]);
    await run(["-i", clip, "-frames:v", "1", frame0]);
    await run(["-i", clip, "-vf", `select=eq(n\\,${Math.floor(frames / 2)})`, "-frames:v", "1", middle]);
    await run(["-i", clip, "-vf", `select=eq(n\\,${frames - 1})`, "-frames:v", "1", last]);
    if (info.audio) await run(["-i", file, "-vn", "-t", (frames / RESHOOT_FPS).toFixed(3), "-c:a", "aac", "-b:a", "192k", audio]).catch(() => undefined);
  }
  const made = await probe(clip);
  return { clip, frame0, middle, last, audio: (await have(audio)) ? audio : null, frames: Math.min(frames, Math.round((made.duration ?? frames / RESHOOT_FPS) * RESHOOT_FPS)) || frames, width: made.width ?? 1280, height: made.height ?? 720 };
}

/**
 * A video dropped in the Director, read for the stage: what it is and its first frame as a picture (the photo the 3D set
 * is built from, at the video's own size). Videos past 20 s are taken up to their first 10 s by the timeline.
 */
export async function prepareVideoPlace(url: string, signal?: AbortSignal) {
  const file = urlToPath(url);
  if (!file) throw new Error("That video isn't in Crackio's files.");
  const info = await probe(file);
  if (info.kind !== "video" || !info.duration || !info.width || !info.height) throw new Error("That file isn't a video Crackio can read.");
  if (info.duration < 1) throw new Error("That video is shorter than a second.");
  const r = await runFfmpeg(["-hide_banner", "-loglevel", "error", "-i", file, "-frames:v", "1", "-f", "image2pipe", "-c:v", "png", "-"], { signal, timeoutMs: 60_000 });
  if (r.code !== 0 || !r.stdout.length) throw new Error("Couldn't read the video's first frame.");
  const poster = await saveUpload(r.stdout);
  return {
    video: { url, width: info.width, height: info.height, fps: info.fps ?? RESHOOT_FPS, frames: Math.round(info.duration * (info.fps ?? RESHOOT_FPS)), duration: info.duration, audio: Boolean(info.audio) },
    poster: { url: poster.url, width: poster.width, height: poster.height },
  };
}

type Studio = NonNullable<ReturnType<typeof studioState>>;

/**
 * Your Camera path as the winner's Panorama Studio state: the Director's Camera at every frame of the clip (the stage's
 * timeline at that time, `sceneAt`), each a key of its own, so the render follows exactly what the stage showed. The clip
 * is 24 fps; a timeline at another rate is read at the same seconds.
 */
export function studioVideo(scene: Scene, meters: number, frames: number) {
  const fps = scene.timeline?.fps ?? RESHOOT_FPS;
  const at = (t: number) => studioState(sceneAt(scene, Math.round((t * fps) / RESHOOT_FPS)), meters);
  const first = at(0);
  if (!first) return undefined;
  const all: Studio[] = [first];
  for (let t = 1; t < frames; t++) all.push(at(t) ?? first);
  const lane = <T,>(read: (s: Studio) => T) => ({ value: read(first), keyframes: all.map((s, frame) => ({ frame, value: read(s), easing: [0, 0, 1, 1] })) });
  return {
    ...first,
    timeline: { fps: RESHOOT_FPS, length: null },
    camera: {
      ...first.camera,
      position: lane((s) => s.camera.position.value),
      rotation: lane((s) => s.camera.rotation.value),
      fov: lane((s) => s.camera.fov.value),
    },
  };
}

/** The clip's own lens, as the stage's set has it (horizontal degrees): MoGe-3 is told it, so its frames line up with the set. */
export function sourceHfov(scene: Scene) {
  const image = scene.place.image;
  if (!image?.view) return undefined;
  return (2 * Math.atan(Math.tan((image.view.fov * Math.PI) / 360) * (image.width / Math.max(1, image.height))) * 180) / Math.PI;
}

/**
 * Whether a Camera is the clip's own (where it stood, how it was turned, its lens): then the clip's frame is the look as
 * it is (cropped to the frame by the guide). The lens is judged up and down: the frame can be a little narrower than the
 * clip (16:9 framing a 1.82:1 clip) with the same lens.
 */
function isSourceCamera(s: Studio, vfov: number | undefined) {
  const [x, y, z] = s.camera.position.value;
  const r = s.camera.rotation.value;
  const turned = Math.max(Math.abs(r.yaw_deg), Math.abs(r.pitch_deg), Math.abs(r.roll_deg));
  const own = (2 * Math.atan(Math.tan((s.camera.fov.value * Math.PI) / 360) / Math.max(0.1, s.camera.aspect)) * 180) / Math.PI;
  return Math.hypot(x, y, z) < 0.03 && turned < 0.4 && (vfov === undefined || Math.abs(own - vfov) < 0.5);
}

/** One frame of the clip seen from the Camera at that time: the Director's 3D World shot (Qwen-Image 2.1 + AnyAngle on MoGe-3). */
async function lookFrom(job: EngineJob, frame: string, studio: Studio, hfov: number | undefined, ctx: EngineContext, report: (v: number, stage?: string) => void, from: number, to: number) {
  const { job: base, engine } = await imageJob(LOOK_MODEL, typeof job.options?.machine === "string" ? job.options.machine : undefined);
  const { outputs } = await engine.run(
    {
      ...base,
      aspect: job.aspect,
      width: job.width,
      height: job.height,
      count: 1,
      prompt: "",
      userPrompt: "",
      refine: false,
      references: [{ path: frame, label: "the clip's frame", role: "subject" }],
      options: { ...base.options, quality: "best", frame: true, studio, ...(hfov ? { mogeFov: hfov } : {}) },
    },
    { signal: ctx.signal, progress: (v, stage) => report(from + v * (to - from), stageOf("Drawing the first frame from the new angle", stage)) },
  );
  if (!outputs[0]) throw new EngineError("The first frame from the new angle came back empty.");
  return outputs[0].data;
}

/** A static Camera state (the one at frame `t`), for the look still's render. */
const still = (s: Studio): Studio => ({ ...s, camera: { ...s.camera, position: { value: s.camera.position.value, keyframes: [] }, rotation: { value: s.camera.rotation.value, keyframes: [] }, fov: { value: s.camera.fov.value, keyframes: [] } } });

/**
 * The words Layout to Render wants (their card: one or two sentences describing the finished shot, matching the first
 * frame; never "clay" or "3D"), read by a text model from the first frame and the clip's middle and end (what happens),
 * with your words when you wrote some. Told to write it as a shot description: from the first frame alone it wrote "I'm
 * standing in front of the hotel" for a woman sitting in a car, and missed her putting on sunglasses (Nov 14).
 */
async function promptFor(words: string, look: string, middle: string, last: string, signal: AbortSignal) {
  const yours = words.trim();
  const read = await askText({
    instructions:
      "You write the prompt for a video model that films a shot starting on the first picture. The other two pictures are the same shot's middle and end, from the original camera: they show what happens. In one or two sentences, in the third person and the present tense, like a film script's shot description, say who and what is in it (what they look like and wear), where, the light and the mood, and what they do through the shot. Never 'I' or 'we', no camera directions, never the words clay, 3D, render or Unreal. Reply with the sentences only.",
    text: yours ? `What happens in the shot, in the person's own words: ${yours}` : "Describe the shot.",
    references: [
      { path: look, label: "the first frame (the shot starts here)" },
      { path: middle, label: "the middle of the original shot" },
      { path: last, label: "the end of the original shot" },
    ],
    imageEdge: 768,
    timeoutMs: 90_000,
    signal,
  }).catch(() => null);
  const clean = (read ?? "").replace(/\s+/g, " ").replace(/^["']|["']$/g, "").trim();
  if (clean.length > 20) return clean.slice(0, 900);
  return yours || "A cinematic shot, true to the first frame: the same people, place, light and colors.";
}

/**
 * The Director's video mode: the video you dropped, filmed again along the Camera path you set (the Crackio challenge
 * winner's video re-shoot, with Lightricks' Layout to Render finishing it, engines/comfy-local-recipes DIRECTOR_VIDEO).
 * The clip is brought to 24 fps and LTX's frame grid; its first frame is drawn from the new angle (or kept, when the
 * path starts at the clip's own camera); the layout and that look become the shot; the clip's sound goes back on.
 */
export async function runDirectorVideo(job: EngineJob, gen: Generation, engine: Engine, ctx: EngineContext): Promise<EngineResult & { layoutUrl?: string; lookUrl?: string }> {
  const spec = gen.params?.reshoot as ReshootSpec | undefined;
  const scene = gen.params?.scene as Scene | undefined;
  const file = spec?.videoUrl ? urlToPath(spec.videoUrl) : null;
  if (!spec || !scene || !file) throw new EngineError("This re-shoot is missing its video.", "Drop the video in the Director again.");
  if (!scene.place.image?.view) throw new EngineError("The video's 3D set isn't ready yet.", "Wait for the stage to show the video in 3D, then film it again.");
  const draft = spec.quality === "draft";
  // Never backwards: a job's steps start again at each node that counts its own (MoGe's frames, then the Studio's).
  let shown = 0;
  const progress = (v: number, stage?: string) => {
    shown = Math.max(shown, v);
    ctx.progress(shown, stage);
  };
  progress(0.02, "Preparing the video");
  const clip = await prepareClip(file, draft ? RESHOOT_CAP.draft : RESHOOT_CAP.final, ctx.signal);
  const meters = typeof spec.meters === "number" && spec.meters > 0 ? spec.meters : 1;
  const studio = studioVideo(scene, meters, clip.frames);
  if (!studio) throw new EngineError("The video's 3D set isn't ready yet.");
  const hfov = sourceHfov(scene);
  // The Camera's frame (what you framed on the stage), not the clip's own shape: the Studio renders that frame.
  const frame = aspectById(scene.aspect);
  const { width, height } = stageSize(frame.w / frame.h);
  const sub = (extra: Record<string, unknown>, more: Partial<EngineJob> = {}): EngineJob => ({
    ...job,
    kind: "video",
    width,
    height,
    count: 1,
    refine: false,
    references: [],
    ...more,
    options: { ...job.options, ...more.options, ...(draft ? { quality: "draft" } : {}), mogeFov: hfov, extra: { ...extra, frames: clip.frames, fps: RESHOOT_FPS } },
  });

  // The layout (MoGe-3 on every frame, the Studio along your path) and the look, side by side: one GPU takes them in turn.
  const first = studio.camera.position.keyframes[0];
  const start = still({ ...studio, camera: { ...studio.camera, position: { value: first.value, keyframes: [] }, rotation: { value: studio.camera.rotation.keyframes[0].value, keyframes: [] }, fov: { value: studio.camera.fov.keyframes[0].value, keyframes: [] } } });
  const endIdx = clip.frames - 1;
  const end = still({ ...studio, camera: { ...studio.camera, position: { value: studio.camera.position.keyframes[endIdx].value, keyframes: [] }, rotation: { value: studio.camera.rotation.keyframes[endIdx].value, keyframes: [] }, fov: { value: studio.camera.fov.keyframes[endIdx].value, keyframes: [] } } });
  const vfov = scene.place.image.view.fov;
  const kept = isSourceCamera(start, vfov);
  const [layoutRun, lookData, lastData] = await Promise.all([
    engine.run(sub({ step: "layout" }, { source: { path: clip.clip, label: "the clip" }, options: { studio } }), {
      signal: ctx.signal,
      progress: (v, stage) => progress(0.04 + v * 0.36, stageOf("Measuring every frame in 3D and laying out your camera", stage)),
    }),
    kept ? fs.readFile(/*turbopackIgnore: true*/ clip.frame0) : lookFrom(job, clip.frame0, start, hfov, ctx, progress, 0.4, 0.5),
    spec.hold && !isSourceCamera(end, vfov) ? lookFrom(job, clip.last, end, hfov, ctx, progress, 0.5, 0.58) : Promise.resolve(null),
  ]);
  const layout = layoutRun.outputs.find((o) => o.mime.startsWith("video/"));
  if (!layout) throw new EngineError("The camera layout came back empty.");
  const work = path.join(/*turbopackIgnore: true*/ DIR, `${gen.id}`);
  await fs.mkdir(/*turbopackIgnore: true*/ work, { recursive: true });
  const layoutFile = path.join(/*turbopackIgnore: true*/ work, "layout.mp4");
  const lookFile = path.join(/*turbopackIgnore: true*/ work, "look.png");
  await fs.writeFile(/*turbopackIgnore: true*/ layoutFile, layout.data);
  await fs.writeFile(/*turbopackIgnore: true*/ lookFile, await sharp(lookData).png().toBuffer());
  const keys: NonNullable<EngineJob["keyframes"]> = [];
  if (lastData) {
    const lastFile = path.join(/*turbopackIgnore: true*/ work, "last.png");
    await fs.writeFile(/*turbopackIgnore: true*/ lastFile, await sharp(lastData).png().toBuffer());
    keys.push({ path: lastFile, label: "the last frame", t: endIdx });
  }

  progress(0.6, "Writing what the shot shows");
  const prompt = await promptFor(gen.prompt ?? "", lookFile, clip.middle, clip.last, ctx.signal);
  const filmed = await engine.run(sub({ step: "film" }, { prompt, userPrompt: gen.prompt ?? "", source: { path: layoutFile, label: "the camera layout" }, start: { path: lookFile, label: "the first frame" }, keyframes: keys }), {
    signal: ctx.signal,
    progress: (v, stage) => progress(0.62 + v * 0.34, stageOf(draft ? "Filming the draft" : "Filming it", stage)),
  });
  const video = filmed.outputs.find((o) => o.mime.startsWith("video/"));
  if (!video) throw new EngineError("The video model returned no clip.");

  // The clip's own sound, on the clip it belongs to.
  let data = video.data;
  if (clip.audio) {
    progress(0.97, "Putting the sound back");
    const raw = path.join(/*turbopackIgnore: true*/ work, "film.mp4");
    const mixed = path.join(/*turbopackIgnore: true*/ work, "film-sound.mp4");
    await fs.writeFile(/*turbopackIgnore: true*/ raw, data);
    const r = await runFfmpeg(["-hide_banner", "-loglevel", "error", "-y", "-i", raw, "-i", clip.audio, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-shortest", mixed], { signal: ctx.signal, timeoutMs: 120_000 });
    if (r.code === 0) data = await fs.readFile(/*turbopackIgnore: true*/ mixed);
  }
  const [layoutSaved, lookSaved] = await Promise.all([saveFileUpload(layout.data, "mp4", "video").catch(() => null), saveUpload(await fs.readFile(/*turbopackIgnore: true*/ lookFile)).catch(() => null)]);
  return { outputs: [{ ...video, data }], usedPrompt: prompt, layoutUrl: layoutSaved?.url, lookUrl: lookSaved?.url };
}
