import "server-only";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { Vector3 } from "three";
import { DATA_DIR } from "./paths";
import { saveUpload, urlToPath } from "./media";
import { sheetViews, viewsOf } from "./cast-sheet";
import { loadCharacter } from "./cast-store";
import { LEGACY_SHEET_VIEWS } from "@/lib/cast/types";
import { angleDelta, frameElements, shotCamera, yawTowardCamera, type Framing } from "@/lib/director/camera";
import { cameraWords, onceRule } from "@/lib/director/compile";
import { subjectViews } from "@/lib/director/views";
import { ELEMENT_DEFAULTS, STYLES } from "@/lib/director/vocab";
import type { Scene, SceneElement } from "@/lib/director/types";
import type { Generation } from "@/lib/generations/types";
import { EngineError, type Engine, type EngineContext, type EngineJob, type EngineReference, type EngineResult } from "@/lib/engines/types";

const DIR = path.join(/*turbopackIgnore: true*/ DATA_DIR, "cache", "director");

type CompBox = { id: string; box: [number, number, number, number]; distance: number; color?: [number, number, number] };

/**
 * The shot made real from what the camera view shows: the place (its world), each subject standing in it as the side
 * the camera sees (their Cast sheet's matching view, the size and spot the set gives them) and their shadows. The model
 * is asked for one thing only, to make that paste-up one real photograph, instead of reading the shot off colored
 * stand-ins and a pile of reference pictures, which models drop or turn toward the camera (the user's FLUX 3 takes).
 * Up close, a subject's matching picture goes along too, for the face and clothes. On local models only the subjects
 * and the ground they stand on change (a mask), so the place stays exactly the place in every shot.
 */
