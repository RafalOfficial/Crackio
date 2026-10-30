/**
 * Visual vocabulary. Every option has the film-set term (shown so people learn it),
 * a plain-language explanation, and the exact phrase Crackio puts in the prompt.
 */

export type Option<T extends string = string> = {
  id: T;
  term: string;
  plain: string;
  phrase: string;
};

export const ANGLES = [
  { id: "worms-eye", term: "Worm's-eye", plain: "Camera on the ground, looking straight up", phrase: "worm's-eye view from ground level looking steeply up", elevation: -55 },
  { id: "low", term: "Low angle", plain: "Below the subject, looking up — feels powerful", phrase: "low-angle shot looking up at the subject", elevation: -20 },
  { id: "eye", term: "Eye level", plain: "Straight on, like meeting someone", phrase: "eye-level shot", elevation: 0 },
  { id: "high", term: "High angle", plain: "Above the subject, looking down", phrase: "high-angle shot looking down at the subject", elevation: 25 },
  { id: "birds-eye", term: "Bird's-eye", plain: "High above, seeing the layout", phrase: "bird's-eye view from high above", elevation: 55 },
  { id: "overhead", term: "Top-down", plain: "Directly overhead, flat-lay style", phrase: "top-down overhead shot looking straight down", elevation: 86 },
] as const;

/**
 * Share of a person's height in frame, measured from the top of the head (`body`), or of an
 * object's height (`object`). `crop` and `objectCrop` say exactly what the frame shows.
 */
export const SHOT_SIZES = [
  { id: "ecu", term: "Extreme close-up", plain: "Just the eyes or one detail", phrase: "extreme close-up", body: 0.085, object: 0.3, crop: "framed tightly on the face so the eyes fill the frame, forehead and chin cropped", objectCrop: "so close that one detail fills the frame" },
  { id: "cu", term: "Close-up", plain: "Face and a bit of shoulders", phrase: "close-up", body: 0.2, object: 0.85, crop: "framed from the shoulders up, the face filling most of the frame", objectCrop: "filling most of the frame" },
  { id: "mcu", term: "Medium close-up", plain: "From the chest up", phrase: "medium close-up", body: 0.3, object: 1.2, crop: "framed from mid-chest up", objectCrop: "large in the frame with a little space around it" },
  { id: "ms", term: "Medium shot", plain: "From the waist up", phrase: "medium shot", body: 0.46, object: 1.7, crop: "framed from the waist up", objectCrop: "with some space around it" },
  { id: "cowboy", term: "Cowboy shot", plain: "From mid-thigh up", phrase: "medium-long cowboy shot", body: 0.68, object: 2.3, crop: "framed from mid-thigh up", objectCrop: "with generous space around it" },
  { id: "full", term: "Full shot", plain: "Head to toe, with a little room", phrase: "full-body shot", body: 1.12, object: 3, crop: "the whole body visible from head to toe with a little space above the head and below the feet", objectCrop: "fully visible with its surroundings" },
  { id: "wide", term: "Wide shot", plain: "The subject small in their surroundings", phrase: "wide shot", body: 2.6, object: 6, crop: "the whole body small in the frame, the surroundings taking up most of the picture", objectCrop: "small within its surroundings" },
  { id: "ews", term: "Extreme wide", plain: "Tiny figure, huge landscape", phrase: "extreme wide establishing shot", body: 8, object: 18, crop: "a tiny figure in a vast environment", objectCrop: "tiny within a vast space" },
] as const;

export const LENSES = [
  { id: "14", focal: 14, term: "14mm ultra-wide", plain: "Huge field of view, stretched edges, dramatic", phrase: "shot on a 14mm ultra-wide lens: exaggerated perspective, near things loom large, edges stretch, the background recedes far away" },
  { id: "24", focal: 24, term: "24mm wide", plain: "Lots of background, slight stretch", phrase: "shot on a 24mm wide-angle lens with deep, open perspective and lots of background" },
  { id: "35", focal: 35, term: "35mm", plain: "Natural, documentary feel", phrase: "shot on a 35mm lens with natural, documentary perspective" },
  { id: "50", focal: 50, term: "50mm", plain: "Close to how your eyes see", phrase: "shot on a 50mm standard lens with true-to-life proportions" },
  { id: "85", focal: 85, term: "85mm portrait", plain: "Flattering faces, soft background", phrase: "shot on an 85mm portrait lens: flattering compressed perspective, the background pulled closer behind the subject" },
  { id: "135", focal: 135, term: "135mm telephoto", plain: "Background pulled close, very compressed", phrase: "shot on a 135mm telephoto lens: strongly compressed perspective, the background looks big and close behind the subject" },
] as const;

export const APERTURES = [
  { id: "1.4", f: 1.4, term: "f/1.4", plain: "Background melts into blur", phrase: "very shallow depth of field, background dissolved into creamy bokeh" },
  { id: "2.8", f: 2.8, term: "f/2.8", plain: "Subject sharp, background soft", phrase: "shallow depth of field with a softly blurred background" },
  { id: "5.6", f: 5.6, term: "f/5.6", plain: "Most things reasonably sharp", phrase: "moderate depth of field" },
  { id: "11", f: 11, term: "f/11", plain: "Everything sharp, front to back", phrase: "deep focus, everything sharp from foreground to background" },
] as const;

