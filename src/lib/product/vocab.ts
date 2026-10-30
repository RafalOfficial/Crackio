/**
 * Product Studio's vocabulary. Every pick is a suggestion to the art director, never a fixed
 * phrase pasted into the prompt: "Beach" means a sports drink opened and sipped on a towel,
 * longevity capsules on a shaded beach-bar table beside a glass of water, or a tee worn on the
 * boardwalk. The director reads the product first (lib/server/product) and fits each pick to it.
 *
 * `brief` is what the director is told the person wants; `phrase` is the plain wording used only
 * when no text model is reachable and the prompt has to be put together without one.
 * Previews: public/assets/product/<axis>-<id>-<sample>.webp (scripts/assets/product-previews.mjs).
 */

export type StudioOption<T extends string = string> = {
  id: T;
  label: string;
  /** One plain line under the preview: what you'll get. */
  caption: string;
  brief: string;
  phrase: string;
};

const opt = <T extends string>(o: StudioOption<T>) => o;

export const MOMENTS = [
  opt({
    id: "auto",
    label: "Best fit",
    caption: "Crackio picks the moment that sells this product best.",
    brief: "Choose the moment that sells this product best in this setting. On a studio set (white studio, color backdrop, podium, dark luxe) that's usually the product on its own, or held in a hand: a clean hero shot, not a person posing. In a real place, someone using it when it's something people drink, wear or use actively, and the product styled on its own when it's a packaged good that shines when styled. When writing several shots, mix them.",
    phrase: "",
  }),
  opt({
    id: "still",
    label: "On its own",
    caption: "Just the product, styled where it would really sit.",
    brief: "A still life: the product alone, resting the way it naturally rests (standing, folded, hung, on a stand), nobody in frame. One to three props that say what it's for. Closed or sealed unless it looks better open.",
    phrase: "styled as a still life, resting naturally on a surface with one or two fitting props, nobody in frame",
  }),
  opt({
    id: "hand",
    label: "In hand",
    caption: "Held in a hand, so its size reads at a glance.",
    brief: "One hand (wrist and a little forearm) holds the product toward the camera with the grip it's really held with, label facing us; the setting softly out of focus behind. Natural nails, real skin texture, a relaxed grip.",
    phrase: "held naturally in one hand toward the camera, label facing us, the background softly out of focus",
  }),
  opt({
    id: "use",
    label: "In use",
    caption: "Someone using it right now: sipping, wearing, applying.",
    brief: "One person uses the product exactly as it's meant to be used, caught at the most telling instant: a drink opened and just lowered from the lips, a capsule about to be taken with a glass of water, clothing worn and moving, skincare being applied, headphones on. The product stays clearly visible and recognizable.",
    phrase: "being used by a person exactly as it is meant to be used, caught mid-action",
  }),
  opt({
    id: "together",
    label: "Together",
    caption: "Friends sharing it, or several lined up.",
    brief: "Two to four people enjoying the product together in a natural moment: each with their own when people really would each have one (a drink, a shirt), sharing one when they really would share it (a jar of supplements, a bag of coffee, a candle). Where people don't fit, several identical units arranged as a confident group. Every unit identical to the reference: never invent colors, flavors or variants.",
    phrase: "enjoyed by a small group of friends together, each with their own",
  }),
  opt({
    id: "creator",
    label: "Creator",
    caption: "A creator showing it to their phone, UGC style.",
    brief: "User-generated content: a real-looking creator films or snaps themselves with the product on their phone: holding it up beside their face toward the front camera, mid-sentence, or using it casually. A lived-in home, car, gym or street; natural mixed light; shot on a phone (slight wide angle, everyday sharpness, no studio polish). Warm, unposed, the label readable.",
    phrase: "in a casual creator-style phone selfie, the creator holding it up beside their face toward the camera, real home setting",
  }),
  opt({
    id: "ingredients",
    label: "Ingredients",
    caption: "Surrounded by what it's made of.",
    brief: "The product as the hero, close up, surrounded by a generous but tidy arrangement of what's in it or what it's made of: real ingredients and flavor cues only where its label or category supports them (halved citrus and ice for a citrus drink, botanicals for skincare); for things without natural ingredients, what's inside or the raw material (capsules and a little of their powder, raw cotton and folded fabric, leather and laces). Fresh and real; some pieces suspended in mid-air for energy.",
    phrase: "surrounded by a few of its real ingredients and materials, fresh and arranged with intention",
  }),
  opt({
    id: "motion",
    label: "In motion",
    caption: "Frozen action: a splash, a pour, a toss.",
    brief: "A dramatic frozen high-speed action shot about the product itself: what's in it or what it's made of in motion. Liquid bursting from the open bottle or crowning around it as it lands in water, capsules tumbling out of the tipped jar, a cloud of powder, the shirt snapping mid-toss or flowing on someone mid-spin, a sneaker landing in a burst of dust. The action is big and obvious, physically plausible, crisp as if lit by strobes at 1/8000 s; the product sharp and its label readable.",
    phrase: "caught in a frozen high-speed moment with a splash or burst around it, crisp strobe-lit freeze",
  }),
] as const;

