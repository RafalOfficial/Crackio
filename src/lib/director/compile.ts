import { MathUtils, Vector3 } from "three";
import type { ElementKind, Scene, SceneElement } from "./types";
import { angleDelta, frameElements, shotCamera, verticalFov, yawTowardCamera, type Framing } from "./camera";
import { APERTURES, LENSES, LIGHT_SETUPS, MOODS, SHOT_SIZES, STYLES, ELEMENT_DEFAULTS, kelvinPhrase } from "./vocab";
import { layoutBoxes, type LayoutBox } from "./layout";
import { moveFromPhoto } from "./reconstruct";
import { colorOf, standInNoun } from "./standin";
import { aspectById } from "@/lib/shot";

export type SheetItem = { key: string; label: string; value: string };

export type CompiledShot = {
  prompt: string;
  sheet: SheetItem[];
  /** Every picture the take is made from: each subject's in the shot, then the location photo. */
  references: { url: string; label: string; role: "subject" | "product" | "place" }[];
  /** What the model gets, in the order the prompt numbers them ("image 1", "image 2", …). */
  inputs: { role: "blocking" | "cast" | "place"; label: string; url?: string; colors?: string[] }[];
  warnings: string[];
  measured: { angle: string; shotSize: string; lens: string; aperture: string; light: string };
  /** Where each subject sits in the frame, for engines that accept layout boxes (FLUX 3). */
  layout: LayoutBox[];
};

const nearest = <T,>(items: readonly T[], value: number, get: (t: T) => number) =>
  items.reduce((best, item) => (Math.abs(get(item) - value) < Math.abs(get(best) - value) ? item : best));

function classifyAngle(elevation: number, cameraHeight: number) {
  const a = Math.round(Math.abs(elevation));
  if (elevation <= -45) return { id: "worms-eye", phrase: `worm's-eye view from down at ground level, looking steeply up about ${a} degrees` };
  if (elevation <= -9) return { id: "low", phrase: `low-angle shot, the camera below the subject looking up about ${a} degrees` };
  if (elevation < 9) {
    if (cameraHeight < 0.45) return { id: "ground", phrase: "ground-level shot with the camera just above the floor, looking straight ahead" };
    return { id: "eye", phrase: "eye-level shot, the camera looking straight ahead" };
  }
  if (elevation < 38) return { id: "high", phrase: `high-angle shot, the camera above the subject looking down about ${a} degrees` };
  if (elevation < 70) return { id: "birds-eye", phrase: `bird's-eye view from high above, looking down about ${a} degrees` };
  return { id: "overhead", phrase: "top-down overhead shot looking straight down at the ground" };
}

function cameraHeightPhrase(h: number) {
  if (h < 0.4) return "at ground level";
  if (h < 0.85) return "at knee height";
  if (h < 1.2) return "at waist height";
  if (h < 1.5) return "at chest height";
  if (h < 1.9) return "at eye height";
  if (h < 3) return "just above head height";
  if (h < 7) return "from a raised position";
  return "from high above, at drone height";
}

function classifyShotSize(f: Framing) {
  const isPerson = f.element.kind === "person";
  const by = (id: string) => SHOT_SIZES.find((s) => s.id === id)!;
  if (isPerson) {
    const headInFrame = f.top <= 1.04;
    if (headInFrame && f.visible >= 0.97) {
      if (f.span >= 0.42) return by("full");
      if (f.span >= 0.14) return by("wide");
      return by("ews");
    }
    const share = f.visible;
    if (share <= 0.12) return by("ecu");
    if (share <= 0.25) return by("cu");
    if (share <= 0.37) return by("mcu");
    if (share <= 0.57) return by("ms");
    if (share <= 0.82) return by("cowboy");
    return by("full");
  }
  const s = f.span;
  if (s >= 1.4) return by("ecu");
  if (s >= 0.7) return by("cu");
  if (s >= 0.4) return by("ms");
  if (s >= 0.15) return by("wide");
  return by("ews");
}

function framePosition(cx: number) {
  if (cx < -0.82) return "at the far left edge of the frame";
  if (cx < -0.28) return "on the left third of the frame";
  if (cx <= 0.28) return "centered in the frame";
  if (cx <= 0.82) return "on the right third of the frame";
  return "at the far right edge of the frame";
}

/** How much of the frame height a subject takes up, in words. */
function sizePhrase(f: Framing) {
  const share = Math.min(1, f.span);
  if (f.top > 1.02 || f.bottom < -1.02) return null; // cropped: the shot size already says how
  const pct = Math.round((share * 100) / 5) * 5;
  if (pct < 5) return "very small in the frame";
  return `taking up about ${pct}% of the frame height`;
}

/** How an element is turned relative to the camera, in words. */
function facingPhrase(el: SceneElement, camPos: Vector3, camRight: Vector3) {
  if (el.kind === "product" || el.kind === "object" || el.kind === "vehicle") {
    const d = Math.abs(angleDelta(el.yaw, yawTowardCamera(el, camPos)));
    if (d < 25) return "seen from the front";
    if (d < 70) return "seen at a three-quarter angle";
    if (d < 110) return "seen from the side";
    if (d < 155) return "seen at a three-quarter angle from behind";
    return "seen from behind";
  }
  const toward = yawTowardCamera(el, camPos);
  const ad = Math.abs(angleDelta(el.yaw, toward));
  const yaw = MathUtils.degToRad(el.yaw);
  const faceDir = new Vector3(Math.sin(yaw), 0, Math.cos(yaw));
  const side = faceDir.dot(camRight) > 0 ? "right" : "left";
  if (ad < 25) return "facing the camera";
  if (ad < 70) return `turned three-quarters toward frame ${side}`;
  if (ad < 112) return `in profile, facing frame ${side}`;
  if (ad < 155) return `turned mostly away from the camera toward frame ${side}`;
  return "with their back to the camera";
}

