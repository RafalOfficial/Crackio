import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { DATA_DIR } from "./paths";
import { saveUpload, urlToPath } from "./media";
import { imageJob } from "./director";
import { photoCamera } from "@/lib/director/reconstruct";
import { mogeMeters } from "@/lib/director/moge-scale";
import { estimateDepth, estimateGeometry } from "./vision";
import { carryPastPhoto } from "./past-photo";
import { localModelReady } from "./local-models";
import { Matrix4 } from "three";
import { ANY_ANGLE } from "@/lib/angles/prompt";
import { frameElements, shotCamera, type Framing } from "@/lib/director/camera";
import { ELEMENT_DEFAULTS } from "@/lib/director/vocab";
import type { Scene, SceneElement } from "@/lib/director/types";
import type { Generation } from "@/lib/generations/types";
import { EngineError, type Engine, type EngineContext, type EngineJob, type EngineResult } from "@/lib/engines/types";

const DIR = path.join(/*turbopackIgnore: true*/ DATA_DIR, "cache", "director");

/** The kept shot's "nothing known here" gray (stage/capture LOOK_KEY, #949494). */
const KEY = 148;

type CompBox = { id: string; box: [number, number, number, number]; distance: number; color?: [number, number, number] };

/**
 * The shot made from what the camera view shows, the challenge winner's way (nomadoor's Panorama Stickers: its
 * workflows render the view, unknown parts flat gray, and give it to Qwen-Image 2.1 as the one picture to edit, 25
 * steps at CFG 1). The view holds the place's own pixels, each subject as their own picture from the side the camera
 * sees with their shadows, and flat gray where no picture shows anything. The model is asked for little: blend the
 * cast in (their light, shadows, colors and style matched to the place, a soft shadow beneath them), fill the gray, do
 * what the notes say, and keep the rest. So the place keeps its look, its style and its detail, which the ControlNet
 * redraws lost (an astronaut on a beach, tested Nov 2026). On local models, `castMask` lets only the subjects and the
 * ground under them change.
 */
