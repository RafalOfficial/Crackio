import type { ModelProfile } from "./models";
import type { SlotKind, Template, TemplateSlot } from "./types";

/**
 * The exact words sent with a template. Swaps follow one grammar for every model
 * (.research/templates-models.md §4): name the references in the model's own syntax, say exactly
 * who or what is replaced, match the new subject, settle the outfit, leave everyone else alone,
 * copy the motion, keep the set, camera and sound, and rule out the usual failures. Models that
 * take pictures get a short checklist of traits (the photo carries the likeness); Grok's clip
 * editor, which takes words only, gets the full description and makes a lookalike.
 */

export type SlotFill = {
  slot: TemplateSlot;
  /** A short noun for who or what it is ("a woman in her late twenties"). */
  noun: string;
  /** What makes them look like themselves (face, hair, build), or the pet, product or place itself. */
  look: string;
  /** The 4–8 traits that matter most at video resolution, for models that also see the photo. */
  traits?: string;
  /** People: what they wear in the photo. */
  wearing: string;
  /** People: wear the trend's costume, or their own clothes from the photo. */
  outfit: "trend" | "own";
  /** A Cast character's name. */
  name?: string;
  /** The reference picture that shows them (1-based), for models that take pictures. */
  picture?: number;
  /** That picture is a character sheet: several views of the same one person. */
  sheet?: boolean;
  /** Your own clip: who or what to replace, picked in a frame or typed. */
  target?: string;
};

const sentence = (s: string) => {
  const t = s.trim().replace(/\s+/g, " ");
  return t ? `${t.charAt(0).toUpperCase()}${t.slice(1)}${/[.!?]$/.test(t) ? "" : "."}` : "";
};
const lower = (s: string) => s.trim().replace(/\.$/, "");
/** A fragment that continues a sentence: no closing period, and "A plain tee" → "a plain tee" (but "TV" stays). */
const frag = (s: string) => lower(s).replace(/^[A-Z](?![A-Z])/, (c) => c.toLowerCase());
const ORDINAL = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth"];
const isPerson = (k: SlotKind) => k === "person" || k === "face";

