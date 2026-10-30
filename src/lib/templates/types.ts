import type { AspectId } from "@/lib/shot";

/**
 * A template: a clip format you put yourself (or a friend, a pet, a product, a place) into.
 * - swap: a base clip whose motion, timing, camera and sound stay; the model replaces who or what you pick.
 * - effect: your photo becomes the first frame of a transformation.
 * - kit: a fill-in-the-blanks format ("what happens to X if you do Y for Z days").
 */
export type TemplateKind = "swap" | "effect" | "kit";

export type TemplateCategory = "memes" | "dance" | "duo" | "pets" | "products" | "cinematic" | "effects" | "kits";

export const CATEGORIES: { id: TemplateCategory; label: string }[] = [
  { id: "memes", label: "Memes" },
  { id: "dance", label: "Dance" },
  { id: "duo", label: "Duo" },
  { id: "pets", label: "Pets" },
  { id: "products", label: "Products" },
  { id: "cinematic", label: "Cinematic" },
  { id: "effects", label: "Effects" },
  { id: "kits", label: "Kits" },
];

/** What a slot takes: a person (whole body), only a face, a pet, an object or product, or a place. */
export type SlotKind = "person" | "face" | "pet" | "object" | "place";

export type TemplateSlot = {
  id: string;
  kind: SlotKind;
  /** What the card asks for: "You", "Your friend", "Your product". */
  label: string;
  /** Which photo works best. */
  hint: string;
  /** Swaps: who or what this replaces in the base clip, the way a model can find it ("the woman in the olive tracksuit juggling the ball"). */
  target?: string;
  /** People: the trend's costume, when it's part of the joke. They can wear their own clothes instead. */
  outfit?: { default: "trend" | "own"; trend: string };
  optional?: boolean;
};

export type TemplateField = {
  id: string;
  label: string;
  placeholder: string;
  /** Tap-to-fill ideas; the first one is used for the preview. */
  examples: string[];
  max?: number;
};

export type TemplateTrend = {
  /** 1–5: how hot it is right now (5: everywhere this week; 3: an evergreen format). */
  heat: 1 | 2 | 3 | 4 | 5;
  /** One line on why it spreads. */
  note: string;
  /** When it took off ("2026-10"). */
  since: string;
  source?: string;
  /** Views across its posts as last read ("≈430M views"), shown on the card. */
  views?: string;
  /** What people call it on X (phrases and hashtags), for measuring it there this week. */
  queries?: string[];
};

export type Template = {
  id: string;
  title: string;
  kind: TemplateKind;
  categories: TemplateCategory[];
  /** One line: what you get. */
  line: string;
  /** The card's still and its hover clip. */
  poster: string;
  clip: string;
  /** Swaps: the clip whose motion, timing, camera and sound the remix keeps. */
  base?: {
    url: string;
    seconds: number;
    /** What happens in it, beat by beat, for models that edit from words. */
    action: string;
    /** Everyone and everything that isn't swapped, so the model leaves them alone. */
    others?: string;
    audio: boolean;
    /** Where a model that edits less than the whole clip starts by default (seconds). */
    focus?: number;
  };
  slots: TemplateSlot[];
  fields?: TemplateField[];
  /** What must stay exactly as it is (swaps), or what the shot must show (effects and kits). */
  keep: string[];
  /** Effects and kits: the shot, with {field} and {slot} placeholders. */
  prompt?: string;
  /**
   * Kits: how a text model turns your blanks into the shot list (beats, voiceover lines), before
   * the video model runs. Its answer replaces {script} in `prompt`.
   */
  writer?: string;
  /** Effects and kits: how long the clip runs. */
  seconds?: number;
  aspect: AspectId;
  /** Effects and kits: whether the clip should have sound (a voice, music, effects). */
  sound?: boolean;
  trend: TemplateTrend;
  /** An original format of Crackio's own, made on open models (not a trend's remake): shown under "Made by Crackio". */
  own?: boolean;
  /** A seasonal trend: shown until `end` (a date), with its badge ("Halloween · until Oct 31"). */
  seasonal?: { end: string; label: string };
};
