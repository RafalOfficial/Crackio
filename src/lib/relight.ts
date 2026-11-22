import { MOODS, kelvinPhrase } from "@/lib/director/vocab";

/**
 * Relight's light, in numbers and in words. The Relight page and the agent door (lib/agent) build the same prompt from
 * it, so a relight asked for by an agent is the one the page would have made. Client-safe.
 */
export type Light = { azimuth: number; elevation: number; softness: number; kelvin: number; mood: string | null; background: boolean };

/** Light direction relative to the viewer (camera at 0°), in words. */
export function describeLight(l: Light) {
  const az = ((((l.azimuth + 180) % 360) + 360) % 360) - 180;
  const side = az > 0 ? "the right" : "the left";
  const a = Math.abs(az);
  let dir: string;
  if (l.elevation >= 72) dir = "a hard top light from directly above";
  else if (l.elevation <= -10) dir = "an eerie light from below the subject";
  else if (a < 22) dir = "a frontal key light from the camera's direction";
  else if (a < 67) dir = `a key light from ${side} at about 45 degrees${l.elevation > 38 ? ", high enough to leave a small triangle of light on the shadow-side cheek" : ""}`;
  else if (a < 112) dir = `a side light from ${side}, leaving the other side in shadow`;
  else if (a < 157) dir = `a rim light from behind on ${side}, outlining the subject's edges`;
  else dir = "a strong backlight from directly behind the subject";
  const quality = l.softness < 0.25 ? "hard light with crisp, defined shadows" : l.softness < 0.6 ? "medium-soft light" : "very soft, diffused light with gentle shadows";
  const mood = MOODS.find((m) => m.id === l.mood);
  return `${dir}; ${quality}; ${kelvinPhrase(l.kelvin)}${mood ? `; ${mood.phrase}` : ""}`;
}

/** The edit a relight asks an image model for: only the light changes. */
export const relightPrompt = (light: Light) =>
  `Relight image 1 with ${describeLight(light)}. Keep the subject, pose, expression, composition, framing, colors of objects and every detail identical; change only the lighting: light direction, shadows, highlights, contrast and color temperature${
    light.background ? ", including how the background is lit" : ", leaving the background lighting as it is"
  }. Make the new light physically consistent across skin, fabric and surfaces. Photorealistic, no text or watermarks.`;