export const SCENES = [
  opt({ id: "auto", label: "Best fit", caption: "Crackio picks where this product's buyers want to see it.", brief: "Pick the setting where this product's buyers would most want to see it.", phrase: "" }),
  opt({ id: "white", label: "White studio", caption: "Seamless white, clean like a store listing.", brief: "A seamless pure white studio sweep, e-commerce clean, with a soft natural floor shadow. Nothing else unless the moment needs it.", phrase: "on a seamless pure white studio background with a soft floor shadow" }),
  opt({ id: "color", label: "Color pop", caption: "One bold color pulled from your product.", brief: "A seamless backdrop and floor in one bold, flat color drawn from the product's own palette (or its strongest complement): a crisp modern ad.", phrase: "against a seamless backdrop in one bold color drawn from the product's palette" }),
  opt({ id: "podium", label: "Podium", caption: "Sculptural plinths, presented like a trophy.", brief: "A calm studio set of sculptural plinths and simple shapes in stone, plaster or acrylic, the product presented on top.", phrase: "presented on a sculptural stone plinth among simple geometric shapes in a calm studio" }),
  opt({ id: "luxe", label: "Dark luxe", caption: "Black stone, velvet and pools of light.", brief: "A dark, rich set: black marble, smoked glass, velvet or polished walnut, pools of warm light. Premium and quiet.", phrase: "on dark polished black marble in a rich, quiet luxury set with pools of warm light" }),
  opt({ id: "kitchen", label: "Kitchen", caption: "A bright real kitchen, breakfast time.", brief: "A bright, real kitchen: stone counter, wooden board, a bowl of fruit, morning window light. Breakfast-time energy.", phrase: "on a stone counter in a bright, real kitchen in the morning" }),
  opt({ id: "bathroom", label: "Bathroom", caption: "A calm vanity with stone and daylight.", brief: "A calm bathroom: stone or tile vanity, a mirror, folded towels, a plant, soft daylight.", phrase: "on a stone bathroom vanity beside folded towels and a plant in soft daylight" }),
  opt({ id: "living", label: "Living room", caption: "A warm, lived-in home in the afternoon.", brief: "A warm lived-in living room: sofa, coffee table, books, plants, afternoon light.", phrase: "in a warm lived-in living room with a sofa, books and plants in afternoon light" }),
  opt({ id: "desk", label: "Desk", caption: "A tidy desk on a focused weekday.", brief: "A tidy work desk: laptop, notebook, a cup of coffee, daylight from a window. A focused weekday.", phrase: "on a tidy work desk beside a laptop and a notebook in window light" }),
  opt({ id: "cafe", label: "Café", caption: "A window table at a neighborhood café.", brief: "A neighborhood café: marble or wood table, coffee cups, a window seat, street life soft outside.", phrase: "on a marble table by the window of a neighborhood café" }),
  opt({ id: "gym", label: "Gym", caption: "Racks, benches and real effort.", brief: "A modern gym: racks, benches, dumbbells, rubber floor, big windows. Effort and focus.", phrase: "in a modern gym with racks and benches" }),
  opt({ id: "street", label: "City street", caption: "Sidewalks and storefronts by day.", brief: "A daytime city street: sidewalks, storefronts, crosswalks, passers-by soft in the distance.", phrase: "on a daytime city street with storefronts softly blurred behind" }),
  opt({ id: "night", label: "Night city", caption: "Wet streets, neon signs, city glow.", brief: "A city at night: wet reflective pavement, neon signs, city bokeh.", phrase: "in a city at night with wet reflective pavement and neon signs" }),
  opt({ id: "beach", label: "Beach", caption: "Sand, sea, towels and a beach bar.", brief: "A sunny beach: sand, sea, towels and loungers, a beach bar, a boardwalk.", phrase: "at a sunny beach" }),
  opt({ id: "pool", label: "Poolside", caption: "Turquoise water and palm shadows.", brief: "A sunny pool deck: turquoise water, loungers, pale tiles, palm shadows.", phrase: "on a sunny pool deck with turquoise water and palm shadows" }),
  opt({ id: "park", label: "Park", caption: "A lawn, a blanket and dappled sun.", brief: "A green park on a sunny day: lawn, a picnic blanket, trees, dappled light.", phrase: "in a sunny green park with a picnic blanket and dappled light" }),
  opt({ id: "forest", label: "Forest", caption: "Moss, ferns and morning light beams.", brief: "A forest: moss, rocks, ferns, morning mist and beams of light.", phrase: "in a misty forest with moss, ferns and beams of morning light" }),
  opt({ id: "mountains", label: "Mountains", caption: "A trail, big views, crisp air.", brief: "Mountains: a trail, rocks, a big view, crisp air; maybe a tent, a backpack or a car.", phrase: "on a mountain trail with a big view behind" }),
  opt({ id: "snow", label: "Snow", caption: "Fresh snow, cold light, warm accents.", brief: "Winter: fresh snow, a wooden cabin or ski slope, cold blue light with warm accents.", phrase: "in a fresh snowy winter scene by a wooden cabin" }),
  opt({ id: "desert", label: "Desert", caption: "Dunes, red rock and long shadows.", brief: "A desert: sand dunes or red rock, long shadows, warm dry light.", phrase: "in a desert of red rock and sand dunes with long shadows" }),
] as const;

