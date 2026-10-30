import type { AngleFacts } from "./rig";

/**
 * Words for an Angles move, written from research on camera-angle editing:
 *  - Asked in words alone, general image models barely move the camera (SpatialEdit-Bench measured
 *    viewpoint errors of 0.84–0.92 for Nano Banana, Seedream and Qwen, where 1.0 = didn't move).
 *    Conditioning on a render of the scene's depth from the new camera is what makes camera moves
 *    precise (GEN3C, ViewCrafter), so Crackio sends that render as a guide whenever it can.
 *  - Each image gets one role: the original for everything's appearance, the guide for the
 *    viewpoint only, and the guide's smears and gaps are named as "not content" (otherwise models
 *    copy them: DepthDirector's "inpainting trap").
 *  - "Left side view" is ambiguous (camera's left or the subject's?) and gives mirrored results.
 *    The move is said three ways that can't be misread: where the camera goes relative to the
 *    original shot, which sides of things come into view, and which way things now face in the
 *    frame, all in picture terms, so it holds whichever way the subject faces.
 *  - Degrees plus the shot's name; height as the camera's height and tilt plus what that reveals.
 *  - One blanket "keep" clause: itemized keep-lists make models under-edit.
 *  - An explicit "the change must be unmistakable" line, and never a mirror image.
 */

const round = (n: number, step = 5) => Math.round(n / step) * step;

/** How the view of whatever faced the original camera changes, by how far around the camera went. */
function viewName(a: number) {
  if (a >= 150) return "seen from directly behind";
  if (a >= 110) return "seen in a three-quarter rear view";
  if (a >= 60) return "seen in full profile";
  if (a >= 30) return "seen in a three-quarter view";
  return "seen slightly turned";
}

/** Where the camera goes around the orbit point. */
function orbitPhrase(f: AngleFacts, around: string) {
  const a = Math.abs(f.azimuth);
  if (a < 3) return null;
  if (a >= 165) return `orbits all the way around ${around} to the far side, looking back toward where the original camera stood`;
  return `orbits ${round(a)}° to the ${f.azimuth < 0 ? "left" : "right"} around ${around}`;
}

/** What the orbit shows: three cues in picture terms, true whichever way the subject faces. */
function orbitEffects(az: number) {
  const a = Math.abs(az);
  if (a < 3) return [];
  const went = az < 0 ? "left" : "right";
  const other = az < 0 ? "right" : "left";
  if (a >= 150) {
    return [
      "Anything that faced the original camera is now seen from behind: its back faces the camera.",
      "The background is now the part of the place that was behind the original camera, which the photo never showed; continue the place believably.",
    ];
  }
  return [
    `Everything that faced the original camera is now ${viewName(a)}, turned toward the ${other} edge of the frame, and the sides of things that faced the ${went} edge of the original picture now face the camera.`,
    `The background shifts with real parallax: it slides to the ${went}, so scenery from the ${other} side of the original picture moves in behind the subject${a >= 60 ? " and new parts of the place come into view" : ""}.`,
  ];
}

function heightPhrase(f: AngleFacts) {
  const el = f.elevation;
  if (Math.abs(el - f.photoElevation) < 3) return "stays at the same height as the original camera";
  const meters = f.height != null ? ` with the lens about ${f.height < 1 ? f.height.toFixed(1) : Math.round(f.height)} m above the ground` : "";
  if (el >= 80) return `rises straight overhead and looks directly down on the subject (a top-down view)${meters}`;
  if (el >= 50) return `rises high and looks steeply down at the subject from about ${round(el)}° above (a bird's-eye view)${meters}`;
  if (el >= 12) return `rises and looks down at the subject from about ${round(el)}° above (a high angle)${meters}`;
  if (el > -12) return `${el > f.photoElevation ? "rises" : "drops"} to the subject's level and looks straight at it (eye level)${meters}`;
  if (el > -35) return `drops low and looks up at the subject from about ${round(-el)}° below (a low angle)${meters}`;
  return `drops to the ground and looks steeply up at the subject from about ${round(-el)}° below (a worm's-eye view)${meters}`;
}

function heightEffect(f: AngleFacts) {
  const d = f.elevation - f.photoElevation;
  if (Math.abs(d) < 3) return null;
  if (f.elevation >= 80) return "We see the tops of heads and objects with the ground spread out flat beneath them; the horizon is out of the frame.";
  if (d > 0) return "We see more of the tops of things and more of the ground, and the horizon sits higher in the frame or leaves it.";
  return "We see more of the undersides of things and more sky or ceiling, things loom taller, and the horizon sits lower in the frame.";
}

function distancePhrase(distance: number) {
  if (distance < 0.6) return "moves in much closer, so the subject fills much more of the frame";
  if (distance < 0.88) return "moves in closer, so the subject fills more of the frame";
  if (distance > 1.8) return "pulls far back, showing much more of the place around the original picture";
  if (distance > 1.13) return "steps back, showing more of the place around the original picture";
  return null;
}