/** How the clip and each picture are named in the model's own syntax. */
function tags(profile: ModelProfile) {
  switch (profile.syntax) {
    case "kling":
      return { video: "<<<video_1>>>", image: (n: number) => `<<<image_${n}>>>` };
    case "at":
      return { video: "@Video1", image: (n: number) => `@Image${n}` };
    case "positional":
      return { video: "Video 1", image: (n: number) => `Image ${n}` };
    case "ordinal":
      return { video: "the video", image: (n: number) => `the ${ORDINAL[n - 1] ?? `#${n}`} reference photo` };
    default:
      return { video: "the input video", image: (n: number) => `reference image ${n}` };
  }
}

/** A car, truck or bike rather than a product in someone's hands. */
const isVehicle = (slot: TemplateSlot) => /\b(car|truck|pickup|vehicle|bike|motorcycle|roadster|coup[eé])\b/i.test(`${slot.label} ${slot.target ?? ""}`);

/** "a corgi" → "corgi", for "exactly this corgi". */
const bare = (noun: string) => frag(noun).replace(/^(a|an|the)\s+/i, "");

/** Names for each filled slot: CHARACTER (A, B…), FACE, PET, PRODUCT or CAR, PLACE. */
function names(fills: SlotFill[]) {
  const LABEL: Record<SlotKind, string> = { person: "CHARACTER", face: "FACE", pet: "PET", object: "PRODUCT", place: "PLACE" };
  const people = fills.filter((f) => isPerson(f.slot.kind));
  const label = (f: SlotFill) => (f.slot.kind === "object" && isVehicle(f.slot) ? "CAR" : LABEL[f.slot.kind]);
  return new Map(
    fills.map((f) => {
      if (isPerson(f.slot.kind)) return [f, people.length > 1 ? `${label(f)} ${String.fromCharCode(65 + people.indexOf(f))}` : label(f)];
      const same = fills.filter((x) => label(x) === label(f));
      return [f, same.length > 1 ? `${label(f)} ${same.indexOf(f) + 1}` : label(f)];
    }),
  );
}

/** A short checklist of traits from the description (its first two sentences), when the reader didn't give one. */
function traitsOf(f: SlotFill) {
  if (f.traits?.trim()) return lower(f.traits);
  return lower(f.look.split(/(?<=\.)\s+/).slice(0, 2).join(" "));
}

type Mode = { words: boolean; compact: boolean };

/** One slot's change: who goes where, what they look like, what they wear. */
function slotLines(f: SlotFill, name: string, profile: ModelProfile, mode: Mode, target: string): string {
  const t = tags(profile);
  const ordinal = profile.syntax === "ordinal";
  // Who it is, as the model can refer to them: a name bound to a picture, the photo by its order, or a description.
  const who = mode.words ? frag(f.noun) : ordinal ? t.image(f.picture ?? 1) : name;
  const traits = mode.words ? lower(f.look) : traitsOf(f);
  switch (f.slot.kind) {
    case "person": {
      if (mode.words) {
        // Words-only editors (Grok) rebuild the whole shot when told to "replace" someone, so the swap is written
        // as an edit of the person who's there: their look changes, their body, pose and place don't.
        const look = traitsOf(f);
        const wear = f.outfit === "trend" && f.slot.outfit ? frag(f.slot.outfit.trend) : f.wearing ? frag(f.wearing) : "";
        return [
          `Edit only ${target} so they look like ${frag(f.noun)}: ${look}.`,
          wear ? `Change their clothes to ${wear}.` : "",
          "Keep their exact pose, body, position, size in the frame, movements and expressions; only their face, hair, skin tone and clothes change.",
        ]
          .filter(Boolean)
          .join(" ");
      }
      // The body stays where it was: same pose, same place, same size (a face-only photo must never become a floating bust).
      const pose = "in exactly the same pose, position and size in the frame, with a full body like the original";
      const replace = ordinal ? `Use ${who} to replace ${target}, ${pose}.` : `Replace only ${target} with ${who}, ${pose}.`;
      const match = ordinal ? "" : `Match ${who} exactly: ${traits}.`;
      const subject = ordinal ? "The new person" : who;
      const clothes =
        f.outfit === "trend" && f.slot.outfit
          ? `${subject} wears ${frag(f.slot.outfit.trend)}.`
          : f.wearing
            ? `${subject} keeps the clothes from the photo${mode.compact ? "" : `: ${frag(f.wearing)}`}.`
            : "";
      const remove = profile.positive
        ? `Only the new person's face, hair${f.outfit === "own" ? " and clothes" : ""} appear in that place.`
        : `The original person's face and hair${f.outfit === "own" || !f.slot.outfit ? " and clothes" : ""} are fully replaced; none of their features blend in.`;
      return [replace, match, clothes, remove].filter(Boolean).join(" ");
    }
    case "face": {
      const give = mode.words ? `Give ${target} a different face: ${traits}.` : ordinal ? `Use the face from ${who} for ${target}.` : `Change only the face of ${target} to ${who}'s face: ${traits}.`;
      return `${give} Keep their own hair, head shape, body, clothes, every movement, expression, lip movement and timing.`;
    }
    case "pet":
      return `Replace only ${target} with ${mode.words ? frag(f.noun) : `${who}, exactly this ${bare(f.noun)}`}: ${traits}. It copies the original animal's movements, pose and timing at the same size in the frame.`;
    case "object":
      return isVehicle(f.slot)
        ? `Replace only ${target} with ${mode.words ? frag(f.noun) : `${who}, exactly this ${bare(f.noun)}`}: ${traits}. Same size in the scene and same position, moving exactly like the original; its body shape, paint, wheels and lights stay exact, and any badge stays sharp and unwarped.`
        : `Replace only ${target} with ${mode.words ? frag(f.noun) : `${who}, exactly this ${bare(f.noun)}`}: ${traits}. Same size in the scene and same position; it follows the hands through every movement, and any lettering stays sharp and unwarped.`;
    case "place":
      return `Change the location to ${mode.words ? frag(f.noun) : `${who}, this ${frag(f.noun)}`}: ${traits}. Keep the people exactly as they are (identity, outfits, motion and timing) and keep the camera move and framing; relight them to match the new place. Nothing of the old location remains.`;
  }
}

function compose(t: Template, fills: SlotFill[], profile: ModelProfile, opts: { ownClip?: boolean; extra?: string }, mode: Mode): string {
  const named = names(fills);
  const tg = tags(profile);
  const tagged = profile.syntax === "kling" || profile.syntax === "at" || profile.syntax === "positional" || profile.syntax === "plain";
  const head =
    !mode.words && tagged
      ? [
          `VIDEO REFERENCE: ${tg.video}`,
          ...fills.map((f) => `${named.get(f)}: ${tg.image(f.picture ?? fills.indexOf(f) + 1)}${f.sheet ? ` (the views show ONE ${isPerson(f.slot.kind) ? "person" : f.slot.kind})` : ""}`),
        ].join("\n")
      : "";

  const people = fills.filter((f) => isPerson(f.slot.kind));
  const changes = fills.map((f) => slotLines(f, named.get(f)!, profile, mode, f.target ?? f.slot.target ?? "the main person"));
  const apart =
    people.length > 1
      ? profile.positive
        ? "They stay two different people, each in their own screen position."
        : "They stay two different people in their original screen positions; never swap, merge or mirror their faces."
      : "";
  // Optional slots left empty keep who's there (the second cat stays the black cat).
  const kept = t.slots.filter((s) => s.optional && s.target && !fills.some((f) => f.slot.id === s.id)).map((s) => lower(s.target!));
  const others = opts.ownClip
    ? "Leave everyone and everything else unchanged."
    : [t.base?.others, ...kept].filter(Boolean).length
      ? `Leave ${[t.base?.others, ...kept].filter(Boolean).map((x) => lower(x!)).join(" and ")} unchanged.`
      : "";
  const beats = !opts.ownClip && t.base?.action && (mode.words || !mode.compact) ? ` (${lower(t.base.action)})` : "";
  const motion = `Copy the original movements${beats}, expressions and timing exactly.`;
  const keep = !opts.ownClip && t.keep.length ? `Preserve ${t.keep.map(lower).join(", ")}, the camera, the editing and the original audio.` : "Preserve the setting, the camera, the editing and the original audio.";
  const guards = profile.positive
    ? `Every face stays sharp and stable in every frame, and the action stays exactly as in the original.`
    : people.length
      ? `Keep ${people.length > 1 ? "each new person" : "the new person"} identical in every frame. No added actions, no blended faces, no extra people, no duplicates, no distortions.`
      : "Keep it identical in every frame. No added actions, no duplicates, no distortions.";
  const extra = opts.extra?.trim() ? `Also: ${sentence(opts.extra)}` : "";
  return [head, [...changes, apart, others].filter(Boolean).join(" "), [motion, keep, guards].join(" "), extra].filter(Boolean).join("\n\n");
}

/**
 * The finished clip described, for models whose prompt says what the result looks like rather than
 * what to change (SCAIL-2: "colored masks bind body regions, the prompt controls final appearance").
 * Duos are told apart by place, left to right in slot order, which is how the swap pairs them.
 */
/** Whole sentences of `text` up to `max` characters (at least the first one, cut at a word). */
function brief(text: string, max: number) {
  const sentences = text.trim().match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) ?? [text];
  let out = "";
  for (const s of sentences) {
    if (out && (out + s).length > max) break;
    out += s;
  }
  return out.length > max ? `${out.slice(0, max).replace(/\s+\S*$/, "")}` : out.trim();
}