export const CAMERAS = [
  opt({ id: "auto", label: "Best fit", caption: "Crackio picks the angle that flatters it.", brief: "Pick the camera that flatters this product and suits the moment.", phrase: "" }),
  opt({ id: "eye", label: "Eye level", caption: "Straight on and honest.", brief: "Camera at the product's own height (chest height for people), lens level, straight on: its top is seen edge-on, the horizon or backdrop line sits behind its middle. A 70–85 mm look, honest and clean.", phrase: "Shot straight on at eye level with a 70 mm lens" }),
  opt({ id: "three", label: "3/4 hero", caption: "Front and one side, slightly above.", brief: "Camera about 25° above and turned about 35° to one side: the front and one side are both visible, with a little of the top. The classic hero angle.", phrase: "Shot at a three-quarter hero angle from slightly above" }),
  opt({ id: "low", label: "Low hero", caption: "From below: it towers.", brief: "Camera down at or below the surface the product stands on, tilted up: the product looms over the viewer, its base large and its top narrower (gentle converging lines), the underside of a cap or rim just visible, and the background mostly sky, ceiling or backdrop high above. A 24–35 mm look.", phrase: "Shot from a low angle looking up, so it towers" }),
  opt({ id: "high", label: "High angle", caption: "Looking down at about 45°.", brief: "Camera high above, looking down at 45–60°: we clearly see the top of the product (a cap or lid reads as an ellipse) and the surface it stands on fills most of the frame behind it; no horizon or wall line. The product looks smaller, settled, part of its surroundings.", phrase: "Shot from above, looking down at about 45 degrees" }),
  opt({ id: "top", label: "Top-down", caption: "Straight down: a flat lay.", brief: "Camera directly overhead pointing straight down at 90°: no horizon and no walls, only the surface; everything is seen from above and laid out as a flat lay (a bottle lies on its side or shows its cap as a circle).", phrase: "Shot from directly overhead as a flat lay" }),
  opt({ id: "close", label: "Close-up", caption: "One detail fills the frame.", brief: "Camera very close: one part of the product fills the frame edge to edge (the cap and the top of the label, the stitched logo, the texture of a capsule, beads of condensation) and the rest of it runs out of the frame. Very shallow focus, a 100 mm macro look; the label words that are in frame stay sharp and exact.", phrase: "Shot as a close-up on its most distinctive detail with shallow focus" }),
  opt({ id: "wide", label: "Wide", caption: "Small in a big, beautiful place.", brief: "Camera far back with a 24–35 mm look: the product (or the person using it) fills about a fifth of the frame, the place fills the rest, and the product is still clearly the point.", phrase: "Shot wide, small within a big environment yet clearly the subject" }),
] as const;

