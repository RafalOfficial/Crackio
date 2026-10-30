import { imageSlots } from "@/lib/models/caps";
import type { ModelAvailability } from "@/lib/models/catalog";

/** Who or what a cast member is: a real person, an animal, a designed character, or an object (a prop, a product, a car). */
export type CastKind = "person" | "pet" | "character" | "object";

export const CAST_KINDS: { id: CastKind; label: string; hint: string; noun: string }[] = [
  { id: "person", label: "Person", hint: "You, a friend, a model", noun: "person" },
  { id: "pet", label: "Animal", hint: "A pet or any animal", noun: "animal" },
  { id: "character", label: "Character", hint: "A mascot, cartoon or 3D figure", noun: "character" },
  { id: "object", label: "Object", hint: "A prop, product, bag or car", noun: "object" },
];

export const castNoun = (kind: CastKind) => CAST_KINDS.find((k) => k.id === kind)?.noun ?? "subject";

/** The views on a reference sheet, left to right. Sheets drawn before Crackio drew backs show a three-quarter view and a profile. */
export type SheetView = "front" | "three-quarter" | "side" | "back";
export const SHEET_VIEWS: SheetView[] = ["front", "side", "back"];
export const LEGACY_SHEET_VIEWS: SheetView[] = ["front", "three-quarter", "side"];
/** The views you can ask for, in the order a sheet shows them. */
export const VIEW_ORDER: SheetView[] = ["front", "three-quarter", "side", "back"];
export const VIEW_LABELS: Record<SheetView, string> = { front: "Front", "three-quarter": "Three-quarter", side: "Side", back: "Back" };

/**
 * Things that look the same from every side. A second view only draws the same thing again, and a model that thinks a
 * side view should differ squeezes it (a bubble umbrella came out narrower in its "side" view).
 */
export const ROUND =
  /\b(umbrella|parasol|ball|balloon|globe|orb|sphere|bottle|vase|jar|can|cup|mug|glass|tumbler|candle|lamp|lantern|bowl|plate|cake|donut|doughnut|wheel|tyre|tire|clock|coin|drum|barrel|bucket|pot|planter|cactus|pillar|column|cone|dome|lollipop)\b/i;

/**
 * The views drawn when nobody planned them (no text model to ask): people, animals and characters look different from
 * every side; a thing that is the same all round needs one; anything else, its front and side.
 */
export function defaultViews(kind: CastKind, text: string): SheetView[] {
  if (kind !== "object") return ["front", "side", "back"];
  return ROUND.test(text) ? ["front"] : ["front", "side"];
}

/**
 * What a figure shows from each side, in words: from the front picture alone, a model drew a cat's "back" as its face
 * again. (A thing's are planned with its views: see `viewLooks`.)
 */
export const FIGURE_LOOKS: Record<Exclude<CastKind, "object">, Partial<Record<SheetView, string>>> = {
  person: {
    "three-quarter": "the face and body turned halfway, one side of the face toward the camera",
    side: "their profile: one side of the face, one ear, and one shoulder, arm and leg toward the camera",
    back: "the back of the head and hair, the back of the body and outfit, and the heels of the shoes, with the face turned away",
  },
  character: {
    "three-quarter": "the face and body turned halfway",
    side: "its profile, one side of its head and body toward the camera",
    back: "the back of its head and body, with its face turned away",
  },
  pet: {
    "three-quarter": "its head and body turned halfway",
    side: "its whole body in profile from nose to tail, with all four legs",
    back: "the back of its head and ears, its back, its rump and its tail, with its face turned away",
  },
};

/** Views in sheet order, front always first. */
export const tidyViews = (views: readonly string[]): SheetView[] => {
  const asked = new Set(views);
  return VIEW_ORDER.filter((v) => v === "front" || asked.has(v));
};

/**
 * A recurring person, animal, character or object. Its photos (or a description) become a reference sheet (the whole
 * subject from the front, the side and the back) and a portrait (a face close-up; for an object, a clean hero shot);
 * typing @handle in any prompt brings those along as references, so it looks like itself in every shot, at its real size.
 */
