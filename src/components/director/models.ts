/**
 * The models the Director builds and extends places with (and reads the cast with): open image models that draw a
 * whole new picture from the pieces you give them, on your own GPU. Editors that change a picture as little as they can
 * (Qwen-Image-Edit 2511) came back with the set's stand-ins as wooden dolls and its places copied, so they aren't
 * offered here. FLUX.2 klein 4B is the one for small cards.
 */
export const DIRECTOR_MODELS = ["local:tpl:qwen-image-2.1", "local:flux3-klein", "local:tpl:flux2-klein-9b-edit", "local:flux2-klein-4b"];

/**
 * The models the Director shoots with, each drawing the set's depth through a ControlNet (server/director-fresh
 * `runDirectorControl`): the user's pick over the reference-picture shots (Oct 2026), a real film still, not a flat one.
 * Z-Image Director is the most cinematic and fastest; Qwen Director also takes each person's picture and keeps who they
 * are (Qwen Research License: non-commercial).
 */
export const SHOT_MODELS = ["local:z-image-director", "local:qwen-director"];
