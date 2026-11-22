/**
 * The models the Director builds and extends places with (and reads the cast with): open image models that draw a
 * whole new picture from the pieces you give them, on your own GPU. Editors that change a picture as little as they can
 * (Qwen-Image-Edit 2511) came back with the set's stand-ins as wooden dolls and its places copied, so they aren't
 * offered here. FLUX.2 klein 4B is the one for small cards. FLUX.2 klein 360 and Qwen-Image 2.1 360 (the challenge
 * winner's) are trained for the place all around (server/world `erpWorld`: one whole 2:1 panorama) and draw the rest
 * with their base models.
 */
export const DIRECTOR_MODELS = ["local:tpl:qwen-image-2.1", "local:flux3-klein", "local:tpl:flux2-klein-9b-edit", "local:flux2-klein-4b", "local:flux2-klein-base-4b-360", "local:qwen-image-2.1-360"];

/**
 * The models the Director shoots with by default, the challenge winner's way (nomadoor's Panorama Stickers): the camera
 * view itself (the place's and the cast's own pixels, anything no picture shows in flat gray) edited by an image model
 * told to blend the cast in and fill the gray (server/director-real). The place keeps its look, its style and its
 * detail; the ControlNet redraws below lost them (an astronaut on a beach, tested Nov 2026). Qwen-Image 2.1 is the
 * winner's own model; FLUX.2 klein 4B is the one for small cards.
 */
export const KEEP_MODELS = ["local:tpl:qwen-image-2.1", "local:flux2-klein-4b"];

/**
 * The models that redraw the whole shot through a ControlNet on the set's depth (server/director-fresh
 * `runDirectorControl`): a cinematic film still, but not the place's own look. Z-Image Director is the fastest; Qwen
 * Director also takes each person's picture and keeps who they are (Qwen Research License: non-commercial).
 */
export const REDRAW_MODELS = ["local:z-image-director", "local:qwen-director"];

/** Every model on your own GPUs a shot can be made with, the ones that keep the place first. */
export const SHOT_MODELS = [...KEEP_MODELS, ...REDRAW_MODELS];

/**
 * Hosted models on your Comfy key that edit a picture well, for a Director with no GPU of its own: a shot edits the
 * camera view with them as with Qwen-Image 2.1 (server/director-real), and a Camera moved off the photo's spot sends
 * the photo along, as Angles does. Only ever picked by you: every shot costs Comfy credits.
 */
export const CLOUD_MODELS = ["comfy:vertexai/gemini-nano-banana-2.1", "comfy:bfl/flux-3-image", "comfy:openai/gpt-image-2.5-flare"];

/** What the shot model picker offers: your GPUs' models, then the Comfy key's. */
export const SHOT_CHOICES = [...SHOT_MODELS, ...CLOUD_MODELS];
/** What the place model picker offers: your GPUs' models, then the Comfy key's. */
export const PLACE_CHOICES = [...DIRECTOR_MODELS, ...CLOUD_MODELS];

/**
 * The model a shot is made with: the one picked, else the first one ready on your GPUs (keeping the place first). With
 * none ready and none picked, "auto" once the model list is in: Shoot then opens the picker (a hosted model is never
 * picked for you).
 */
export function shotModelOf(chosen: string, models: { id: string; available?: boolean }[]) {
  if (SHOT_CHOICES.includes(chosen)) return chosen;
  return SHOT_MODELS.find((id) => models.find((m) => m.id === id)?.available) ?? (models.length ? "auto" : SHOT_MODELS[0]);
}

/** How the server makes a shot with this model (server/runner): "real" edits the camera view, "control" redraws it. */
export const shotCast = (model: string) => (REDRAW_MODELS.includes(model) ? "control" : "real");