export async function runDirectorReal(job: EngineJob, gen: Generation, engine: Engine, ctx: EngineContext, slots: number): Promise<EngineResult & { plateUrl: string; swapUrl: string }> {
  const scene = gen.params?.scene as Scene;
  const comp = gen.params?.comp as { plateUrl?: string; idsUrl?: string; lookUrl?: string; boxes?: CompBox[] } | undefined;
  const look = comp?.lookUrl ? urlToPath(comp.lookUrl) : null;
  const ids = comp?.idsUrl ? urlToPath(comp.idsUrl) : null;
  if (!look || !ids || !comp?.plateUrl) throw new EngineError("This shot is missing its camera view.", "Shoot it again.");
  ctx.progress(0.03, "Looking at the shot");
  const meta = await sharp(look).metadata();
  const W = meta.width ?? 1536;
  const H = meta.height ?? 864;

  // Who is up close enough for their face and clothes to need their own picture.
  const cam = shotCamera(scene);
  const framed = frameElements(scene, cam).filter((f) => f.inFrame);
  const seen = new Map(subjectViews(scene).map((v) => [v.id, v.around]));
  const references: EngineReference[] = [{ path: look, label: "the shot", role: "edit-target" }];
  const refs = new Map<string, number>();
  for (const f of [...framed].sort((a, b) => b.span - a.span)) {
    if (references.length >= Math.min(slots, 3) || f.span < 0.45) break;
    const pic = await matchedView(f.element, seen.get(f.element.id) ?? 0).catch(() => null);
    if (!pic) continue;
    references.push({ path: pic, label: `${f.element.name}, from this side`, role: "subject" });
    refs.set(f.element.id, references.length);
  }

  // Local models can change only the subjects and the ground under them (asked for: the world under it stays as soft as
  // the world's own pixels, where a whole edit draws it sharp).
  const local = job.via === "comfy-local" || /^local:/.test(gen.model ?? "");
  const maskFile = local && gen.params?.castMask === true ? path.join(DIR, `real-mask-${Date.now().toString(36)}.png`) : null;
  if (maskFile) {
    await fs.mkdir(DIR, { recursive: true });
    await fs.writeFile(maskFile, await castMask(ids, comp.boxes ?? [], W, H));
  }
  const moving = framed.some((f) => f.element.action?.trim() && !/^(stand|standing|still|posing|waiting)/i.test(f.element.action.trim()));
  const prompt = realPrompt(scene, framed, cam.position, refs);
  try {
    const { outputs } = await engine.run(
      {
        ...job,
        prompt,
        userPrompt: prompt,
        refine: false,
        references,
        guide: undefined,
        depth: undefined,
        layout: undefined,
        ...(maskFile ? { mask: { path: maskFile, label: "where the cast is" }, options: { ...job.options, denoise: moving ? 0.9 : 0.72 } } : {}),
      },
      { signal: ctx.signal, progress: (v) => ctx.progress(0.05 + v * 0.93, "Making the shot real") },
    );
    if (!outputs.length) throw new EngineError("The model returned no picture.");
    const plate = await saveUpload(await fs.readFile(urlToPath(comp.plateUrl) ?? look));
    const shot = await saveUpload(await fs.readFile(look));
    return { outputs, usedPrompt: prompt, plateUrl: plate.url, swapUrl: shot.url };
  } finally {
    if (maskFile) await fs.rm(maskFile, { force: true });
  }
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

const PEOPLE = new Set(["person", "animal"]);

function realPrompt(scene: Scene, framed: Framing[], camPos: Vector3, refs: Map<string, number>) {
  const style = STYLES.find((x) => x.id === scene.style) ?? STYLES[0];
  const realistic = ["photo", "cinematic", "documentary", "editorial", "product", "analog"].includes(style.id);
  const s: string[] = [];
  const one = framed.length === 1;
  s.push(
    `Image 1 is a rough paste-up of a ${realistic ? "film still" : "picture"}: ${one ? "the subject was" : "each subject was"} cut out and placed into the shot by hand. Turn it into one real ${realistic ? "photograph" : "picture"}.`,
  );
  s.push(`Keep the camera (${cameraWords(scene)}), the framing and the place exactly as they are.`);
  for (const f of framed) {
    const el = f.element;
    const noun = nounOf(el);
    const them = el.kind === "person" ? "them" : "it";
    const ref = refs.get(el.id);
    const look = el.look?.trim();
    s.push(
      `The ${noun} ${whereIn(f, framed)} stays exactly where ${el.kind === "person" ? "they are" : "it is"}, just as large and in the same pose, ${facing(el, camPos)}` +
        `${el.action?.trim() ? `; ${el.action.trim()}` : ""}${ref ? `; image ${ref} shows ${them} from this same side: ${them} look${el.kind === "person" ? "" : "s"} exactly like that` : ""}${look ? `; ${look}` : ""}.`,
    );
  }
  const anyone = framed.some((f) => PEOPLE.has(f.element.kind));
  if (framed.length) {
    s.push(
      `Make ${one ? "it" : "them"} belong in the place: the place's own light, color and haze on ${one ? "it" : "them"}, real shadows on the ground where ${one ? "it stands" : "they stand"}` +
        `${anyone ? ", feet planted on the ground" : ""}, natural edges, and real ${anyone ? "skin, hair, fabric" : "material"} and surface detail.`,
    );
  }
  s.push(onceRule([], framed.length > 0), "Nothing added and nothing removed.");
  if (scene.notes.trim()) s.push(`Also: ${scene.notes.trim()}`);
  if (framed.some((f) => f.element.kind === "person") && (scene.notes.trim() || framed.some((f) => f.element.action?.trim()))) {
    s.push("Anything a person holds or uses is clearly visible, whole and real in their hand.");
  }
  s.push(`${style.phrase}. One ${realistic ? "natural photograph" : "coherent picture"}, no text.`);
  return s.join(" ");
}

function nounOf(el: SceneElement) {
  return (el.read?.noun ?? ELEMENT_DEFAULTS[el.kind].noun).replace(/^(a|an|the)\s+/i, "");
}

/** Where it is in the frame, when there is more than one: "on the left", "in the middle, nearest the camera". */
function whereIn(f: Framing, all: Framing[]) {
  if (all.length < 2) return "in the shot";
  const side = f.cx < -0.33 ? "on the left" : f.cx > 0.33 ? "on the right" : "in the middle";
  const nearest = all.every((g) => g === f || g.depth > f.depth);
  const farthest = all.every((g) => g === f || g.depth < f.depth);
  return `${side}${all.length > 1 && nearest ? ", nearest the camera" : farthest && all.length > 2 ? ", farthest back" : ""}`;
}

/**
 * Which way it faces, as what the camera sees of it (as compile's swap words; Grok 2.0 kept a profile when told which
 * eye and ear show and where the nose points, and turned it to the camera when told only "in profile").
 */
function facing(el: SceneElement, camPos: Vector3) {
  const around = angleDelta(el.yaw, yawTowardCamera(el, camPos));
  const a = Math.abs(around);
  const dir = around > 0 ? "left" : "right";
  if (el.kind === "person") {
    if (a < 22.5) return "facing the camera";
    if (a < 67.5) return `turned three-quarters toward the ${dir} edge of the frame: more of the ${dir} side of their face shows, their nose and chest point toward the ${dir} edge, not looking at the camera`;
    if (a < 112.5) return `in full side profile facing the ${dir} edge of the frame: we see one eye and their ${dir} ear, their nose pointing at the ${dir} edge; they do not turn toward the camera`;
    if (a < 157.5) return `turned mostly away from the camera toward the ${dir}: we see the back of their head and their ${dir} shoulder, not their face`;
    return "with their back to the camera: we see the back of their head and body, not their face";
  }
  if (el.kind === "vehicle") {
    if (a < 22.5) return "its front pointing straight at the camera";
    if (a < 67.5) return `seen at a three-quarter angle, its front end pointing toward the ${dir} edge of the frame`;
    if (a < 112.5) return `seen exactly side-on, its front pointing at the ${dir} edge of the frame`;
    if (a < 157.5) return `seen from behind at an angle, its front pointing away toward the ${dir}`;
    return "seen from directly behind";
  }
  if (a < 22.5) return "its front toward the camera";
  if (a < 112.5) return `its front turned toward the ${dir} edge of the frame`;
  return "turned away from the camera";
}

/**
 * A subject's own picture from the side the camera sees it (as server/director's matchedView): its Cast sheet's view of
 * that side (the side view turned to face the way it faces here), or the drawing made from nearest that side.
 */
async function matchedView(el: SceneElement, around: number): Promise<string | null> {
  const sheet = el.cast?.sheet ? urlToPath(el.cast.sheet) : null;
  if (sheet) {
    const member = el.cast?.id ? loadCharacter(el.cast.id) : null;
    const names = member ? viewsOf(member) : LEGACY_SHEET_VIEWS;
    const a = Math.abs(around);
    const want = a < 30 ? "front" : a < 60 && names.includes("three-quarter") ? "three-quarter" : a < 45 ? "front" : a < 140 || !names.includes("back") ? "side" : "back";
    const i = names.indexOf(want);
    if (i < 0) return null;
    const flip = (want === "side" || want === "three-quarter") && around < 0;
    const stat = await fs.stat(sheet);
    const key = createHash("sha1").update(`sheet-view|${sheet}|${stat.size}|${stat.mtimeMs}|${i}|${flip}`).digest("hex").slice(0, 20);
    const file = path.join(DIR, `${key}.png`);
    try {
      await fs.access(file);
    } catch {
      await fs.mkdir(DIR, { recursive: true });
      const view = sharp((await sheetViews(sheet))[i]);
      await fs.writeFile(file, await (flip ? view.flop() : view).png().toBuffer());
    }
    return file;
  }
  if (el.views?.length) {
    const best = el.views.reduce((b, v) => (Math.abs(angleDelta(v.around, around)) < Math.abs(angleDelta(b.around, around)) ? v : b));
    return urlToPath(best.url);
  }
  return null;
}