/** What the camera orbits, in words. */
function aroundPhrase(o: AngleFacts["orbit"]) {
  const h = o.u < 0.36 ? "left" : o.u > 0.64 ? "right" : "";
  const v = o.v < 0.36 ? "upper" : o.v > 0.64 ? "lower" : "";
  const where = [v, h].filter(Boolean).join(" ");
  if (o.kind === "subject") return where ? `the main subject (in the ${where} part of the picture)` : "the main subject";
  if (o.kind === "middle") return "the middle of the picture";
  return `the thing in the ${where || "middle"} part of the original picture`;
}

/** The move as one sentence: "The camera orbits 45° to the left around …, rises …, and moves in closer." */
export function moveSentence(f: AngleFacts) {
  const parts = [orbitPhrase(f, aroundPhrase(f.orbit)) ?? "stays on the same side of the subject", heightPhrase(f)];
  const dist = distancePhrase(f.distance);
  if (dist) parts.push(dist);
  else if (Math.abs(f.azimuth) >= 3) parts.push("keeps the same distance");
  return `The camera ${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}.`;
}

export function isOriginal(f: AngleFacts) {
  return Math.abs(f.azimuth) < 3 && Math.abs(f.elevation - f.photoElevation) < 3 && !distancePhrase(f.distance);
}

/** Short label: "45° left · high 30° · closer". */
export function angleSummary(f: AngleFacts) {
  const a = Math.abs(f.azimuth);
  const parts: string[] = [];
  if (a >= 165) parts.push("from behind");
  else if (a >= 3) parts.push(`${round(a)}° ${f.azimuth < 0 ? "left" : "right"}`);
  if (Math.abs(f.elevation - f.photoElevation) >= 3) {
    const el = f.elevation;
    parts.push(el >= 80 ? "top-down" : el >= 12 ? `high ${round(el)}°` : el > -12 ? "eye level" : `low ${round(-el)}°`);
  }
  const d = f.distance;
  if (d < 0.6) parts.push("much closer");
  else if (d < 0.88) parts.push("closer");
  else if (d > 1.8) parts.push("much wider");
  else if (d > 1.13) parts.push("wider");
  return parts.length ? parts.join(" · ") : "as shot";
}

/** A readable sentence for the page. */
export function describeMove(f: AngleFacts) {
  if (isOriginal(f)) return "The camera is where the photo was taken. Drag the 3D view to move it.";
  return moveSentence(f);
}

/** Which image is which in the guided prompt. Crackio sends the original first, the guide second. */
export type GuideOrder = "original-first" | "guide-first";

/**
 * The prompt. With a guide, the 3D preview from the new camera rides along as a second image (or
 * first, with `order`); without one, words carry the move.
 */
export function anglePrompt(f: AngleFacts, { guide, order = "original-first" }: { guide: boolean; order?: GuideOrder }) {
  const effects = [...orbitEffects(f.azimuth), heightEffect(f)].filter(Boolean).join(" ");
  const widen = f.distance > 1.13 ? " Extend the scene beyond the original picture's edges, consistent with it." : "";
  const light = "Lights stay fixed in the scene, so light and shadows fall at a new angle relative to the camera; don't relight.";

  if (guide) {
    const [original, preview] = order === "original-first" ? ["Image 1", "Image 2"] : ["Image 2", "Image 1"];
    return [
      `${original} is the original photo. ${preview} is a rough 3D preview of the same scene from a new camera position: it was made from ${original}'s depth, so it is stretched and smeared in places, the backs of things are only washed-out silhouettes, and it has flat gray gaps. Make the clean photo that the camera in ${preview} would take.`,
      `Match ${preview} for the camera position, height and tilt, the perspective, the horizon, the framing, and the size and placement of everything in the frame. Take all appearance from ${original}: the same people with the same faces, identity, hair, clothing and pose, and the same objects, materials, colors, light and photo quality.`,
      `${moveSentence(f)} ${effects} ${light}${widen}`,
      `${preview}'s stretching, blur, broken edges, washed-out silhouettes and gray gaps are not content: replace them with what would really be there, consistent with ${original}. Hidden sides of people and things match their visible sides, and the place carries on naturally.`,
      `The result must show ${preview}'s viewpoint, not ${original}'s: an unmistakable camera move, never a mirrored or flipped copy of ${original}. One clean, sharp picture in ${original}'s style and quality, with no text, borders or watermarks.`,
    ].join("\n\n");
  }

  return [
    "Re-shoot this exact photo from a new camera position. Only the camera moves; nothing in the scene changes.",
    `${moveSentence(f)} ${effects} Fill newly revealed areas consistently with the scene.${widen}`,
    `Keep the same people with the same identity, faces, hair, pose, expression and clothing, and the same objects, materials, colors and place. ${light} Same lens look and photo quality.`,
    "The viewpoint change must be unmistakable: never return the original angle, never mirror or flip the picture, and never turn the people instead of moving the camera. No text, borders or watermarks.",
  ].join("\n\n");
}
