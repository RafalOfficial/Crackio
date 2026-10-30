import type { Template, TemplateSlot } from "./types";

/**
 * The template library: clips Crackio made itself on open models (LTX-2.5, FLUX 3 Klein; see
 * scripts/assets/templates.json), with nobody's footage, likeness, music or brand in them, plus your own
 * clip. Every swap's `target` names exactly who is in its clip, so the prompt points at the right one.
 */

const A = "/assets/templates";
/** Crackio's own clip for a format (scripts/assets/templates.mjs). */
const media = (id: string) => ({ poster: `${A}/${id}.webp`, clip: `${A}/${id}.mp4` });
/** Crackio's own clip, its card playing a swap Crackio made on it (LTX-2.5 + Ripple): what you get. */
const swapped = (id: string) => ({ poster: `${A}/${id}.webp`, clip: `${A}/${id}-swap.mp4` });

/** Photo guidance per slot kind (what each model needs to keep a likeness). */
const HINT = {
  person: "Knee-up or full body, face clear, no sunglasses",
  friend: "One photo of them, face clear",
  face: "Head and shoulders, facing the camera",
  pet: "Whole body, side or three-quarter view",
  car: "The whole car, side or three-quarter view",
  object: "A clean photo, label facing the camera",
  place: "A wide photo of the place, no people",
} as const;

const you = (target: string, outfit?: TemplateSlot["outfit"]): TemplateSlot => ({ id: "you", kind: "person", label: "You", hint: HINT.person, target, ...(outfit ? { outfit } : {}) });
const friend = (target: string, outfit?: TemplateSlot["outfit"], label = "Your friend"): TemplateSlot => ({ id: "friend", kind: "person", label, hint: HINT.friend, target, ...(outfit ? { outfit } : {}) });