export async function runDirectorReal(job: EngineJob, gen: Generation, engine: Engine, ctx: EngineContext): Promise<EngineResult & { plateUrl: string; swapUrl: string }> {
  const scene = gen.params?.scene as Scene;
  const comp = gen.params?.comp as { plateUrl?: string; idsUrl?: string; lookUrl?: string; setUrl?: string; cutsUrl?: string; boxes?: CompBox[] } | undefined;
  const look = comp?.lookUrl ? urlToPath(comp.lookUrl) : null;
  const ids = comp?.idsUrl ? urlToPath(comp.idsUrl) : null;
  if (!look || !ids || !comp?.plateUrl) throw new EngineError("This shot is missing its camera view.", "Shoot it again.");
  ctx.progress(0.03, "Looking at the shot");
  const meta = await sharp(look).metadata();
  const W = meta.width ?? 2048;
  const H = meta.height ?? 878;
  const framed = frameElements(scene, shotCamera(scene)).filter((f) => f.inFrame);
  // Gray to fill only when the view has some: told to fill gray that isn't there, a model may repaint a gray wall.
  const keyed = (await keyedShare(look)) > 0.004;

  // Local models can change only the subjects and the ground under them (asked for: the world under it stays as soft as
  // the world's own pixels, where a whole edit draws it sharp).
  const local = job.via === "comfy-local" || /^local:/.test(gen.model ?? "");
  const maskFile = local && gen.params?.castMask === true ? path.join(/*turbopackIgnore: true*/ DIR, `real-mask-${Date.now().toString(36)}.png`) : null;
  if (maskFile) {
    await fs.mkdir(/*turbopackIgnore: true*/ DIR, { recursive: true });
    await fs.writeFile(/*turbopackIgnore: true*/ maskFile, await castMask(ids, comp.boxes ?? [], W, H));
  }
  const moving = framed.some((f) => f.element.action?.trim() && !/^(stand|standing|still|posing|waiting)/i.test(f.element.action.trim()));
  const cuts = comp.cutsUrl ? urlToPath(comp.cutsUrl) : null;
  // The place's light in words, read off the view's own pixels around the cast: what the cast is relit with.
  const light = framed.length ? await lightWords(look, cuts).catch(() => "") : "";
  // Tests (scratchpad resubmit) try other words on the same captures.
  const prompt = typeof gen.params?.shotWords === "string" && gen.params.shotWords.trim() ? gen.params.shotWords.trim() : blendPrompt(scene, framed, keyed, light);

  // The Camera left the photo's spot in the photo's 3D set (Stage3D PhotoSet): the view shows gaps and stretched sides,
  // which the challenge winner's 3D World re-shoots with Qwen-Image 2.1 + AnyAngle (picture 1 the photo, picture 2 the
  // photo's 3D set alone, all else gray). With nobody added, that's the shot. With someone, their own pictures go back
  // over it where the view showed them and the edit below relights them (the winner's two workflows in a row: one edit
  // over the torn view kept the tears). Anything going wrong there falls back to editing the view.
  const scale = scene.place.scale ?? 1;
  const photoUrl = scene.place.world?.photo?.url ?? scene.place.image?.url;
  const photo = gen.params?.photoSet === true && photoUrl && offPhoto(scene) > 0.35 * scale && (!framed.length || cuts) ? urlToPath(photoUrl) : null;
  // The re-shoot runs on a GPU machine the Director's set-up gave its 3D World (local/catalog `director-world`); a flat
  // painting's, which re-shoots the stage's own view and needs no MoGe-3, also where only Angles' Qwen Angles is. With
  // neither (a GPU too small for it, or a Comfy key's model shooting), no time goes into trying: a hosted model gets the
  // photo along with the view instead (below), a model on your GPU edits the view as it is.
  const ready = (id: string) => localModelReady(id).catch(() => false);
  const flatSet = gen.params?.photoFlat === true && Boolean(comp.setUrl);
  const angleModel = !photo || maskFile ? null : (await ready(ANGLE_MODEL)) ? ANGLE_MODEL : flatSet && (await ready(FLAT_MODEL)) ? FLAT_MODEL : null;
  let target = look;
  let over: string | null = null;
  let from = 0.05;
  if (photo && angleModel) {
    try {
      const set = comp.setUrl ? urlToPath(comp.setUrl) : null;
      // MoGe-3 measured the photo as a flat picture (a painting) and the stage kept MoGe-2's relief (lib/director/
      // moge-scale `meshFlat`): re-shot from the stage's own view of the photo in 3D, gray where it saw nothing as the
      // winner's render is, on the full model as their workflow runs. Their render measures with MoGe-3 again, which
      // would turn the place back into a flat card seen at an angle.
      const flat = gen.params?.photoFlat === true && Boolean(set);
      // The scale the page built its 3D photo with (lib/director/moge-scale), else measured here the same way.
      const meters = typeof gen.params?.mogeMeters === "number" && gen.params.mogeMeters > 0 ? gen.params.mogeMeters : await mogeScale(photo, scene).catch(() => 1);
      // Past the photo's own view the stage has nothing (flat gray): carried on softly from its edges (server/past-photo),
      // or the model kept the photo's border as the edge of a picture standing in a place it drew around it.
      const past = flat && set ? await pastPhoto(set, scene, meters).catch((err) => (console.warn("[director] carrying the view on:", (err as Error).message), null)) : null;
      const outputs = await reshootAngle(job, angleModel, past ?? set ?? look, photo, ctx, framed.length ? 0.45 : 0.93, flat ? undefined : studioState(scene, meters), flat ? undefined : photoHfov(scene), flat).finally(() =>
        past ? fs.rm(/*turbopackIgnore: true*/ past, { force: true }) : undefined,
      );
      if (!framed.length) {
        const plate = await saveUpload(await fs.readFile(/*turbopackIgnore: true*/ urlToPath(comp.plateUrl) ?? look));
        const shot = await saveUpload(await fs.readFile(/*turbopackIgnore: true*/ look));
        return { outputs, usedPrompt: ANY_ANGLE, plateUrl: plate.url, swapUrl: shot.url };
      }
      over = await castOver(outputs[0].data, look, cuts!, W, H);
      target = over;
      from = 0.5;
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      console.warn("[director] re-shoot from the new angle failed, editing the view instead:", (err as Error).message);
    }
  }
  // A hosted model and a Camera off the photo's spot with no re-shoot: the photo goes along as picture 2 and the view is
  // re-shot from it in the same edit, in the words Angles gives GPT Image and Nano Banana for the same two pictures.
  const guided = Boolean(photo) && !over && !local;
  const words = guided ? `${GUIDED_RESHOOT}${framed.length ? ` ${GUIDED_CAST}` : ""}\n\n${prompt}` : prompt;
  try {
    const { outputs } = await engine.run(
      {
        ...job,
        prompt: words,
        userPrompt: words,
        refine: false,
        // The view alone (or the place re-shot with the cast put back): the winner's one picture. A hosted model's
        // re-shoot: the view, then the photo it's re-shot from.
        references: [{ path: target, label: "the shot", role: "edit-target" }, ...(guided && photo ? [{ path: photo, label: "the place's photo", role: "reference" }] : [])],
        guide: undefined,
        depth: undefined,
        layout: undefined,
        // Turbo's 8 steps unless the shot asks for the best (Qwen-Image 2.1's full model, 25 steps, as the winner ran
        // it): on the A40 Turbo relit a test photo of a woman as well or better, in half the time.
        options: { ...job.options, quality: job.options?.quality === "best" ? "best" : "fast", ...(maskFile ? { denoise: moving ? 0.9 : 0.72 } : {}) },
        ...(maskFile ? { mask: { path: maskFile, label: "where the cast is" } } : {}),
      },
      { signal: ctx.signal, progress: (v, stage) => ctx.progress(from + v * (0.98 - from), stageOf(over ? "Lighting the cast into the shot" : "Making the shot", stage)) },
    );
    if (!outputs.length) throw new EngineError("The model returned no picture.");
    const plate = await saveUpload(await fs.readFile(/*turbopackIgnore: true*/ urlToPath(comp.plateUrl) ?? look));
    const shot = await saveUpload(await fs.readFile(/*turbopackIgnore: true*/ target));
    return { outputs, usedPrompt: over ? `${ANY_ANGLE} Then: ${prompt}` : words, plateUrl: plate.url, swapUrl: shot.url };
  } finally {
    if (maskFile) await fs.rm(/*turbopackIgnore: true*/ maskFile, { force: true });
    if (over) await fs.rm(/*turbopackIgnore: true*/ over, { force: true });
  }
}