/** Key-light placements, relative to where the camera is when you pick them. */
export const LIGHT_SETUPS = [
  { id: "front", term: "Front light", plain: "Even and flat, few shadows", phrase: "soft frontal key light", offset: 0, elevation: 20 },
  { id: "loop", term: "45° key", plain: "Classic portrait light from one side", phrase: "classic 45-degree key light", offset: 40, elevation: 35 },
  { id: "rembrandt", term: "Rembrandt", plain: "A small triangle of light on the shadow cheek", phrase: "Rembrandt lighting with a small triangle of light on the shadow-side cheek", offset: 55, elevation: 45 },
  { id: "split", term: "Split light", plain: "Half the face lit, half in shadow", phrase: "split lighting with half the face in deep shadow", offset: 90, elevation: 8 },
  { id: "rim", term: "Rim light", plain: "Light from behind outlines the edges", phrase: "rim light from behind outlining the subject's edges", offset: 145, elevation: 25 },
  { id: "silhouette", term: "Backlight", plain: "Bright behind the subject, almost a silhouette", phrase: "strong backlight turning the subject into a near silhouette", offset: 180, elevation: 8 },
  { id: "top", term: "Top light", plain: "Straight down from above, moody", phrase: "hard top light from directly above with deep eye shadows", offset: 0, elevation: 82 },
] as const;

export const MOODS = [
  { id: "golden", term: "Golden hour", plain: "Low warm sun, long shadows", phrase: "golden hour sunlight with long warm shadows", kelvin: 3300, softness: 0.4, elevation: 7 },
  { id: "midday", term: "Midday sun", plain: "Hard light, short shadows", phrase: "harsh midday sun with short hard shadows", kelvin: 5600, softness: 0.05, elevation: 75 },
  { id: "overcast", term: "Overcast", plain: "Soft, even, no hard shadows", phrase: "soft overcast daylight with no hard shadows", kelvin: 6500, softness: 0.95, elevation: 60 },
  { id: "blue-hour", term: "Blue hour", plain: "Just after sunset, cool and calm", phrase: "blue hour twilight with cool ambient light", kelvin: 9000, softness: 0.75, elevation: 2 },
  { id: "night-neon", term: "Night neon", plain: "Colored signs, wet reflections", phrase: "night scene lit by magenta and cyan neon signs, wet reflective surfaces", kelvin: 4200, softness: 0.5, elevation: 15 },
  { id: "studio", term: "Studio softbox", plain: "Clean, controlled, flattering", phrase: "clean studio lighting from a large softbox", kelvin: 5600, softness: 0.85, elevation: 30 },
  { id: "candle", term: "Candlelight", plain: "Warm flicker, deep shadows", phrase: "warm candlelight with deep surrounding shadows", kelvin: 1900, softness: 0.55, elevation: 5 },
  { id: "moonlight", term: "Moonlight", plain: "Cold and blue, quiet", phrase: "cold moonlight with deep blue shadows", kelvin: 7800, softness: 0.6, elevation: 35 },
] as const;

export const STYLES = [
  { id: "photo", term: "Photo", plain: "Looks like a real photograph", phrase: "Photorealistic photograph with natural textures" },
  { id: "cinematic", term: "Film still", plain: "Color-graded, like a frame from a movie", phrase: "Cinematic film still, anamorphic look, subtle film grain, rich color grade" },
  { id: "editorial", term: "Editorial", plain: "Fashion-magazine polish", phrase: "High-end fashion editorial photograph" },
  { id: "documentary", term: "Candid", plain: "Unposed, real moment", phrase: "Candid documentary photograph, natural and unposed" },
  { id: "product", term: "Commercial", plain: "Crisp advertising look", phrase: "Commercial advertising photograph with crisp detail" },
  { id: "analog", term: "35mm film", plain: "Warm, grainy, nostalgic", phrase: "Analog 35mm film photograph with warm muted tones and visible grain" },
  { id: "anime", term: "Anime", plain: "Clean lines, cel shading", phrase: "Anime illustration with clean line art and cel shading" },
  { id: "3d", term: "3D render", plain: "Stylized, soft lighting", phrase: "Stylized 3D render with soft global illumination" },
  { id: "painting", term: "Painting", plain: "Painterly brushwork", phrase: "Painterly digital illustration with visible brushwork" },
] as const;

/** Typical height, how the prompt names it, and front-to-back depth as a share of the height. */
export const ELEMENT_DEFAULTS = {
  person: { height: 1.72, noun: "person", depth: 0.17 },
  animal: { height: 0.62, noun: "animal", depth: 0.45 },
  object: { height: 0.5, noun: "object", depth: 0.5 },
  product: { height: 0.3, noun: "product", depth: 0.45 },
  vehicle: { height: 1.45, noun: "vehicle", depth: 0.8 },
} as const;

export function kelvinPhrase(k: number) {
  if (k < 2300) return "very warm candle-like color";
  if (k < 3000) return "warm household-lamp color";
  if (k < 3800) return "warm tungsten color (around 3200K)";
  if (k < 4800) return "neutral-warm color";
  if (k < 6000) return "neutral daylight color (around 5600K)";
  if (k < 7500) return "slightly cool overcast color";
  return "cool blue color";
}

export function kelvinToRgb(kelvin: number): [number, number, number] {
  // Tanner Helland's approximation, good enough for a preview.
  const t = kelvin / 100;
  const r = t <= 66 ? 255 : 329.7 * Math.pow(t - 60, -0.1332);
  const g = t <= 66 ? 99.47 * Math.log(t) - 161.12 : 288.12 * Math.pow(t - 60, -0.0755);
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.52 * Math.log(t - 10) - 305.04;
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return [c(r), c(g), c(b)];
}