export const TEMPLATES: Template[] = [
  /* ------------------------------------------------------------------ bring your own clip */
  {
    id: "any-clip",
    title: "Put Yourself in Any Clip",
    kind: "swap",
    categories: ["memes", "dance"],
    line: "Drop a clip you made or may use, click who to replace, and star in it.",
    poster: "",
    clip: "",
    slots: [you("the main person")],
    keep: [],
    aspect: "9:16",
    trend: { heat: 3, note: "Your own clip: click who to replace and Crackio writes the swap for it.", since: "2026-10" },
  },

  /* ------------------------------------------------------------------ Crackio's own clips (made on open models, see scripts/assets/templates.json) */
  {
    id: "studio-dance",
    own: true,
    title: "Studio Dance",
    kind: "swap",
    categories: ["dance"],
    line: "A dancer in a bright colour-block studio: anyone from your Cast takes her moves.",
    ...swapped("studio-dance"),
    base: { url: `${A}/studio-dance.mp4`, seconds: 8, action: "she dances on the spot with big, happy arm swings and hip sways, smiling at the camera the whole time", audio: true },
    slots: [you("the woman in the yellow tracksuit dancing in the middle of the studio")],
    keep: ["the coral, teal and purple studio walls", "the white floor"],
    aspect: "9:16",
    trend: { heat: 3, note: "Crackio's own clip, made with LTX-2.5 on open models: nobody's likeness or footage, so it's yours to post.", since: "2026-10" },
  },
  {
    id: "city-walk",
    own: true,
    title: "City Walk",
    kind: "swap",
    categories: ["cinematic", "memes"],
    line: "A confident walk toward the camera down a sunny street: you, or just a new coat colour.",
    ...swapped("city-walk"),
    base: { url: `${A}/city-walk.mp4`, seconds: 8, action: "she walks straight toward the camera down the sunlit sidewalk with an easy, confident stride while the camera glides back ahead of her", audio: true },
    slots: [you("the red-haired woman in the beige trench coat walking toward the camera")],
    keep: ["the tree-lined street and its old buildings", "the sunlight"],
    aspect: "9:16",
    trend: { heat: 3, note: "Crackio's own clip, made with LTX-2.5 on open models: nobody's likeness or footage, so it's yours to post.", since: "2026-10" },
  },
  {
    id: "cafe-duo",
    own: true,
    title: "Café Duo",
    kind: "swap",
    categories: ["duo"],
    line: "Two friends laughing over coffee: put you and a friend at the table.",
    ...swapped("cafe-duo"),
    base: { url: `${A}/cafe-duo.mp4`, seconds: 6.25, action: "the two friends sit apart at a small round café table, laughing and chatting, then both lift their white cups and sip", others: "the café, its shelves and hanging lamps", audio: true },
    slots: [you("the dark-haired woman on the left in the green sweater and jeans"), friend("the blonde woman on the right in the white blouse and cream trousers")],
    keep: ["the café table and the coffee cups", "the shelves and hanging lamps"],
    aspect: "9:16",
    trend: { heat: 3, note: "Crackio's own clip, made with LTX-2.5 on open models: nobody's likeness or footage, so it's yours to post.", since: "2026-10" },
  },
  {
    id: "coastal-drive",
    own: true,
    title: "Coastal Drive",
    kind: "swap",
    categories: ["cinematic", "products"],
    line: "A red convertible on a cliffside coast road: your car takes the bend.",
    ...swapped("coastal-drive"),
    base: { url: `${A}/coastal-drive.mp4`, seconds: 6.7, action: "the convertible speeds along the coast road toward the camera, the sea and cliffs sliding past behind it", audio: true },
    slots: [{ id: "car", kind: "object", label: "Your car", hint: HINT.car, target: "the red convertible sports car driving toward the camera" }],
    keep: ["the coast road, the sea and the cliffs", "the woman driving"],
    aspect: "9:16",
    trend: { heat: 3, note: "Crackio's own clip, made with LTX-2.5 on open models: nobody's likeness or footage, so it's yours to post.", since: "2026-10" },
  },
  {
    id: "product-spin",
    own: true,
    title: "Product Spin",
    kind: "swap",
    categories: ["products"],
    line: "A slow turn on a pastel pedestal: your product, lit like an ad.",
    ...swapped("product-spin"),
    base: { url: `${A}/product-spin.mp4`, seconds: 8, action: "the product turns slowly on the round pedestal under soft studio light", audio: true },
    slots: [{ id: "product", kind: "object", label: "Your product", hint: HINT.object, target: "the white sneaker turning on the pink pedestal" }],
    keep: ["the pink pedestal", "the lilac studio backdrop and soft light"],
    aspect: "9:16",
    trend: { heat: 3, note: "Crackio's own clip, made with LTX-2.5 on open models: nobody's likeness or footage, so it's yours to post.", since: "2026-10" },
  },
  {
    id: "moon-moonwalk",
    own: true,
    title: "Moonwalk on the Moon",
    kind: "swap",
    categories: ["memes", "dance"],
    line: "One small step, one flawless moonwalk: anyone on the Moon, totally deadpan.",
    ...media("moon-moonwalk"),
    base: { url: `${A}/moon-moonwalk.mp4`, seconds: 8, action: "she moonwalks slowly backward over the grey moon dust with smooth sliding steps, little puffs of dust at her boots, her face completely deadpan", audio: true },
    slots: [you("the woman astronaut in the white spacesuit doing the moonwalk")],
    keep: ["the grey lunar surface and the moon dust", "the Earth in the black sky"],
    aspect: "9:16",
    trend: { heat: 3, note: "Crackio's own clip, made with LTX-2.5 on open models: nobody's likeness or footage, so it's yours to post.", since: "2026-10" },
  },
  {
    id: "office-chair-race",
    own: true,
    title: "Office Chair Grand Prix",
    kind: "swap",
    categories: ["memes"],
    line: "The meeting can wait: anyone in the office-chair grand prix.",
    ...media("office-chair-race"),
    base: { url: `${A}/office-chair-race.mp4`, seconds: 8, action: "she zooms down the empty office corridor on a rolling office chair, spins it round and round, then rolls on toward the camera laughing out loud", audio: true },
    slots: [you("the woman in the grey business suit riding the office chair")],
    keep: ["the rolling office chair", "the empty office corridor"],
    aspect: "9:16",
    trend: { heat: 3, note: "Crackio's own clip, made with LTX-2.5 on open models: nobody's likeness or footage, so it's yours to post.", since: "2026-10" },
  },
  {
    id: "trolley-surf",
    own: true,
    title: "Trolley Surf",
    kind: "swap",
    categories: ["memes", "cinematic"],
    line: "An empty supermarket at midnight, one trolley, perfect waves: anyone on board.",
    ...media("trolley-surf"),
    base: { url: `${A}/trolley-surf.mp4`, seconds: 8, action: "she stands up in the shopping trolley's basket like a surfer, arms out for balance, swaying and grinning as it glides down the empty supermarket aisle", audio: true },
    slots: [you("the woman in the yellow raincoat surfing the shopping trolley")],
    keep: ["the shopping trolley", "the empty supermarket aisle"],
    aspect: "9:16",
    trend: { heat: 3, note: "Crackio's own clip, made with LTX-2.5 on open models: nobody's likeness or footage, so it's yours to post.", since: "2026-10" },
  },
  /* ------------------------------------------------------------------ dance */
  {
    id: "costume-walk",
    own: true,
    title: "Costume Reveal Walk",
    kind: "swap",
    categories: ["memes", "dance"],
    line: "Feet first, the tilt-up on the drop, and the whole costume lands on you.",
    ...media("costume-walk"),
    base: {
      url: `${A}/costume-walk.mp4`,
      seconds: 8,
      action: "sneakers walk toward the camera at ankle height; at the cut on the drop the same walk shows heeled boots and a sweeping cape, then the camera tilts up to reveal the whole costume and she poses with a smirk",
      audio: true,
    },
    slots: [you("the woman walking toward the camera down the hallway", { default: "trend", trend: "after the cut, a pointed witch hat, a sweeping black velvet cape, heeled boots and smoky makeup" })],
    keep: ["the hallway and its warm wall lights", "the cut on the drop", "the tilt-up reveal"],
    aspect: "9:16",
    seasonal: { end: "2026-10-31", label: "Halloween · until Oct 31" },
    trend: { heat: 4, note: "Feet first, a cut on the beat and a tilt-up to the whole costume: type any costume under “Anything else”.", since: "2026-09" },
  },

  /* ------------------------------------------------------------------ cinematic */
  {
    id: "car-jump",
    own: true,
    title: "Car Jump",
    kind: "swap",
    categories: ["cinematic", "memes"],
    line: "Stay cool in your camp chair while a pickup flies right over you.",
    ...media("car-jump"),
    base: {
      url: `${A}/car-jump.mp4`,
      seconds: 8,
      action: "the red pickup hits the ramp and flies over her head at 3 s while she calmly sips her drink without flinching, then raises her cup to the camera",
      audio: true,
    },
    slots: [you("the woman sitting in the camp chair")],
    keep: ["the red pickup truck and its jump", "the camp chair", "the dust"],
    aspect: "9:16",
    trend: { heat: 3, note: "A pickup jumps the ramp right over your camp chair while you sip your drink: Crackio's own clip, yours to post.", since: "2026-09" },
  },
];

export const templateById = (id: string) => TEMPLATES.find((t) => t.id === id);