function relationPhrase(a: Framing, main: Framing) {
  const parts: string[] = [];
  const dx = a.cx - main.cx;
  if (dx > 0.16) parts.push(`to the right of ${main.element.name}`);
  else if (dx < -0.16) parts.push(`to the left of ${main.element.name}`);
  const dd = a.depth - main.depth;
  if (dd < -0.7) parts.push(parts.length ? `and ${dd < -2.5 ? "much " : ""}closer to the camera` : `in front of ${main.element.name}, closer to the camera`);
  else if (dd > 0.7) parts.push(parts.length ? `and ${dd > 2.5 ? "well " : ""}behind them` : `behind ${main.element.name}`);
  if (!parts.length) parts.push(`right next to ${main.element.name}`);
  return parts.join(" ");
}

function lightPhrases(scene: Scene, camRight: Vector3) {
  const { light, camera } = scene;
  const delta = angleDelta(camera.azimuth, light.azimuth);
  const ad = Math.abs(delta);
  const az = (light.azimuth * Math.PI) / 180;
  const fromRight = new Vector3(Math.sin(az), 0, Math.cos(az)).dot(camRight) > 0;
  const side = fromRight ? "frame right" : "frame left";

  let direction: string;
  let setupId: string;
  if (light.elevation >= 72) {
    direction = "hard top light from directly above";
    setupId = "top";
  } else if (light.elevation <= -10) {
    direction = "eerie under-lighting from below";
    setupId = "under";
  } else if (ad < 22) {
    direction = "frontal key light from the camera's direction, shadows falling behind the subject";
    setupId = "front";
  } else if (ad < 67) {
    direction = `key light from ${side} at about 45 degrees, shadows falling toward the other side`;
    setupId = light.elevation > 38 ? "rembrandt" : "loop";
  } else if (ad < 112) {
    direction = `side light from ${side}, the other side falling into shadow`;
    setupId = "split";
  } else if (ad < 157) {
    direction = `rim light from behind on ${side}, outlining the edges, faces partly in shadow`;
    setupId = "rim";
  } else {
    direction = "strong backlight from directly behind the subject, shadows falling toward the camera";
    setupId = "silhouette";
  }
  const setup = LIGHT_SETUPS.find((s) => s.id === setupId);
  if (setup && setupId === "rembrandt") direction = `${setup.phrase}, key from ${side}`;

  const quality = light.softness < 0.25 ? "hard light with crisp shadows" : light.softness < 0.6 ? "medium-soft light" : "very soft, diffused light";
  const mood = MOODS.find((m) => m.id === light.mood);
  return {
    direction,
    quality,
    color: kelvinPhrase(light.kelvin),
    mood: mood?.phrase,
    setupId,
    setupTerm: setup?.term ?? (setupId === "under" ? "Under light" : "Custom"),
    moodTerm: mood?.term,
  };
}

/** Where the eye-level line (horizon) crosses the frame, which pins down the camera's tilt. */
function horizonPhrase(pitch: number, vfov: number, roll: number) {
  if (Math.abs(roll) > 4) return null; // a tilted horizon is described with the Dutch angle
  const y = -Math.tan(MathUtils.degToRad(pitch)) / Math.tan(MathUtils.degToRad(vfov / 2));
  if (y > 1) return "the horizon is above the top of the frame, so we look down onto the ground";
  if (y < -1) return "the horizon is below the bottom of the frame, so we look up";
  const fromTop = (1 - y) / 2;
  if (fromTop < 0.2) return "the horizon line sits near the top edge of the frame";
  if (fromTop < 0.42) return "the horizon line sits in the upper third of the frame";
  if (fromTop <= 0.58) return "the horizon line runs across the middle of the frame";
  if (fromTop < 0.8) return "the horizon line sits in the lower third of the frame";
  return "the horizon line sits near the bottom edge of the frame";
}

/** Background blur from the real optics (thin lens), described by how it looks. */
function focusPhrase(scene: Scene, focusName: string | null, background: number) {
  const f = scene.camera.focal / 1000;
  const s1 = Math.max(0.2, scene.camera.distance);
  const a = aspectById(scene.aspect);
  const sensor = Math.hypot(36, 24) / Math.sqrt((a.w / a.h) ** 2 + 1) / 1000;
  const coc = ((f * f) / (scene.camera.aperture * Math.max(s1 - f, 0.001))) * (Math.abs(background - s1) / background);
  const share = coc / sensor;
  const on = focusName ? `focus on ${focusName}` : "focus on the middle of the scene";
  if (share < 0.004) return `${on}, deep focus with the background sharp too`;
  if (share < 0.012) return `${on}, the background slightly soft`;
  if (share < 0.03) return `${on}, shallow depth of field with a softly blurred background`;
  return `${on}, very shallow depth of field, the background melted into creamy bokeh`;
}

/** The camera's move away from where the location photo was taken, in words (or null if it hardly moved). */
function moveFromPhotoPhrase(scene: Scene, camPos: Vector3, forward: Vector3) {
  const view = scene.place.image?.view;
  if (!view) return null;
  const m = moveFromPhoto(view, scene.place.scale ?? 1, camPos, forward);
  const meters = (v: number) => Math.abs(v).toFixed(1).replace(/\.0$/, "");
  const parts: string[] = [];
  if (Math.abs(m.yaw) >= 8) parts.push(`turned about ${Math.round(Math.abs(m.yaw))} degrees to the ${m.yaw > 0 ? "right" : "left"}`);
  if (Math.abs(m.sideways) >= 0.6) parts.push(`moved about ${meters(m.sideways)} m to the ${m.sideways > 0 ? "right" : "left"}`);
  if (Math.abs(m.rise) >= 0.4) parts.push(`${m.rise > 0 ? "raised" : "lowered"} about ${meters(m.rise)} m`);
  if (m.forward >= 0.8) parts.push(`moved about ${Math.round(m.forward)} m further into the scene`);
  else if (m.forward <= -0.8) parts.push(`pulled back about ${Math.round(-m.forward)} m`);
  if (Math.abs(m.pitch) >= 8) parts.push(`tilted ${m.pitch > 0 ? "up" : "down"} about ${Math.round(Math.abs(m.pitch))} degrees`);
  return parts.length ? parts : null;
}