export type Character = {
  id: string;
  name: string;
  /** What you type after "@": lowercase letters, digits and underscores. */
  handle: string;
  kind: CastKind;
  /** The photos it was made from (uploads). Empty when it was made from a description. */
  photos: string[];
  /** How it was described, when there were no photos. */
  description?: string;
  /** Anything to always keep ("round glasses", "a scar over the left eyebrow"). */
  notes?: string;
  portrait?: string;
  sheet?: string;
  /** The sheet's views, left to right (missing: a sheet from before, front / three-quarter / profile). Planned when it's added: only the sides that look different. */
  views?: SheetView[];
  /** Each view drawn as a picture of its own, in a frame shaped for it (nothing squeezed); Crackio lays the sheet out from them at one scale. Missing on sheets drawn as one picture. */
  viewPictures?: Partial<Record<SheetView, string>>;
  /** Why these views, in a few words (the plan's reason). */
  viewsWhy?: string;
  /** What each side shows, in words (a guitar's back: "the plain wooden back of the body, no strings"), planned with the views of a thing: a model given only the front tends to draw the front again. */
  viewLooks?: Partial<Record<SheetView, string>>;
  /** What it had before a rebuild, kept until the new pictures are in (and put back if the rebuild fails). */
  previous?: Pick<Character, "portrait" | "sheet" | "views" | "viewsWhy" | "viewLooks" | "viewPictures" | "sheetLayout" | "builtWith" | "noun" | "traits" | "height">;
  /** A few words naming exactly this subject ("a grey city pigeon"), read from its pictures; models are told it. */
  noun?: string;
  /** One sentence of stable identity traits, written from the pictures; models get it when they get no picture of it. */
  traits?: string;
  /** The small details that make it itself and that pictures alone tend to lose (a pendant, a logo, a scar), read once from the traits in `from`: every shot names them. Empty `details`: none. */
  keep?: { from: string; details: string };
  /** Real height in meters (standing or sitting as it normally would), so shots keep it true to scale. */
  height?: number;
  /** The height was typed in, not read from the pictures: a new reading leaves it alone. */
  heightSet?: boolean;
  /** Real length in meters, for an object much longer than tall (a car, a boat, a sofa). */
  length?: number;
  /** Much longer than tall (a vehicle, a boat, a sofa): its sheet gives the side view a row of its own. */
  long?: boolean;
  /** How the sheet was laid out: three views in a row, or front and back above a full-width side view ("rows"). */
  sheetLayout?: "rows";
  /** The image model that draws the portrait and sheet (missing: Auto, the same rule the picker shows). */
  model?: string;
  /** The model that drew the current sheet (its display name). */
  builtWith?: string;
  status: "building" | "ready" | "error";
  error?: string;
  /** The generations building the portrait and the sheet, while they run. */
  jobs: { portrait?: string; sheet?: string; views?: Partial<Record<SheetView, string>> };
  /** 0–1 while building. */
  progress?: number;
  createdAt: number;
  updatedAt: number;
};

/** A cast member who can be in a shot as someone (a co-star, the person holding a product): anyone but an object. */
export type Someone = Character & { kind: Exclude<CastKind, "object"> };

/** "Mia Rossi" → "mia_rossi"; keeps what you type after "@" short and predictable. */
export function toHandle(name: string) {
  return (
    name
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 24) || "character"
  );
}

/**
 * Things much longer than they are tall. Three views side by side leave a car's side view a third of the picture, so
 * models squash it or cut it off: these get front and back on one row and the side across the whole row below.
 */
export const LONG = /\b(car|cars|hatchback|sedan|saloon|coupe|convertible|roadster|wagon|estate|van|minivan|truck|lorry|pickup|suv|jeep|4x4|off-road|bus|minibus|coach|camper|campervan|caravan|trailer|limousine|limo|taxi|tractor|motorcycle|motorbike|bike|bicycle|moped|boat|yacht|canoe|kayak|ship|train|tram|locomotive|plane|airplane|aeroplane|jet|helicopter|sofa|couch|bench|surfboard|snowboard|skis)\b/i;
export const isLong = (text: string) => LONG.test(text);