/**
 * A hosted model's re-shoot from a moved Camera (Image 1 the view, Image 2 the place's photo): Angles' guided words for
 * the same two pictures (lib/angles/prompt `anglePrompt`), which GPT Image 2.5 and Nano Banana follow there.
 */
const GUIDED_RESHOOT = [
  "Image 1 is this shot from a new camera position: the place in Image 2 (its photo) seen from there in a rough 3D preview made from Image 2's depth, so it is stretched and smeared in places, the backs of things are only washed-out silhouettes, and it has flat gray gaps. Make the clean photo that the camera in Image 1 would take.",
  "Match Image 1 for the camera position, height and tilt, the perspective, the horizon, the framing, and the size and placement of everything in the frame. Take the place's appearance from Image 2: the same objects, materials, colors, light, style and photo quality.",
  "Image 1's stretching, blur, broken edges, washed-out silhouettes and gray gaps are not content: replace them with what would really be there, consistent with Image 2. One clean, sharp picture with no text, borders or watermarks.",
].join(" ");
/** With the cast in the view: they aren't in the photo, so they come from the view. */
const GUIDED_CAST = "Everyone and everything in Image 1 that isn't in Image 2 stays as Image 1 shows them, where Image 1 shows them.";

/** The cast's own pictures from the view (where `cuts` is white) over the place re-shot from the new angle. */
async function castOver(place: Buffer, look: string, cuts: string, W: number, H: number) {
  const [base, top, mask] = await Promise.all([
    sharp(place).removeAlpha().resize(W, H, { fit: "fill" }).raw().toBuffer(),
    sharp(look).removeAlpha().resize(W, H, { fit: "fill" }).raw().toBuffer(),
    sharp(cuts).removeAlpha().resize(W, H, { fit: "fill" }).greyscale().blur(0.8).raw().toBuffer(),
  ]);
  const out = Buffer.alloc(W * H * 3);
  for (let i = 0; i < W * H; i++) {
    const k = mask[i] / 255;
    for (let c = 0; c < 3; c++) out[i * 3 + c] = Math.round(base[i * 3 + c] * (1 - k) + top[i * 3 + c] * k);
  }
  await fs.mkdir(/*turbopackIgnore: true*/ DIR, { recursive: true });
  const file = path.join(/*turbopackIgnore: true*/ DIR, `over-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.png`);
  await fs.writeFile(/*turbopackIgnore: true*/ file, await sharp(out, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer());
  return file;
}

/**
 * The place's light in a few words ("dim, cool blue"), from the view's own pixels outside the cast and the gray: the
 * relight the cast gets. Told the light in words, Qwen-Image 2.1 lit a studio-lit woman as moonlight on an alien test
 * beach; told only to "match the lighting", it left her as she was and added a shadow.
 */
async function lightWords(look: string, cuts: string | null) {
  const { data, info } = await sharp(look).removeAlpha().resize({ width: 256 }).raw().toBuffer({ resolveWithObject: true });
  const n0 = info.width * info.height;
  const cast = cuts ? await sharp(cuts).removeAlpha().resize(info.width, info.height, { fit: "fill" }).greyscale().raw().toBuffer() : null;
  let [r, g, b, n] = [0, 0, 0, 0];
  for (let i = 0; i < n0; i++) {
    if (cast && cast[i] > 64) continue;
    const [R, G, B] = [data[i * 3], data[i * 3 + 1], data[i * 3 + 2]];
    if (Math.abs(R - KEY) <= 3 && Math.abs(G - KEY) <= 3 && Math.abs(B - KEY) <= 3) continue;
    r += R;
    g += G;
    b += B;
    n++;
  }
  if (!n) return "";
  [r, g, b] = [r / n, g / n, b / n];
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const level = lum < 55 ? "dark" : lum < 100 ? "dim" : lum < 165 ? "soft" : "bright";
  const tint = b > r + 18 ? "cool blue" : r > b + 22 ? (g > b + 10 ? "warm golden" : "warm") : "neutral";
  return `${level}, ${tint}`;
}

/** How far the Camera stands from where the place's photo was taken (set meters). */
function offPhoto(scene: Scene) {
  const view = scene.place.image?.view;
  if (!view) return 0;
  return shotCamera(scene).position.distanceTo(photoCamera(view, scene.place.scale ?? 1).position);
}

/**
 * The photo re-shot from the Camera's view of its 3D set (Qwen Angles: Qwen-Image 2.1 + lilylilith's AnyAngle, whose
 * renders had the same flat gray where nothing was seen), at the view's framing and the shot's size. `best`: the full
 * model's 25 steps, as the winner's workflow (their own render, `studio`, always runs it).
 */
async function reshootAngle(job: EngineJob, model: string, view: string, photo: string, ctx: EngineContext, upTo = 0.93, studio?: Record<string, unknown>, mogeFov?: number, best = false) {
  const { job: base, engine } = await imageJob(model, typeof job.options?.machine === "string" ? job.options.machine : undefined);
  const quality = best ? "best" : job.options?.quality;
  const { outputs } = await engine.run(
    {
      ...base,
      aspect: job.aspect,
      width: job.width,
      height: job.height,
      count: 1,
      prompt: ANY_ANGLE,
      userPrompt: ANY_ANGLE,
      refine: false,
      references: [{ path: photo, label: "the photo", role: "subject" }],
      guide: { path: view, label: "the Camera's view of the photo's 3D set" },
      options: { ...base.options, ...(job.options?.resolution ? { resolution: job.options.resolution } : {}), ...(quality ? { quality } : {}), frame: true, ...(studio ? { studio } : {}), ...(mogeFov ? { mogeFov } : {}) },
    },
    { signal: ctx.signal, progress: (v, stage) => ctx.progress(0.05 + v * (upTo - 0.05), stageOf("Shooting from the new angle", stage)) },
  );
  if (!outputs.length) throw new EngineError("The model returned no picture.");
  return outputs;
}

/**
 * What a shot is doing, after what it's for: "Shooting from the new angle · starting the GPU on RunPod", "… · loading
 * the model", "… · step 12/25 · about 40 s left". Every stage used to read "Shooting from the new angle" alone, for
 * minutes, while it waited for a GPU or for its model to load (a shot sat at 14% for a minute and a half).
 */
export function stageOf(what: string, stage?: string) {
  if (!stage) return what;
  const steps = stage.match(/(?:part \d+ of \d+ · )?step \d+\/\d+.*$/);
  if (steps) return `${what} · ${steps[0]}`;
  // The engine's ticker, before the first step: the model loading (a GPU that just started reads it from its disk).
  if (/^Rendering\b/.test(stage)) return `${what} · loading the model`;
  if (/^(Starting|Sending|Waiting|In ComfyUI's queue|Downloading|Preparing)/.test(stage)) return `${what} · ${stage.charAt(0).toLowerCase()}${stage.slice(1)}`;
  return what;
}

/**
 * The Director's Camera as the challenge winner's Panorama Studio state (their scene state v2, docs/scene-state-v2.md):
 * where it stands and how it's turned in the photo camera's own frame, which is their MoGe world's (glTF: +X right,
 * +Y up, looking down -Z, the photo's camera at the origin; MoGe's meters taken as the set's), the angles read as their
 * `panorama_angles` reads a rotation (core/world.py), the horizontal field of view and the frame's shape. A straight
 * lens (curve 1), nothing else in the scene.
 */
export function studioState(scene: Scene, metersPerUnit = 1) {
  const view = scene.place.image?.view;
  if (!view) return undefined;
  const scale = scene.place.scale ?? 1;
  const photo = photoCamera(view, scale);
  const cam = shotCamera(scene);
  const inv = photo.quaternion.clone().invert();
  const p = cam.position.clone().sub(photo.position).applyQuaternion(inv).divideScalar(scale).multiplyScalar(metersPerUnit);
  // Column-major: the camera's right, up and back axes in the photo camera's frame; their panorama convention flips Z.
  const m = new Matrix4().makeRotationFromQuaternion(inv.multiply(cam.quaternion)).elements;
  const right = [m[0], m[1], -m[2]];
  const up = [m[4], m[5], -m[6]];
  const forward = [-m[8], -m[9], m[10]];
  const yaw = Math.atan2(forward[0] + 0, forward[2] + 0);
  const pitch = Math.atan2(forward[1], Math.hypot(forward[0], forward[2]));
  const roll = Math.atan2(Math.sin(yaw) * up[2] - Math.cos(yaw) * up[0], Math.cos(yaw) * right[0] - Math.sin(yaw) * right[2]);
  const deg = (r: number) => (r * 180) / Math.PI;
  const hfov = deg(2 * Math.atan(Math.tan((cam.fov * Math.PI) / 360) * cam.aspect));
  const lane = <T,>(value: T) => ({ value, keyframes: [] });
  return {
    version: 2,
    id: Math.random().toString(36).slice(2, 18),
    timeline: { fps: 24, length: null },
    camera: {
      aspect: cam.aspect,
      position: lane([p.x, p.y, p.z]),
      rotation: lane({ yaw_deg: deg(yaw), pitch_deg: deg(pitch), roll_deg: deg(roll) }),
      fov: lane(hfov),
      curve: lane(1),
    },
    scene: { clip: { start: 0, in: 0, duration: null }, position: lane([0, 0, 0]), rotation: lane({ yaw_deg: 0, pitch_deg: 0, roll_deg: 0 }), scale: lane(1) },
    stickers: [],
    painting: { version: 1, groups: [], paint: { strokes: [] }, mask: { strokes: [] }, raster_objects: [] },
    painting_layer: null,
  };
}

/** The photo's horizontal field of view as the set has it (degrees): MoGe-3 is told it, so its world lines up with the set's. */
function photoHfov(scene: Scene) {
  const image = scene.place.image;
  if (!image?.view) return undefined;
  return (2 * Math.atan(Math.tan((image.view.fov * Math.PI) / 360) * (image.width / Math.max(1, image.height))) * 180) / Math.PI;
}

/**
 * MoGe's meters per set unit for this photo: the median ratio of MoGe-2's metric depth (server/vision, the same family
 * as the MoGe-3 their 3D World measures with) to the set's own, over the measured pixels. The A40 test: with the set's
 * units taken as MoGe's, a camera moved 3.3 m in toward the astronaut came out past him.
 */
export async function mogeScale(photo: string, scene: Scene) {
  const view = scene.place.image?.view;
  if (!view) return 1;
  const [ours, moge] = await Promise.all([estimateDepth(photo), estimateGeometry(photo)]);
  // The same maths, on the same maps, as the Director's 3D photo (lib/director/moge-scale), decoded as the page does.
  const map = (r: { width: number; height: number; data: string }) => {
    const b = Buffer.from(r.data, "base64");
    const data = new Float32Array(r.width * r.height);
    for (let i = 0; i < data.length; i++) data[i] = b.readUInt16LE(i * 2) / 65535;
    return { width: r.width, height: r.height, data };
  };
  return mogeMeters(map(ours), view, map(moge), moge.near, moge.far);
}

/**
 * A flat painting's view with the gray past the photo's own view carried on from its edges (server/past-photo), as a
 * file to re-shoot from; null when the view stays inside the photo. Past its view means past the edge of the set's far
 * plane (MoGe-2's sky and farthest things: its `far`, in set units by the meters the page built the set with).
 */
async function pastPhoto(set: string, scene: Scene, meters: number) {
  const original = scene.place.image?.url ? urlToPath(scene.place.image.url) : null;
  if (!original || !(meters > 0)) return null;
  const { far } = await estimateGeometry(original);
  return carryPastPhoto(set, scene, far / meters, DIR);
}

/** The re-shoot runs where the Director's set-up put its 3D World (local/catalog `director-world`: MoGe-3, the node, AnyAngle). */
const ANGLE_MODEL = "local:director-world";
/** A flat painting's re-shoot needs only Qwen-Image 2.1 Turbo and AnyAngle: Angles' own model does it too. */
const FLAT_MODEL = "local:qwen-angles";

/**
 * The share of the view that is flat KEY gray (no picture shows it). Read at 512 px with nearest pixels, so the flat
 * gray stays exact; a pixel counts when it's within a few levels of the key and the same as the pixels right and below
 * it, which a photo's own grays (grain, light) almost never are.
 */
async function keyedShare(file: string) {
  const { data, info } = await sharp(file).removeAlpha().resize({ width: 512, withoutEnlargement: true, kernel: "nearest" }).raw().toBuffer({ resolveWithObject: true });
  const w = info.width;
  const h = info.height;
  const near = (i: number) => Math.abs(data[i] - KEY) <= 3 && Math.abs(data[i + 1] - KEY) <= 3 && Math.abs(data[i + 2] - KEY) <= 3;
  const same = (i: number, j: number) => data[i] === data[j] && data[i + 1] === data[j + 1] && data[i + 2] === data[j + 2];
  let n = 0;
  for (let y = 0; y < h - 1; y++) {
    for (let x = 0; x < w - 1; x++) {
      const i = (y * w + x) * 3;
      if (near(i) && same(i, i + 3) && same(i, i + w * 3)) n++;
    }
  }
  return n / Math.max(1, (w - 1) * (h - 1));
}

/**
 * Where the subjects are (the ID pass), grown a little for hair, cloth and light, and a band under each for its shadow
 * and footing; white changes. The rest of the frame is the place, kept.
 */
async function castMask(ids: string, boxes: CompBox[], W: number, H: number) {
  const raw = await sharp(ids).resize(W, H, { fit: "fill", kernel: "nearest" }).removeAlpha().raw().toBuffer();
  const m = Buffer.alloc(W * H);
  for (let i = 0; i < W * H; i++) if (raw[i * 3] > 127 || raw[i * 3 + 1] > 127 || raw[i * 3 + 2] > 127) m[i] = 255;
  const clamp = (v: number, hi: number) => Math.max(0, Math.min(hi, Math.round(v)));
  for (const { box } of boxes) {
    const [x0, y0, x1, y1] = box;
    const w = x1 - x0;
    const h = y1 - y0;
    if (y1 < 0 || y1 > H * 1.2) continue;
    const bx0 = clamp(x0 - 0.35 * w, W);
    const bx1 = clamp(x1 + 0.35 * w, W);
    const by0 = clamp(y1 - 0.1 * h, H);
    const by1 = clamp(y1 + 0.06 * h, H);
    for (let y = by0; y < by1; y++) m.fill(255, y * W + bx0, y * W + bx1);
  }
  const grow = Math.max(2, Math.round(H * 0.025));
  const grown = await sharp(m, { raw: { width: W, height: H, channels: 1 } }).blur(grow).threshold(12).raw().toBuffer();
  return sharp(grown, { raw: { width: W, height: H, channels: 1 } })
    .blur(Math.max(1, grow / 3))
    .png()
    .toBuffer();
}

const ALIVE = new Set(["person", "animal"]);

/**
 * After the winner's words: "Blend the white kei truck naturally into the scene. Match its lighting, shadows, colors,
 * and art style to the surrounding background, and add a soft shadow on the ground beneath it." (their
 * 3D-in-a-panorama workflow), and for a change, the change and then "Keep the faces, outfits, background, lighting,
 * camera angle, and art style the same." (their cut-out workflow), leaving out of the keep list whatever the words
 * before it change. Their truck came lit for its scene; a studio photo of a person didn't, and "match the lighting" left
 * a test woman studio-lit on a night beach (a shadow added, nothing else). Told to relight her with the
 * place's light in words (`light`, "dim, cool blue"), she came back moonlit with a long shadow. No style words of our
 * own: the place sets the style.
 */
export function blendPrompt(scene: Scene, framed: Framing[], keyed: boolean, light = "") {
  const s: string[] = [];
  const nouns = framed.map((f) => nounOf(f.element));
  // Two of the same ("the woman and the woman") are told apart by where they are.
  const named = framed.map((f, i) => `the ${nouns[i]}${nouns.filter((n) => n === nouns[i]).length > 1 ? ` ${whereIn(f, framed)}` : ""}`);
  const thing = framed.length === 1 && !ALIVE.has(framed[0].element.kind);
  if (framed.length) {
    const [they, them, their, belong, cast] = thing ? ["it", "it", "its", "belongs", "casts"] : ["they", "them", "their", "belong", "cast"];
    s.push(
      `Relight ${listOf(named)} so ${they} ${belong} in this scene: the same ${light ? `${light} ` : ""}light that falls on the place around ${them} falls on ${them}, ${their} colors, brightness and contrast match the surroundings, and ${they} ${cast} a soft shadow on the ground beneath ${them}.`,
    );
  }
  if (keyed) s.push("Fill the flat gray areas with what belongs there, so the scene continues seamlessly.");
  for (const [i, f] of framed.entries()) {
    const act = f.element.action?.trim();
    if (!act) continue;
    const who = named[i].charAt(0).toUpperCase() + named[i].slice(1);
    s.push(`${who} ${/^\w+ing\b/i.test(act) ? `is ${act}` : act}`.replace(/[.!]?$/, "."));
  }
  const notes = scene.notes.trim();
  if (notes) s.push(notes.replace(/[.!]?$/, "."));
  if (!s.length) {
    s.push("Make this picture clean and sharp, with fine natural detail. Keep the scene, the camera angle, the framing, the colors and the art style the same.");
    return s.join(" ");
  }
  // What stays: never what the words above change (the cast's style is matched to the place; notes may change the
  // place itself; the gray is filled).
  const keep: string[] = [];
  if (framed.some((f) => f.element.kind === "person")) keep.push(`${framed.length === 1 ? "their face, pose and outfit" : "their faces, poses and outfits"}`);
  if (!notes) keep.push(keyed ? "the rest of the background" : "the background");
  keep.push("the camera angle", "the framing");
  if (!framed.length) keep.push("the art style");
  s.push(`Keep ${listOf(keep)} the same.`);
  return s.join(" ");
}

function nounOf(el: SceneElement) {
  return (el.read?.noun ?? ELEMENT_DEFAULTS[el.kind].noun).replace(/^(a|an|the)\s+/i, "");
}

const listOf = (xs: string[]) => (xs.length < 2 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

/** Where it is in the frame: "on the left", "in the middle, nearest the camera". */
function whereIn(f: Framing, all: Framing[]) {
  const side = f.cx < -0.33 ? "on the left" : f.cx > 0.33 ? "on the right" : "in the middle";
  const nearest = all.every((g) => g === f || g.depth > f.depth);
  const farthest = all.every((g) => g === f || g.depth < f.depth);
  return `${side}${nearest ? ", nearest the camera" : farthest && all.length > 2 ? ", farthest back" : ""}`;
}