function list(parts: string[]) {
  return parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/**
 * What goes to the image model, in order. A model that takes pictures gets the blocking frame first: the shot's
 * camera, the place, and a plain colored stand-in where each subject stands (it also sets the picture's shape).
 * Then each subject's own picture, clean and on its own, and the location photo when the camera has moved away
 * from where it was taken. With fewer slots the subjects share one sheet; a model that takes none gets words.
 */
export type ShotPicture = { role: "blocking" } | { role: "cast"; ids: string[] } | { role: "place" };

/** The subjects in the shot that have a picture, most prominent first: the framed one, then by size in frame. */
function castInShot(scene: Scene, framings: Framing[]) {
  const main = framings.find((f) => f.element.id === scene.camera.focusId) ?? framings[0];
  const weight = (f: Framing) => Math.min(1.5, f.span) * f.visible;
  return framings.filter((f) => f.element.image && f.inFrame).sort((a, b) => (a === main ? -1 : b === main ? 1 : weight(b) - weight(a)));
}

export function planPictures(scene: Scene, slots: number): ShotPicture[] {
  if (slots <= 0) return [];
  const cam = shotCamera(scene);
  const ids = castInShot(scene, frameElements(scene, cam)).map((f) => f.element.id);
  const out: ShotPicture[] = [{ role: "blocking" }];
  let free = slots - 1;
  if (ids.length <= free) {
    for (const id of ids) out.push({ role: "cast", ids: [id] });
    free -= ids.length;
  } else if (free >= 1) {
    // Not enough room for a picture each: the most prominent go alone, the rest share a sheet.
    const alone = ids.slice(0, free - 1);
    for (const id of alone) out.push({ role: "cast", ids: [id] });
    out.push({ role: "cast", ids: ids.slice(alone.length) });
    free = 0;
  }
  if (free >= 1 && scene.place.image && moveFromPhotoPhrase(scene, cam.position, cam.getWorldDirection(new Vector3()))) out.push({ role: "place" });
  return out;
}

/** Where a subject is on a sheet of n pictures side by side. */
function sheetSpot(k: number, n: number) {
  if (n === 2) return k === 0 ? "on the left" : "on the right";
  if (n === 3) return ["on the left", "in the middle", "on the right"][k];
  return `${["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth"][k] ?? `${k + 1}th`} from the left`;
}

/** What must not change about each kind of subject. */
const KEEP: Record<ElementKind, string> = {
  person: "people's faces, hair, skin tone, build, clothing and colors",
  animal: "animals' breed, coat colors, markings and build",
  vehicle: "vehicles' exact make and model, body shape, color, wheels and lights",
  product: "products' exact shape, proportions, materials, colors, label and lettering",
  object: "objects' shape, materials and colors",
};

const withArticle = (s: string) => `${/^[aeiou]/i.test(s) ? "an" : "a"} ${s}`;
const withoutArticle = (s: string) => s.replace(/^(a|an|the)\s+/i, "");

export function compileScene(scene: Scene, options: { pictures?: ShotPicture[] } = {}): CompiledShot {
  const cam = shotCamera(scene);
  const forward = cam.getWorldDirection(new Vector3());
  const camRight = new Vector3(1, 0, 0).applyQuaternion(cam.quaternion).setY(0).normalize();
  const framings = frameElements(scene, cam);
  const warnings: string[] = [];
  const a = aspectById(scene.aspect);
  const vfov = verticalFov(scene.camera.focal, a.w / a.h);
  const pictures = options.pictures ?? planPictures(scene, 16);

  // Pictures are numbered in the order they're sent ("image 1", "image 2", …).
  const blocking = pictures.findIndex((p) => p.role === "blocking") + 1 || null;
  const placeIndex = pictures.findIndex((p) => p.role === "place") + 1 || null;
  const shown = new Map<string, { image: number; spot?: string }>();
  pictures.forEach((p, i) => {
    if (p.role === "cast") p.ids.forEach((id, k) => shown.set(id, { image: i + 1, spot: p.ids.length > 1 ? sheetSpot(k, p.ids.length) : undefined }));
  });
  const byId = new Map(scene.elements.map((e) => [e.id, e]));
  const inputs: CompiledShot["inputs"] = pictures.map((p) => {
    if (p.role === "blocking") return { role: "blocking", label: "The blocking frame: camera, place and stand-ins" };
    if (p.role === "place") return { role: "place", label: "The location photo", url: scene.place.image?.url };
    const els = p.ids.map((id) => byId.get(id)).filter((e): e is SceneElement => Boolean(e));
    return { role: "cast", label: list(els.map((e) => e.name)), url: els[0]?.image?.url, colors: els.map((e) => colorOf(scene.elements, e.id).hex) };
  });
  // Everything the take is made from (the server picks what each model gets).
  const references: CompiledShot["references"] = castInShot(scene, framings).map((f) => ({
    url: f.element.image!.url,
    label: f.element.name,
    role: f.element.kind === "product" ? ("product" as const) : ("subject" as const),
  }));
  if (scene.place.image) references.push({ url: scene.place.image.url, label: scene.place.text || "location", role: "place" });

  const style = STYLES.find((s) => s.id === scene.style) ?? STYLES[0];
  const lens = nearest(LENSES, scene.camera.focal, (l) => l.focal);
  const aperture = nearest(APERTURES, scene.camera.aperture, (x) => x.f);
  const angle = classifyAngle(scene.camera.elevation, cam.position.y);
  const light = lightPhrases(scene, camRight);
  const pitch = MathUtils.radToDeg(Math.asin(MathUtils.clamp(forward.y, -1, 1)));

  const main = framings.find((f) => f.element.id === scene.camera.focusId) ?? framings[0];
  const realistic = ["photo", "cinematic", "documentary", "editorial", "product", "analog"].includes(style.id);
  const sentences: string[] = [];
  if (blocking) {
    sentences.push(
      `Image ${blocking} is the blocking frame for this shot, made in a 3D previz: it fixes the camera's position, height and angle, the lens perspective, the horizon and the framing, and it shows where everyone stands as plain colored stand-ins. Make the finished picture from exactly this camera, keeping image ${blocking}'s viewpoint, perspective, framing and horizon.`,
    );
  }
  sentences.push(`${style.phrase}.`);
  let shotSizeId = "wide";

  // "Man, the person in image 2"; "Car, the matte black Tesla Cybertruck on the right in image 3"; "Mila (a woman)".
  const who = (el: SceneElement) => {
    const pic = shown.get(el.id);
    const noun = el.read?.noun ? withoutArticle(el.read.noun) : ELEMENT_DEFAULTS[el.kind].noun;
    if (pic) return `${el.name}, the ${noun}${pic.spot ? ` ${pic.spot}` : ""} in image ${pic.image}`;
    const what = el.read?.noun ?? withArticle(ELEMENT_DEFAULTS[el.kind].noun);
    return el.name.toLowerCase() === withoutArticle(what).toLowerCase() ? what : `${el.name} (${what})`;
  };
  const standIn = (el: SceneElement) => `the ${colorOf(scene.elements, el.id).name} ${standInNoun(el.kind)}`;
  const raised = (el: SceneElement) => (el.lift > 0.15 ? `raised about ${el.lift.toFixed(1).replace(/\.0$/, "")} m off the ground` : null);
  // Words for a subject: what a vision model read in its picture (when the model can't see it), then what you wrote.
  const lookOf = (el: SceneElement) => {
    const parts = [!shown.has(el.id) ? el.read?.identity : null, el.look?.trim()].filter(Boolean);
    return parts.length ? `${el.name}: ${parts.join("; ")}.` : null;
  };

  if (main) {
    const size = classifyShotSize(main);
    shotSizeId = size.id;
    const el = main.element;
    const camPos = cam.position;
    const crop = el.kind === "person" ? size.crop : size.objectCrop;
    const detail = [crop, angle.phrase, framePosition(main.cx)];
    const sized = sizePhrase(main);
    if (sized && size.id !== "full") detail.push(sized);
    detail.push(facingPhrase(el, camPos, camRight));
    const up = raised(el);
    if (up) detail.push(up);
    if (el.action?.trim()) detail.push(el.action.trim());
    sentences.push(
      blocking
        ? `Replace ${standIn(el)} with ${who(el)}: ${withArticle(size.phrase)}, ${detail.join(", ")}.`
        : `${capitalize(size.phrase)} of ${who(el)}, ${detail.join(", ")}.`,
    );
    const look = lookOf(el);
    if (look) sentences.push(look);
    if (!main.inFrame) warnings.push(`${el.name} is outside the frame. Move the camera or the subject.`);

    for (const f of framings) {
      if (f === main) continue;
      const other = f.element;
      if (f.behindCamera) {
        warnings.push(`${other.name} is behind the camera and won't be in the shot.`);
        continue;
      }
      if (!f.inFrame) {
        warnings.push(`${other.name} is outside the frame.`);
        continue;
      }
      const o = [relationPhrase(f, main), framePosition(f.cx)];
      const s = sizePhrase(f);
      if (s) o.push(s);
      o.push(facingPhrase(other, camPos, camRight));
      const otherUp = raised(other);
      if (otherUp) o.push(otherUp);
      if (other.action?.trim()) o.push(other.action.trim());
      sentences.push(blocking ? `Replace ${standIn(other)} with ${who(other)}: ${o.join(", ")}.` : `${capitalize(`${who(other)} is ${o.join(", ")}`)}.`);
      const otherLook = lookOf(other);
      if (otherLook) sentences.push(otherLook);
      // Someone riding or sitting on the other one (Arrange puts a rider on the saddle) is meant to be there.
      const mounted = (a: SceneElement, b: SceneElement) => a.lift > 0.05 && Math.hypot(a.x - b.x, a.z - b.z) < 0.4 && (b.kind === "vehicle" || b.kind === "animal" || b.kind === "object");
      if (Math.abs(f.cx - main.cx) < 0.08 && Math.abs(f.depth - main.depth) < 0.35 && !mounted(other, el) && !mounted(el, other)) {
        warnings.push(`${other.name} overlaps ${el.name}. Spread them apart on the set.`);
      }
    }
    // Models drop a subject now and then (a stand-in they don't read as anything): name everyone who must be there.
    const cast = framings.filter((f) => f.inFrame).map((f) => f.element.name);
    if (blocking && cast.length > 1) sentences.push(`${cast.length === 2 ? "Both" : `All ${cast.length}`} must be clearly in the picture: ${list(cast)}.`);
  } else {
    sentences.push(`${capitalize(angle.phrase)}.`);
    if (!scene.place.image && !scene.notes.trim()) warnings.push("Add a location or a subject, or describe the shot in the notes.");
  }

  // Each subject keeps everything that makes it itself; the stand-ins only say where it stands and which way it turns.
  const kinds = [...new Set(framings.filter((f) => f.inFrame && shown.has(f.element.id)).map((f) => f.element.kind))];
  if (kinds.length) {
    sentences.push(
      `Keep every subject exactly as in its own picture: ${kinds.map((k) => KEEP[k]).join("; ")}.${blocking ? " Pose and turn each one like its stand-in, not like its photo." : " Pose them as described here, not as in their photos."}`,
    );
  }

  // The location.
  const where = scene.place.text.trim();
  if (blocking && scene.place.image) {
    const moved = moveFromPhotoPhrase(scene, cam.position, forward);
    if (placeIndex) {
      sentences.push(
        `The place${where ? `, ${where},` : ""} is the location in image ${placeIndex}, photographed from another spot: take the place's look from it (layout, architecture, materials, colors, signs and light) but never its viewpoint or framing${moved ? `; compared with that photo this camera has ${list(moved)}` : ""}.`,
      );
    } else {
      sentences.push(`The place${where ? `, ${where},` : ""} is the one in image ${blocking}: keep its layout, architecture, materials, colors and light, and redraw any smeared or stretched parts cleanly.`);
    }
    sentences.push(`Flat gray areas in image ${blocking} are parts of the place the photo never showed: continue the place there naturally.`);
  } else if (blocking) {
    sentences.push(`Image ${blocking}'s gray floor grid and plain backdrop only mark the ground and the horizon: ${where ? `the place is ${where}` : "build a fitting location there"}.`);
  } else if (where) {
    sentences.push(`Location: ${where}.`);
  }

  const camera = [`Camera ${cameraHeightPhrase(cam.position.y)}`, lens.phrase];
  const horizon = horizonPhrase(pitch, vfov, scene.camera.roll);
  if (horizon) camera.push(horizon);
  const bgDistance = scene.place.image?.view ? Math.max(scene.camera.distance * 2.5, (scene.place.image.view.far * (scene.place.scale ?? 1)) / 3) : scene.camera.distance * 3 + 4;
  camera.push(focusPhrase(scene, main?.element.name ?? null, bgDistance));
  if (Math.abs(scene.camera.roll) > 4) camera.push(`Dutch angle, the frame tilted ${Math.round(Math.abs(scene.camera.roll))} degrees`);
  sentences.push(`${camera.join(", ")}.`);

  sentences.push(`Lighting: ${light.direction}, ${light.quality}, ${light.color}${light.mood ? `; ${light.mood}` : ""}.`);

  if (scene.notes.trim()) sentences.push(`Additional direction: ${scene.notes.trim()}`);
  sentences.push(
    blocking
      ? `The stand-ins are only placeholders: no colored figures, mannequins, gray patches or grid lines are left in the picture, and every subject is ${realistic ? "real, with natural, fully three-dimensional faces, bodies and shapes" : "fully drawn, with natural, three-dimensional shapes"}. One single coherent image, no text, captions, borders or watermarks.`
      : "One single coherent image. No text, captions, borders or watermarks.",
  );

  const shotSize = SHOT_SIZES.find((s) => s.id === shotSizeId);
  const sheet: SheetItem[] = [
    { key: "style", label: "Style", value: style.term },
    { key: "shot", label: "Shot", value: shotSize?.term ?? "Wide shot" },
    { key: "angle", label: "Angle", value: angleTerm(angle.id) },
    { key: "lens", label: "Lens", value: `${Math.round(scene.camera.focal)}mm` },
    { key: "focus", label: "Focus", value: aperture.term },
    { key: "light", label: "Light", value: light.setupTerm },
  ];
  if (light.moodTerm) sheet.push({ key: "mood", label: "Mood", value: light.moodTerm });
  if (main) sheet.push({ key: "placement", label: "Placement", value: placementTerm(main.cx) });

  return {
    prompt: sentences.join(" "),
    sheet,
    references,
    inputs,
    warnings,
    measured: { angle: angle.id, shotSize: shotSizeId, lens: lens.id, aperture: aperture.id, light: light.setupId },
    layout: layoutBoxes(scene, new Map([...shown].map(([id, p]) => [id, p.image]))),
  };
}

/**
 * The pictures a brief goes with, in order: each subject in the shot (the framed one first, then by size) as its Cast
 * sheet or its photo, then the location photo, as many as the model takes (the location goes when there's room).
 */
export function briefPictures(scene: Scene, slots: number) {
  const cam = shotCamera(scene);
  const framings = frameElements(scene, cam);
  const subjects = castInShot(scene, framings)
    .map((f) => f.element)
    .concat(framings.filter((f) => f.inFrame && !f.element.image && f.element.cast?.sheet).map((f) => f.element));
  const room = Math.max(0, slots - (scene.place.image ? 1 : 0));
  const picked = subjects.slice(0, room).map((el, i) => ({ el, image: i + 1, url: el.cast?.sheet ?? el.image?.sourceUrl ?? el.image?.url ?? "", sheet: Boolean(el.cast?.sheet) }));
  const place = scene.place.image && slots > picked.length ? { url: scene.place.image.url, image: picked.length + 1 } : null;
  return { subjects: picked.filter((p) => p.url), place };
}

/** The brief and its pictures for a model that takes `slots` pictures. */
export function compileBrief(scene: Scene, slots = 5) {
  const { subjects, place } = briefPictures(scene, slots);
  const prompt = briefPrompt(scene, new Map(subjects.map((s) => [s.el.id, { image: s.image, sheet: s.sheet }])), place?.image ?? null);
  return { prompt, subjects, place };
}

/**
 * The stand-ins on the real place, swapped for the subjects: one edit of one picture (the place as this camera sees it,
 * a plain colored figure where each subject stands), each subject's own picture beside it (`pictures`: its image number,
 * and whether it shows the subject from the side the camera sees it) or else in words. Measured on Grok 2.0
 * (2026-10-28, the user's gas station shot): an edit of one coherent picture keeps its camera and place exactly, and
 * the model draws each subject fresh, lit by the scene, at the figure's spot, size and facing.
 */
export function swapPrompt(
  scene: Scene,
  pictures: Map<string, { image: number; sheet?: boolean; matched?: boolean }> = new Map(),
  place: { things?: string[]; kept?: Set<string> } = {},
) {
  const cam = shotCamera(scene);
  const all = frameElements(scene, cam).filter((f) => f.inFrame);
  // Subjects the place photo already shows (the same car) stay as the photo has them: no stand-in, no second one.
  const kept = all.filter((f) => place.kept?.has(f.element.id));
  const framings = all.filter((f) => !place.kept?.has(f.element.id));
  const style = STYLES.find((x) => x.id === scene.style) ?? STYLES[0];
  const realistic = ["photo", "cinematic", "documentary", "editorial", "product", "analog"].includes(style.id);
  const shot = pictures.size ? " in image 1" : "";
  const colors: string[] = [];
  const sentences: string[] = [];
  for (const f of framings) {
    const el = f.element;
    const color = colorOf(scene.elements, el.id);
    colors.push(color.name);
    const noun = el.read?.noun ? withoutArticle(el.read.noun) : ELEMENT_DEFAULTS[el.kind].noun;
    const figure = `${color.name} ${standInNoun(el.kind)}`;
    const pic = pictures.get(el.id);
    const look = el.look?.trim();
    // A subject with its own picture is named, not described: face details ("bright blue eyes") pull models into
    // drawing it facing the camera.
    if (pic) {
      const which = pic.matched ? `the same ${noun}, seen from the same side as here` : pic.sheet ? "a reference sheet of the same subject from several sides" : "";
      const like = el.kind === "person" || el.kind === "animal" ? "them" : "it";
      sentences.push(`Replace the ${figure}${shot} with the ${noun} from image ${pic.image}${which ? ` (${which})` : ""}, looking exactly like ${like}: ${KEEP[el.kind].replace(/^\w+'s? /, "")}${look ? `; ${look}` : ""}.`);
    } else {
      const looks = [el.read?.identity, look].filter(Boolean).join("; ");
      sentences.push(`Replace the ${figure}${shot} with a real ${noun}${looks ? ` (${looks})` : ""}.`);
    }
    const it = el.kind === "person" ? "They stand" : "It stands";
    sentences.push(`${it} exactly where the ${figure} stands and exactly as large, cut off by the frame where it is, turned exactly the way the ${figure} is turned: ${facingWords(el, cam.position)}${el.action?.trim() ? `; ${el.action.trim()}` : ""}.`);
    // How much of it the frame holds, in shot-size words. Measured on Grok 2.0: a stand-in filling the frame (a close-up)
    // without them came back as a full-body shot from twice as far.
    const size = classifyShotSize(f);
    sentences.push(`${capitalize(`the ${noun}`)} is seen in ${withArticle(size.phrase)}, ${el.kind === "person" ? size.crop : size.objectCrop}, ${framingPhrase(f)}.`);
  }
  // People and animals staged by a car or a thing stand outside it. Measured on Grok 2.0: a man staged just in front of
  // a Cybertruck, his stand-in over the car's, came back sitting in the driver's seat.
  const nounOf = (el: SceneElement) => (el.read?.noun ? withoutArticle(el.read.noun) : ELEMENT_DEFAULTS[el.kind].noun);
  for (const f of framings) {
    if ((f.element.kind !== "person" && f.element.kind !== "animal") || /(driv\w*|inside|seated in|sitting in|riding|rides|in the (car|truck|van|bus|boat|seat))/i.test(f.element.action ?? "")) continue;
    for (const g of framings) {
      if (g === f || g.element.kind === "person" || g.element.kind === "animal" || Math.abs(g.cx - f.cx) > 0.9) continue;
      if (Math.hypot(g.element.x - f.element.x, g.element.z - f.element.z) > 6) continue;
      sentences.push(`The ${nounOf(f.element)} stands on the ground outside the ${nounOf(g.element)}, ${f.depth < g.depth ? "between it and the camera" : "beyond it, farther from the camera"}, not in or on it.`);
    }
  }
  for (const f of kept) {
    const noun = nounOf(f.element);
    sentences.push(`The ${noun} already in the place stays exactly as it is: it is the only ${noun} in the picture.`);
  }
  sentences.push(onceRule(place.things ?? [], framings.length > 0));
  sentences.push(`Keep everything else${shot} exactly as it is: the camera (${cameraWords(scene)}), the framing, the place and its light.`);
  const camRight = new Vector3(1, 0, 0).applyQuaternion(cam.quaternion).setY(0).normalize();
  const light = lightPhrases(scene, camRight);
  sentences.push(`Light ${framings.length > 1 ? "them" : "it"} the way the place is lit (${light.direction}, ${light.quality}), with natural shadows on the ground and reflections on wet or shiny surfaces.`);
  if (scene.notes.trim()) sentences.push(`Also: ${scene.notes.trim()}`);
  // FLUX 3 Klein drew the user's "holding a phone to his ear" with no phone in the hand.
  if (framings.some((f) => f.element.kind === "person") && (scene.notes.trim() || framings.some((f) => f.element.action?.trim()))) {
    sentences.push("Anything a person holds or uses is clearly visible, whole and real in their hand.");
  }
  if (colors.length) sentences.push(`No ${list([...new Set(colors)])} anywhere.`);
  sentences.push(`${style.phrase}. One ${realistic ? "natural photograph" : "coherent picture"}, no text.`);
  return sentences.join(" ");
}

/**
 * Everything once. Measured on Grok 2.0 (the user's gas station shot, camera a meter from the car): the photo's one red
 * Mustang, stretched across the frame up close, came back as two cars, a hood in front and a whole car behind; and a
 * car staged where the place already had one came back stacked on it. `things` are what the place photo shows
 * ("one red Ford Mustang convertible"); only those already in the picture count, so none is added where the camera
 * turned away from it.
 */
export function onceRule(things: string[], subjects: boolean) {
  const known = things.length ? ` (${list(things)})` : "";
  return [
    `Nothing appears twice: each car, person, animal and object in the place${known} is the only one of it, even when only part of it shows or it is stretched up close, and any of those not already in the picture stays out of it.`,
    subjects ? "Each subject appears exactly once, and nothing is doubled, stacked or overlapping: a subject standing where the place has the same kind of thing (a car where a car is) takes its place." : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * Which way a subject faces, said as what the camera sees of it: which eye and ear show, where the nose, chest or
 * front end points. Measured on Grok 2.0 (2026-10-28, the user's gas station shot): "in profile, looking toward the
 * right edge of the frame" came back turned to the camera; "we see the right side of his face: one eye, his right ear,
 * his nose pointing at the right edge; he does not turn toward the camera" came back in profile, both takes. A subject
 * facing frame right shows the camera its right side.
 */
function facingWords(el: SceneElement, camPos: Vector3) {
  const around = angleDelta(el.yaw, yawTowardCamera(el, camPos));
  const a = Math.abs(around);
  const dir = around > 0 ? "left" : "right";
  if (el.kind === "person") {
    if (a < 22.5) return "facing the camera: we see their whole face, both eyes and the front of their body";
    if (a < 67.5) return `turned three-quarters toward the ${dir} edge of the frame: we see more of the ${dir} side of their face, the far eye partly hidden, their nose pointing toward the ${dir} edge and their chest and shoulders turned that way too; they are not looking at the camera`;
    if (a < 112.5) return `in full side profile, facing the ${dir} edge of the frame: we see the ${dir} side of their face and body, one eye and their ${dir} ear, their nose pointing at the ${dir} edge and their shoulders and chest facing it too; they do not look at or turn toward the camera`;
    if (a < 157.5) return `turned mostly away from the camera, toward the ${dir} side of the background: we see the back of their head, their ${dir} ear and the edge of their ${dir} cheek, their back and ${dir} shoulder, not their face`;
    return "with their back to the camera: we see the back of their head and body, not their face";
  }
  if (el.kind === "animal") {
    if (a < 22.5) return "facing the camera: we see its whole face, both eyes and its chest";
    if (a < 67.5) return `turned three-quarters toward the ${dir} edge of the frame: we see its face and more of its ${dir} side, its nose pointing toward the ${dir} edge`;
    if (a < 112.5) return `side-on, facing the ${dir} edge of the frame: we see its whole ${dir} side and one eye, its nose pointing at the ${dir} edge`;
    if (a < 157.5) return `turned mostly away from the camera, toward the ${dir}: we see its back, its ${dir} side and the back of its head, not its face`;
    return "seen from behind: we see its back and the back of its head, not its face";
  }
  if (el.kind === "vehicle") {
    if (a < 22.5) return "seen from the front: its front points straight at the camera, we see its grille and both headlights";
    if (a < 67.5) return `seen at a three-quarter angle from the front: its front end points toward the ${dir} edge of the frame, we see its front and its whole ${dir} side`;
    if (a < 112.5) return `seen exactly side-on: its front points at the ${dir} edge of the frame, we see its whole ${dir} side and both wheels on that side`;
    if (a < 157.5) return `seen from behind at an angle: its front points away, toward the ${dir}, we see its rear, its tail lights and its ${dir} side`;
    return "seen from directly behind: we see its rear and both tail lights";
  }
  return seenPhrase(el, camPos);
}

/** An empty stage's plate (a gray floor grid to a plain horizon) turned into the place, from exactly this camera. */
export function buildPlacePrompt(scene: Scene) {
  const where = scene.place.text.trim() || "a fitting location for the shot";
  const style = STYLES.find((x) => x.id === scene.style) ?? STYLES[0];
  return `Turn this gray floor grid and plain backdrop into a real place: ${where}. Keep exactly this camera (${cameraWords(scene)}): the same horizon height, perspective, tilt and lens, the floor where the grid is. No people, vehicles or animals. ${style.phrase}. One natural picture, no text.`;
}

/** Where the shot's camera is, in a photographer's words ("shot from high above, looking steeply down at about 55 degrees, with a 35mm lens"). */
export function cameraWords(scene: Scene) {
  const cam = shotCamera(scene);
  return cameraPhrase(scene, cam.position.y, Math.round(scene.camera.focal));
}

/** The shot's light in words, as the prompt says it ("Lighting: key light from frame right…"). */
export function lightingPhrase(scene: Scene) {
  const cam = shotCamera(scene);
  const camRight = new Vector3(1, 0, 0).applyQuaternion(cam.quaternion).setY(0).normalize();
  const light = lightPhrases(scene, camRight);
  return `Lighting: ${light.direction}, ${light.quality}, ${light.color}${light.mood ? `; ${light.mood}` : ""}`;
}

/**
 * The last pass of a composed shot, given the composite alone (each subject drawn from the camera's angle and set
 * exactly where it stands, so it already looks like them): everything in it is final but how it's blended. Measured on
 * Grok 2.0: alone, the model keeps the composite (depth rank correlation 0.998); with each subject's photo beside it, it
 * re-frames the shot (0.73 and lower), so their photos stay out of this pass.
 */
export function finishPrompt(scene: Scene) {
  const cam = shotCamera(scene);
  const framings = frameElements(scene, cam);
  const style = STYLES.find((x) => x.id === scene.style) ?? STYLES[0];
  const realistic = ["photo", "cinematic", "documentary", "editorial", "product", "analog"].includes(style.id);
  const main = framings.find((f) => f.element.id === scene.camera.focusId) ?? framings[0];
  const names = framings.filter((f) => f.inFrame).map((f) => f.element.read?.noun?.replace(/^(a|an|the)\s+/i, "the ") ?? f.element.name);
  const sentences = [
    `Make this composite one seamless ${realistic ? "photograph" : "finished picture"}: ${style.phrase.charAt(0).toLowerCase()}${style.phrase.slice(1)}.`,
    `Blend ${names.length ? list(names) : "everything"} into the place: matching light, color, focus and grain, contact shadows on the ground, reflections on wet or shiny surfaces, clean edges. Fill any flat gray areas with more of the place.`,
    "Keep the exact same camera, framing and crop: everything stays exactly where it is and the same size, cut off by the frame's edges just as it is now. Nothing moves, nothing is added or removed.",
  ];
  const bgDistance = scene.place.image?.view ? Math.max(scene.camera.distance * 2.5, (scene.place.image.view.far * (scene.place.scale ?? 1)) / 3) : scene.camera.distance * 3 + 4;
  sentences.push(`${capitalize(focusPhrase(scene, main?.element.name ?? null, bgDistance))}.`);
  sentences.push(`${lightingPhrase(scene)}.`);
  if (scene.notes.trim()) sentences.push(`Additional direction: ${scene.notes.trim()}`);
  sentences.push("One single coherent image, no text, captions, borders or watermarks.");
  return sentences.join(" ");
}

/**
 * Which side of a subject the camera sees, said as what shows in the picture. Models read "turned three-quarters
 * left" as "facing the camera"; "we see the left side of their face as they look off toward the left edge" they draw.
 * The camera on a subject's left (around > 0) sees it facing frame left.
 */
function seenPhrase(el: SceneElement, camPos: Vector3) {
  const around = angleDelta(el.yaw, yawTowardCamera(el, camPos));
  const a = Math.abs(around);
  const dir = around > 0 ? "left" : "right";
  if (el.kind === "person" || el.kind === "animal") {
    const face = el.kind === "person" ? "face" : "head";
    if (a < 22.5) return el.kind === "person" ? "facing the camera" : "facing the camera";
    if (a < 67.5) return `turned three-quarters: we see the ${dir} side of their ${face} as they look off toward the ${dir} edge of the frame, not at the camera`;
    if (a < 112.5) return `in profile, looking toward the ${dir} edge of the frame`;
    if (a < 157.5) return `turned mostly away from the camera: we see the back of their head and their ${dir} shoulder`;
    return "with their back to the camera";
  }
  if (a < 22.5) return "seen from the front, facing the camera";
  if (a < 67.5) return `seen at a three-quarter angle, its front end toward the ${dir} edge of the frame`;
  if (a < 112.5) return `seen side-on, its front toward the ${dir} edge of the frame`;
  if (a < 157.5) return `seen from behind at an angle, its front pointing away toward the ${dir}`;
  return "seen from behind";
}

/** Where the camera is, in a photographer's words: how high, which way it looks, the lens. */
function cameraPhrase(scene: Scene, camY: number, lensFocal: number) {
  const e = scene.camera.elevation;
  const deg = Math.round(Math.abs(e) / 5) * 5;
  const lens = lensFocal <= 20 ? `an ultra-wide ${lensFocal}mm lens` : lensFocal <= 30 ? `a wide ${lensFocal}mm lens` : lensFocal < 70 ? `a ${lensFocal}mm lens` : `a long ${lensFocal}mm lens`;
  if (e >= 70) return `a top-down shot from high above, looking straight down, with ${lens}`;
  if (e >= 35) return `shot from high above, looking steeply down at about ${deg} degrees, with ${lens}`;
  if (e >= 9) return `shot from above ${camY < 2.2 ? "head height" : "the subject"}, looking down at about ${deg} degrees, with ${lens}${camY < 2.2 ? ", so we see the tops of heads and shoulders from above" : ""}`;
  if (e > -9) return camY < 0.5 ? `shot from ground level, looking straight ahead, with ${lens}` : `shot at eye level with ${lens}`;
  if (e > -40) return `shot from low down, looking up at about ${deg} degrees, with ${lens}`;
  return `a worm's-eye shot from the ground, looking steeply up, with ${lens}`;
}

/** Where a subject is across the frame, and whether the frame's edges cut it off. */
function framingPhrase(f: Framing) {
  const where = f.cx < -0.5 ? "on the left side of the frame" : f.cx < -0.17 ? "left of center" : f.cx <= 0.17 ? "in the middle of the frame" : f.cx <= 0.5 ? "right of center" : "on the right side of the frame";
  const cut = Math.abs(f.cx) > 0.8 ? `, partly cut off by the ${f.cx > 0 ? "right" : "left"} edge` : "";
  return `${where}${cut}`;
}

/**
 * The shot as a brief for a model that draws it from references (each subject's own picture and the location's):
 * the camera first, then what the camera sees of each subject, in suggestive photographer's words rather than numbers,
 * then who's who, the place, the light and the look. No 3D frame goes with it: measured on Grok 2.0 and Qwen-Image 2.1,
 * a frame among the references is ignored, and alone it is copied (cut-outs look pasted); references with this brief
 * give natural pictures that keep the camera closest. `pictures` gives each subject's image number (and whether it is a
 * reference sheet), `place` the location's.
 */
export function briefPrompt(scene: Scene, pictures: Map<string, { image: number; sheet?: boolean }>, place: number | null) {
  const cam = shotCamera(scene);
  const framings = frameElements(scene, cam).filter((f) => f.inFrame);
  const style = STYLES.find((x) => x.id === scene.style) ?? STYLES[0];
  const lens = nearest(LENSES, scene.camera.focal, (l) => l.focal);
  const main = framings.find((f) => f.element.id === scene.camera.focusId) ?? framings[0];
  const name = (el: SceneElement) => capitalize(el.name);
  const sentences = [`Camera: ${cameraPhrase(scene, cam.position.y, Math.round(scene.camera.focal))}.`];

  if (main) {
    const size = classifyShotSize(main);
    const el = main.element;
    const crop = el.kind === "person" ? size.crop : size.objectCrop;
    sentences.push(`${capitalize(withArticle(size.phrase))} of ${el.name}, ${crop}, ${framingPhrase(main)}, ${seenPhrase(el, cam.position)}${el.action?.trim() ? `, ${el.action.trim()}` : ""}.`);
    for (const f of framings) {
      if (f === main) continue;
      const other = f.element;
      sentences.push(`${name(other)} is ${relationPhrase(f, main)}, ${framingPhrase(f)}, ${seenPhrase(other, cam.position)}${other.action?.trim() ? `, ${other.action.trim()}` : ""}.`);
    }
  } else {
    sentences.push(`${capitalize(withArticle(lens.term))} view of the place.`);
  }

  // Who's who: each subject's own picture, and what it looks like in words.
  for (const f of framings) {
    const el = f.element;
    const pic = pictures.get(el.id);
    const noun = el.read?.noun ? withoutArticle(el.read.noun) : ELEMENT_DEFAULTS[el.kind].noun;
    const look = [el.look?.trim()].filter(Boolean).join("; ");
    if (pic) sentences.push(`${name(el)} is the ${noun} in image ${pic.image}${pic.sheet ? " (a reference sheet: the same subject seen from several sides)" : ""}${look ? `: ${look}` : ""}; keep ${KEEP[el.kind].replace(/^\w+'s? /, "")} exactly as there.`);
    else sentences.push(`${name(el)} is ${withArticle(noun)}${look ? `: ${look}` : el.read?.identity ? `: ${el.read.identity}` : ""}.`);
  }

  const where = scene.place.text.trim();
  if (place) sentences.push(`The place${where ? `, ${where},` : ""} is the location in image ${place}; draw it from this camera's viewpoint.`);
  else if (where) sentences.push(`The place: ${where}.`);
  const camRight = new Vector3(1, 0, 0).applyQuaternion(cam.quaternion).setY(0).normalize();
  const light = lightPhrases(scene, camRight);
  sentences.push(`Lighting: ${light.direction}, ${light.quality}, ${light.color}${light.mood ? `; ${light.mood}` : ""}.`);
  const bgDistance = scene.place.image?.view ? Math.max(scene.camera.distance * 2.5, (scene.place.image.view.far * (scene.place.scale ?? 1)) / 3) : scene.camera.distance * 3 + 4;
  sentences.push(`${style.phrase}. ${capitalize(focusPhrase(scene, main?.element.name ?? null, bgDistance))}.`);
  if (scene.notes.trim()) sentences.push(`Additional direction: ${scene.notes.trim()}`);
  const realistic = ["photo", "cinematic", "documentary", "editorial", "product", "analog"].includes(style.id);
  sentences.push(`One single ${realistic ? "natural photograph" : "coherent picture"}, no text, captions, borders or watermarks.`);
  return sentences.join(" ");
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function angleTerm(id: string) {
  return (
    {
      "worms-eye": "Worm's-eye",
      low: "Low angle",
      ground: "Ground level",
      eye: "Eye level",
      high: "High angle",
      "birds-eye": "Bird's-eye",
      overhead: "Top-down",
    } as Record<string, string>
  )[id];
}

function placementTerm(cx: number) {
  if (cx < -0.28) return "Left third";
  if (cx > 0.28) return "Right third";
  return "Center";
}