export const LIGHTS = [
  opt({ id: "auto", label: "Best fit", caption: "Crackio picks the light the scene calls for.", brief: "Pick the light that fits the setting and makes the product look its best.", phrase: "" }),
  opt({ id: "soft", label: "Soft studio", caption: "Big soft sources, gentle shadows.", brief: "Large soft light sources: gentle shadows, clean even highlights on the product.", phrase: "Soft, even studio light from large softboxes" }),
  opt({ id: "window", label: "Window light", caption: "Soft daylight from one side.", brief: "Soft directional daylight from a big window, natural falloff, calm and real.", phrase: "Soft directional daylight from a large window" }),
  opt({ id: "golden", label: "Golden hour", caption: "Low warm sun, long shadows.", brief: "Low warm sun: long soft shadows, a glowing rim on the edges.", phrase: "Warm low golden-hour sun with long soft shadows" }),
  opt({ id: "sun", label: "Hard sun", caption: "Crisp graphic shadows, punchy color.", brief: "Bright direct midday sun: crisp graphic shadows, punchy color.", phrase: "Bright direct sun with crisp graphic shadows" }),
  opt({ id: "overcast", label: "Overcast", caption: "Soft, even, true colors.", brief: "Bright overcast daylight: soft, even, no harsh shadows, true colors.", phrase: "Soft, bright overcast daylight" }),
  opt({ id: "moody", label: "Moody", caption: "One hard light, deep shadows, a rim.", brief: "Dark and dramatic: one hard key light, deep shadows, a bright rim tracing the product's edges.", phrase: "Dark moody light with deep shadows and a bright rim along its edges" }),
  opt({ id: "neon", label: "Neon", caption: "Colored signs and glossy reflections.", brief: "Night light from colored neon and city signs, reflections on glossy surfaces.", phrase: "Colored neon night light with glossy reflections" }),
] as const;

export const FINISHES = [
  opt({ id: "auto", label: "Best fit", caption: "Crackio picks the look this moment calls for.", brief: "Pick the finish this product and moment call for.", phrase: "" }),
  opt({ id: "commercial", label: "Commercial", caption: "Polished ad: crisp, clean, flawless.", brief: "A polished advertising photograph: bright and high-key, everything crisp, clean saturated true color, the product perfectly lit with clean highlights, a tidy, centered composition. Flawless but real.", phrase: "Polished commercial advertising photograph, crisp detail, clean accurate color" }),
  opt({ id: "editorial", label: "Editorial", caption: "Magazine styling and refined color.", brief: "A magazine editorial: a bold, deliberate composition (the subject off-center, strong lines or a lot of air), styled wardrobe and set, a muted, refined palette, directional light with deeper shadows. Art-directed, not catalog.", phrase: "High-end magazine editorial photograph with refined color" }),
  opt({ id: "natural", label: "Natural", caption: "A real moment, lightly retouched.", brief: "A true-to-life moment: available light only, unposed, slightly imperfect framing, real textures and everyday details left in, natural muted color, no retouched gloss. It looks like a real moment someone caught.", phrase: "True-to-life photograph with natural color and real textures" }),
  opt({ id: "phone", label: "Phone photo", caption: "Shot on a phone, posted by a person.", brief: "Shot on a phone by a real person: a wide 26 mm phone-lens look, deep focus with the background sharp (no creamy blur), phone HDR with bright skies and lifted shadows, casual off-center framing, ordinary clutter left in. It looks posted, not produced.", phrase: "Casual photo shot on a smartphone, everyday sharpness and natural phone color" }),
  opt({ id: "film", label: "35mm film", caption: "Soft grain and warm nostalgic color.", brief: "Analog 35mm film (like Kodak Portra 400): visible fine grain, soft contrast with slightly faded blacks, warm skin and creamy highlights, a little halation around bright edges. Nostalgic and tactile.", phrase: "Shot on 35mm film with soft grain and warm color" }),
  opt({ id: "cinematic", label: "Cinematic", caption: "A film still with a deliberate grade.", brief: "A film still: a wide, letterbox-like composition, low-key light with deep contrast, a teal-and-amber grade, shallow depth of field, soft bloom on highlights, atmosphere in the air. A moment from a movie.", phrase: "Cinematic film still with rich contrast and a deliberate grade" }),
  opt({ id: "minimal", label: "Minimal", caption: "Calm, few elements, lots of space.", brief: "Minimal and calm: the subject small to medium in a vast, clean field of negative space (at least half the frame empty), one or two elements at most, a soft tonal palette of two or three colors.", phrase: "Minimal composition with generous negative space and a soft tonal palette" }),
] as const;

