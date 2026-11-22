/**
 * The oldest ComfyUI that runs every model Crackio offers: MOSS-Image's text encoder came in 0.42.0, FLUX 3 Klein's
 * ("flux3" in CLIPLoader) in 0.41.0, Qwen-Image 2.1's ("Text Encode Qwen Image 2.1") in 0.37.0. A rented box's template
 * can ship an older one (RunPod's ComfyUI 0.35.0 template did: FLUX 3 Klein failed there with "type: 'flux3' not in
 * list"), so Crackio updates it when it connects. Raise it when a model needs a newer ComfyUI.
 */
export const COMFY_FLOOR = "0.42.0";

/** Whether a ComfyUI version ("0.35.0", "v0.44.0") is older than the floor (or another version). Unknown isn't. */
export function comfyOlder(version: string | null | undefined, than: string = COMFY_FLOOR): boolean {
  if (!version) return false;
  return version.trim().replace(/^v/i, "").localeCompare(than, undefined, { numeric: true }) < 0;
}