function scenePrompt(t: Template, fills: SlotFill[], extra?: string, maxChars = 1500): string {
  const PLACES = fills.length > 1 ? ["On the left", "On the right", "Third from the left", "Fourth from the left"] : [""];
  const action = t.base?.action ? `${t.base.action.charAt(0).toUpperCase()}${frag(t.base.action).slice(1)}.` : "";
  const scene = t.keep?.length ? `The scene: ${t.keep.join(", ")}.` : "";
  const tail = [action, scene, extra?.trim() ? `${lower(extra)}.` : ""].filter(Boolean).join(" ");
  // The reference pictures carry each look; the words name what matters most, and every part fits whole.
  const each = Math.max(220, Math.floor((maxChars - tail.length - 20) / Math.max(1, fills.length)));
  const people = fills.map((f, i) => {
    const outfit = f.outfit === "trend" && f.slot.outfit?.trend ? f.slot.outfit.trend : frag(f.wearing);
    const wearing = outfit ? `, wearing ${outfit}` : "";
    const lead = `${PLACES[i] ? `${PLACES[i]}, ` : ""}${frag(f.noun)}: `;
    const look = brief(frag(f.traits || f.look), Math.max(80, each - lead.length - wearing.length - 2)).replace(/[.!?]+$/, "");
    const who = `${lead}${look}${wearing}.`;
    return PLACES[i] ? who : `${who.charAt(0).toUpperCase()}${who.slice(1)}`;
  });
  return brief([...people, tail].filter(Boolean).join(" "), maxChars);
}

/** The edit for a swap template (or for your own clip), in the words and syntax of the model that runs it. */
export function swapPrompt(t: Template, fills: SlotFill[], profile: ModelProfile, opts: { ownClip?: boolean; extra?: string } = {}): string {
  if (profile.syntax === "scene") return scenePrompt(t, fills, opts.extra, profile.maxChars ?? 4000);
  const words = profile.syntax === "words";
  if (profile.syntax === "none") {
    // The model reads only the clip and the photo; a line for the record.
    return `Replace ${fills[0]?.target ?? fills[0]?.slot.target ?? "the main person"} with the ${isPerson(fills[0]?.slot.kind ?? "person") ? "person" : (fills[0]?.slot.kind ?? "subject")} in the photo.`;
  }
  const full = compose(t, fills, profile, opts, { words, compact: false });
  if (!profile.maxChars || full.length <= profile.maxChars) return full;
  // Too long for this model: the short checklist and fewer extras.
  return compose(t, fills, profile, opts, { words, compact: true }).slice(0, profile.maxChars);
}

/** The shot for an effect or a kit: the template's own words with your photo and your blanks filled in. */
export function shotPrompt(t: Template, fills: SlotFill[], fields: Record<string, string>): string {
  let text = t.prompt ?? "";
  for (const f of t.fields ?? []) text = text.replaceAll(`{${f.id}}`, (fields[f.id] ?? "").trim() || f.examples[0] || f.placeholder);
  for (const f of fills) text = text.replaceAll(`{${f.slot.id}}`, f.name ? `${f.name} (${frag(f.noun)})` : frag(f.noun));
  const who = fills
    .filter((f) => f.look)
    .map((f) => (isPerson(f.slot.kind) ? sentence(`${f.name ?? frag(f.noun)} looks exactly like the photo: ${traitsOf(f)}`) : sentence(`${frag(f.noun)}: ${traitsOf(f)}`)))
    .join(" ");
  return [sentence(text), who].filter(Boolean).join("\n\n");
}