export const WHO = [
  opt({ id: "auto", label: "Best fit", caption: "Whoever this product is for.", brief: "Cast whoever this product is really for (age, style and number from the brief).", phrase: "" }),
  opt({ id: "woman", label: "Woman", caption: "A woman (or women, for Together).", brief: "A woman (women, when several people appear).", phrase: "a woman" }),
  opt({ id: "man", label: "Man", caption: "A man (or men, for Together).", brief: "A man (men, when several people appear).", phrase: "a man" }),
  opt({ id: "hands", label: "Hands only", caption: "No faces: just hands and arms.", brief: "No faces at all: only hands, arms or a cropped body appear.", phrase: "only their hands" }),
] as const;

/** Output shapes, named by where the picture goes. */
export const FORMATS = [
  { id: "4:5", label: "Feed", caption: "Instagram and Facebook feed posts." },
  { id: "1:1", label: "Square", caption: "Store listings, marketplaces and grids." },
  { id: "9:16", label: "Story", caption: "Stories, Reels and TikTok." },
  { id: "16:9", label: "Banner", caption: "Website headers, YouTube and ads." },
  { id: "3:2", label: "Web", caption: "Product pages, blogs and email." },
] as const;

export type MomentId = (typeof MOMENTS)[number]["id"];
export type SceneId = (typeof SCENES)[number]["id"];
export type CameraId = (typeof CAMERAS)[number]["id"];
export type LightId = (typeof LIGHTS)[number]["id"];
export type FinishId = (typeof FINISHES)[number]["id"];
export type WhoId = (typeof WHO)[number]["id"];
export type FormatId = (typeof FORMATS)[number]["id"];

/** Moments with people in them (Who applies). */
export const PEOPLE_MOMENTS: readonly MomentId[] = ["auto", "hand", "use", "together", "creator"];

/** What Crackio understood about the product from its photo (lib/server/product). */
export type ProductRead = {
  /** Short, specific noun phrase: "a 500 ml sports drink in a translucent blue bottle". */
  name: string;
  /** One or two words for the chip: "Sports drink", "Supplement", "T-shirt". */
  kind: string;
  category: string;
  brand: string;
  /** Every legible word on it, in reading order. */
  text: string;
  look: string;
  size: string;
  /** How it's used, eaten, drunk or worn, in one sentence. */
  use: string;
  /** Ways it can appear, most appealing first ("cap off, being sipped"). */
  states: string[];
  /** How a hand naturally holds it. */
  hands: string;
  /** Where it naturally rests. */
  rests: string;
  /** Placements and treatments that would look wrong. */
  never: string[];
  /** Settings it naturally belongs to. */
  settings: string[];
  props: string[];
  people: string;
  palette: string[];
};

/** A Product Studio take's settings, sent as `params.studio`. */
export type StudioSpec = {
  version: 2;
  moment: MomentId;
  scene: SceneId;
  camera: CameraId;
  light: LightId;
  finish: FinishId;
  /** A quick pick, someone from your Cast ("cast"), or someone you describe ("custom"). */
  who: WhoId | "cast" | "custom";
  /** The Cast character in the shot (their portrait and sheet follow the product photos as references). */
  cast?: { id: string; name: string; kind: "person" | "pet" | "character"; traits?: string };
  /** How the person you described looks. */
  whoText?: string;
  /** Keep a calm empty area for a headline. */
  copySpace: boolean;
  /** Words to set in that space (a headline), exactly as typed. */
  headline?: string;
  /** Whether the take's prompt holds the person's own notes (else it's the summary). */
  noted: boolean;
  /** What the person says the product is, when they corrected Crackio's reading. */
  identity?: string;
  /** Crackio's reading, when the page already has it (the server reads the photo otherwise). */
  read?: ProductRead | null;
  /** How many product photos lead the references (front first, then other angles). */
  productImages: number;
  /** Inspect every take against the product photo and re-shoot once when something's wrong. */
  check?: boolean;
};

/** What the quality check found on a take (and whether it was re-shot because of it). */
export type ShotCheck = { pass: boolean; issues: string[]; retried?: boolean };

/** One planned take: what the shopper sees ("idea") and what the image model is told. */
export type ShotPlan = { idea: string; prompt: string; check?: ShotCheck };

export const byId = <T extends { id: string }>(list: readonly T[], id: string): T => list.find((o) => o.id === id) ?? list[0];

/** The card summary for a take: "Sports drink · Beach · In use". */
export function studioSummary(spec: Pick<StudioSpec, "moment" | "scene">, kind?: string) {
  const parts = [kind || "Product"];
  if (spec.scene !== "auto") parts.push(byId(SCENES, spec.scene).label);
  if (spec.moment !== "auto") parts.push(byId(MOMENTS, spec.moment).label);
  return parts.join(" · ");
}