/** Mentions in a prompt: "@mia" and "@mia_rossi", not emails like "me@mia.com". */
export const MENTION = /(^|[^\w@])@([a-z0-9_]{2,24})\b/gi;

/** The handles a text mentions, lowercased, in order of first mention. */
export function mentionedHandles(text: string) {
  return [...new Set([...text.matchAll(MENTION)].map((m) => m[2].toLowerCase()))];
}

/**
 * The image models Cast prefers for drawing sheets, portraits and a clip's first frame with the cast, after your saved
 * default. Open ones by Crackio's cast benchmark (Oct 28 2026, 5 scenes on an RTX 5090): FLUX 3 Klein 8.5 of 10 with no
 * doubled figures and ~15 s a picture; Qwen-Image 2.1 7.8–8.1, some doubles, ~60 s with references; FLUX.2 klein 9B
 * Edit 8.0 but draws a sheet's subject twice in about a quarter of busy shots.
 */
export const CAST_PREFER = [
  "comfy:openai/gpt-image-2.5-sunburst",
  "comfy:vertexai/gemini-nano-banana-2.1",
  "comfy:bfl/flux-3-image",
  "local:flux3-klein",
  "local:tpl:qwen-image-2.1",
];

/** Cast draws from pictures (a sheet from photos, a portrait from the sheet): only models that take them can build one. */
export const castFits = (m: Pick<ModelAvailability, "caps" | "maxRefs">) => (m.caps ? imageSlots(m.caps) : m.maxRefs) > 0;

/**
 * The image models that may draw a clip's first frame with its cast, in order: for a clip made on your own GPU, the
 * open models on it first (the whole job stays on your machine), then Cast's usual favorites.
 */
export function framePrefer(models: Pick<ModelAvailability, "id" | "via" | "kind" | "caps" | "maxRefs">[], localClip: boolean) {
  if (!localClip) return CAST_PREFER;
  const local = models.filter((m) => m.kind === "image" && m.via === "comfy-local" && castFits(m)).map((m) => m.id);
  const ranked = [...CAST_PREFER.filter((id) => local.includes(id)), ...local];
  return [...new Set([...ranked, ...CAST_PREFER])];
}

/** "1.68 m", "33 cm", "4 cm": a height people read at a glance. */
export function formatHeight(meters: number) {
  if (meters >= 1) return `${(Math.round(meters * 100) / 100).toFixed(2).replace(/0$/, "").replace(/\.0$/, "")} m`;
  return `${Math.max(1, Math.round(meters * 100))} cm`;
}

/** "1.68", "1,68 m", "33cm", "33 cm", "0.33", "5'7\"", "5 ft 7", "12 in" → meters; null when it doesn't read as a height. */
export function parseHeight(text: string): number | null {
  const feet = /^\s*(\d+(?:\.\d+)?)\s*(?:'|’|ft|feet|foot)\s*(?:(\d+(?:\.\d+)?)\s*(?:"|”|''|in|inch|inches)?)?\s*$/i.exec(text);
  const inches = /^\s*(\d+(?:\.\d+)?)\s*(?:"|”|in|inch|inches)\s*$/i.exec(text);
  if (feet || inches) {
    const meters = feet ? Number(feet[1]) * 0.3048 + Number(feet[2] ?? 0) * 0.0254 : Number(inches![1]) * 0.0254;
    return meters > 0.005 && meters < 200 ? Math.round(meters * 1000) / 1000 : null;
  }
  const m = /^\s*(\d+(?:[.,]\d+)?)\s*(cm|m|mm)?\s*$/i.exec(text);
  if (!m) return null;
  const n = Number(m[1].replace(",", "."));
  const unit = (m[2] ?? (n > 3 ? "cm" : "m")).toLowerCase();
  const meters = unit === "cm" ? n / 100 : unit === "mm" ? n / 1000 : n;
  return meters > 0.005 && meters < 200 ? Math.round(meters * 1000) / 1000 : null;
}
