import { aspectChoice, type AspectChoice, type Caps, type MediaInput } from "@/lib/models/caps";

/**
 * Comfy Router video models whose request bodies nest their inputs (Seedance's `content[]`,
 * Wan's `input.media[]`, Veo's `instances[]`, Kling Omni's `image_list`…), so the flat schema
 * reader can't drive them. Each family states what it accepts, in Crackio's terms, from its Router
 * schema (Oct 2026) and the limits written in its descriptions; the generic builder then fits every
 * setting into flat placeholder fields, and `nest` moves them into the provider's shape.
 *
 * Placeholder fields start with "_": `_first` and `_last` are a clip's frames, `_refs` reference
 * pictures, `_video` an input clip, `_prompt` the words; settings use their real names.
 */

export type Family = {
  /** What the model accepts; null when this family doesn't cover the id. */
  caps: (id: string) => Caps;
  /** The provider body from the flat input the generic builder made. Pictures arrive as data URIs, clips as URLs. */
  nest: (id: string, flat: Record<string, unknown>) => Record<string, unknown>;
};

const shapes = (ids: string[]) => ids.map(aspectChoice).filter((c): c is AspectChoice => c !== null);
const frame = (field: string, limits?: MediaInput["limits"]): MediaInput => ({ field, required: false, array: false, min: 0, max: 1, limits });
const list = (field: string, max: number, limits?: MediaInput["limits"]): MediaInput => ({ field, required: false, array: true, min: 0, max, limits });
const res = (field: string, values: [string, string, number][], def: string) => ({ field, choices: values.map(([value, label, height]) => ({ value, label, height })), default: def });

const base: Omit<Caps, "output" | "prompt"> = {
  negative: null,
  image: null,
  refs: null,
  end: null,
  video: null,
  duration: null,
  resolution: null,
  quality: null,
  aspect: null,
  size: null,
  audio: null,
  count: null,
  scale: null,
  seed: null,
  fixed: {},
  missing: [],
};

const prompt = (field = "_prompt", maxLength?: number) => ({ field, required: true, maxLength });
const strip = (flat: Record<string, unknown>) => Object.fromEntries(Object.entries(flat).filter(([k, v]) => !k.startsWith("_") && v !== undefined));
const dataOf = (uri: unknown) => {
  const s = String(uri);
  return { bytesBase64Encoded: s.slice(s.indexOf(",") + 1), mimeType: /^data:image\/png/.test(s) ? "image/png" : "image/jpeg" };
};

/** BytePlus Seedance 1.0–2.5: `content[]` with text, frames and references. */
const seedance: Family = {
  caps: (id) => {
    const v25 = /seedance-2-5/.test(id);
    const v2 = /seedance-2-0/.test(id);
    const v15 = /seedance-1-5/.test(id);
    const max = v25 ? 30 : v2 ? 15 : 12;
    return {
      ...base,
      output: "video",
      prompt: prompt("_prompt", 100_000),
      image: frame("_first"),
      end: frame("_last"),
      refs: v25 || v2 ? list("_refs", 4) : null,
      duration: { field: "duration", mode: "range", min: v25 || v2 || v15 ? 4 : 2, max, integer: true, encode: "number", auto: !/seedance-1-0/.test(id), autoValue: -1, default: 5 },
      resolution: res("resolution", v2 ? [["480p", "480p", 480], ["720p", "720p", 720]] : [["480p", "480p", 480], ["720p", "720p", 720], ["1080p", "1080p", 1080]], "720p"),
      aspect: { field: "ratio", choices: shapes(["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16", "9:21"]), default: "adaptive" },
      audio: /seedance-1-0/.test(id) ? null : { field: "generate_audio", default: true },
      fixed: { watermark: false },
    };
  },
  nest: (id, flat) => {
    const content: Record<string, unknown>[] = [{ type: "text", text: flat._prompt ?? "" }];
    if (flat._first) content.push({ type: "image_url", image_url: { url: flat._first }, role: "first_frame" });
    if (flat._last) content.push({ type: "image_url", image_url: { url: flat._last }, role: "last_frame" });
    for (const url of (flat._refs as string[] | undefined) ?? []) content.push({ type: "image_url", image_url: { url }, role: "reference_image" });
    const body = { ...strip(flat), content };
    // Seedance 2.5 refuses a ratio other than adaptive when it starts from a frame.
    if (flat._first && /seedance-2-5/.test(id)) delete (body as Record<string, unknown>).ratio;
    return body;
  },
};

/** MiniMax H3 (Hailuo 03): `content[]` with exactly one text item; a ratio is required without frames. */
const minimax: Family = {
  caps: () => ({
    ...base,
    output: "video",
    prompt: prompt(),
    image: frame("_first"),
    end: frame("_last"),
    duration: { field: "duration", mode: "range", min: 4, max: 15, integer: true, encode: "number", auto: false, default: 5 },
    resolution: res("resolution", [["768P", "768p", 768], ["2K", "2K", 1440]], "768P"),
    aspect: { field: "ratio", choices: shapes(["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]), default: "adaptive" },
  }),
  nest: (_id, flat) => {
    const content: Record<string, unknown>[] = [{ type: "text", text: flat._prompt ?? "" }];
    if (flat._first) content.push({ type: "image_url", image_url: { url: flat._first }, role: "first_frame" });
    if (flat._last) content.push({ type: "image_url", image_url: { url: flat._last }, role: "last_frame" });
    const body: Record<string, unknown> = { ...strip(flat), content };
    // Text-to-video needs a concrete ratio; from a frame it follows the frame.
    if (!flat._first && (!body.ratio || body.ratio === "adaptive")) body.ratio = "16:9";
    return body;
  },
};

/** Wan 3.0 Video (and Prime): `input` (prompt, media) and `parameters` (length, shape, resolution, sound). */
const wan3: Family = {
  caps: () => ({
    ...base,
    output: "video",
    prompt: prompt("_prompt", 20_000),
    image: frame("_first"),
    end: frame("_last"),
    duration: { field: "_duration", mode: "range", min: 2, max: 30, integer: true, encode: "number", auto: true, autoValue: -1, default: 5 },
    resolution: res("_resolution", [["480P", "480p", 480], ["720P", "720p", 720], ["1080P", "1080p", 1080]], "720P"),
    aspect: { field: "_ratio", choices: shapes(["adaptive", "16:9", "9:16", "1:1", "4:3", "3:4"]), default: "adaptive" },
    audio: { field: "_audio", default: true },
  }),
  nest: (_id, flat) => {
    const media: Record<string, unknown>[] = [];
    if (flat._first) media.push({ type: "first_frame", url: flat._first });
    if (flat._last) media.push({ type: "last_frame", url: flat._last });
    const parameters = Object.fromEntries(
      Object.entries({ duration: flat._duration, resolution: flat._resolution ?? "720P", ratio: flat._ratio, audio: flat._audio, watermark: false }).filter(([, v]) => v !== undefined),
    );
    return { ...strip(flat), input: { prompt: flat._prompt ?? "", ...(media.length ? { media } : {}) }, parameters };
  },
};

/** Veo 3.1 (Fast, Lite): `instances[0]` and `parameters`; frames go inline as base64 (Google's 20 MB cap). */
const veo: Family = {
  caps: (id) => ({
    ...base,
    output: "video",
    prompt: prompt(),
    image: frame("_first", { maxBytes: 19_000_000 }),
    end: frame("_last", { maxBytes: 19_000_000 }),
    duration: { field: "_duration", mode: "list", seconds: [4, 6, 8], encode: "number", auto: null, default: 8 },
    resolution: res("_resolution", /lite/.test(id) ? [["720p", "720p", 720], ["1080p", "1080p", 1080]] : [["720p", "720p", 720], ["1080p", "1080p", 1080], ["4k", "4K", 2160]], "720p"),
    aspect: { field: "_ratio", choices: shapes(["16:9", "9:16"]), default: "16:9" },
    audio: { field: "_audio", default: true },
  }),
  nest: (_id, flat) => ({
    instances: [{ prompt: flat._prompt ?? "", ...(flat._first ? { image: dataOf(flat._first) } : {}), ...(flat._last ? { lastFrame: dataOf(flat._last) } : {}) }],
    parameters: Object.fromEntries(
      Object.entries({ durationSeconds: flat._duration, aspectRatio: flat._ratio, resolution: flat._resolution, generateAudio: flat._audio, sampleCount: 1 }).filter(([, v]) => v !== undefined),
    ),
  }),
};

/**
 * Kling V3 Omni and Video O1: frames in `image_list`, a clip to edit in `video_list`; std is 720p,
 * pro 1080p. Beside a clip, up to four pictures are references (one per person in a swap).
 */
const klingOmni: Family = {
  caps: () => ({
    ...base,
    output: "video",
    prompt: prompt("prompt", 2500),
    image: frame("_first", { maxBytes: 10_000_000, minWidth: 300, minHeight: 300 }),
    refs: list("_refs", 3, { maxBytes: 10_000_000, minWidth: 300, minHeight: 300 }),
    end: frame("_last", { maxBytes: 10_000_000, minWidth: 300, minHeight: 300 }),
    video: { field: "_video", required: false, array: false, min: 0, max: 1, limits: { minDuration: 3, maxDuration: 10, minWidth: 720, minHeight: 720, maxWidth: 2160, maxHeight: 2160, minFps: 24, maxFps: 60, maxBytes: 200_000_000 } },
    duration: { field: "duration", mode: "list", seconds: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], encode: "string", auto: null, default: 5 },
    resolution: res("mode", [["std", "720p", 720], ["pro", "1080p", 1080]], "pro"),
    aspect: { field: "aspect_ratio", choices: shapes(["16:9", "9:16", "1:1"]), default: "16:9" },
    audio: { field: "sound", default: false, values: ["on", "off"] },
  }),
  nest: (_id, flat) => {
    const body: Record<string, unknown> = strip(flat);
    const images: Record<string, unknown>[] = [];
    // Beside a clip to edit, pictures are references (a look, a person), not a first frame.
    if (flat._first) images.push(flat._video ? { image_url: flat._first } : { image_url: flat._first, type: "first_frame" });
    if (flat._video) for (const url of (flat._refs as string[] | undefined) ?? []) images.push({ image_url: url });
    // An end frame needs a first frame.
    if (flat._last && flat._first && !flat._video) images.push({ image_url: flat._last, type: "end_frame" });
    if (images.length) body.image_list = images;
    if (flat._video) {
      body.video_list = [{ video_url: flat._video, refer_type: "base", keep_original_sound: "yes" }];
      delete body.duration; // an edit keeps the clip's length
    }
    // The shape follows the frame or the clip when there is one.
    if (flat._first || flat._video) delete body.aspect_ratio;
    return body;
  },
};

/** Kling 3.0 Turbo: words only; length, shape and resolution under `settings`. */
const klingTurbo: Family = {
  caps: () => ({
    ...base,
    output: "video",
    prompt: prompt("prompt", 3072),
    duration: { field: "_duration", mode: "range", min: 3, max: 15, integer: true, encode: "number", auto: false, default: 5 },
    resolution: res("_resolution", [["720p", "720p", 720], ["1080p", "1080p", 1080]], "720p"),
    aspect: { field: "_ratio", choices: shapes(["16:9", "9:16", "1:1"]), default: "16:9" },
  }),
  nest: (_id, flat) => ({
    ...strip(flat),
    settings: Object.fromEntries(Object.entries({ duration: flat._duration, aspect_ratio: flat._ratio, resolution: flat._resolution }).filter(([, v]) => v !== undefined)),
  }),
};

/** Grok Imagine Video through Router: the start frame is an object; the shape follows it when given. */
const grokVideo: Family = {
  caps: () => ({
    ...base,
    output: "video",
    prompt: prompt("prompt", 4096),
    image: frame("_first"),
    duration: { field: "duration", mode: "range", min: 1, max: 15, integer: true, encode: "number", auto: false, default: 8 },
    aspect: { field: "aspect_ratio", choices: shapes(["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3"]), default: "16:9" },
  }),
  nest: (_id, flat) => {
    const body: Record<string, unknown> = strip(flat);
    if (flat._first) {
      body.image = { type: "image_url", url: flat._first };
      delete body.aspect_ratio;
    }
    return body;
  },
};

const FAMILIES: [RegExp, Family][] = [
  [/^byteplus\/(dreamina-seedance|seedance)-/, seedance],
  [/^minimax\/minimax-h3$/, minimax],
  [/^wan\/wan3\.0-video(-prime)?$/, wan3],
  [/^veo\/veo-3\.1-/, veo],
  [/^kling\/(kling-v3-omni|kling-video-o1)$/, klingOmni],
  [/^kling\/kling-3\.0-turbo$/, klingTurbo],
  [/^xai\/grok-imagine-video/, grokVideo],
];

export const familyFor = (id: string) => FAMILIES.find(([re]) => re.test(id))?.[1] ?? null;

/** Fields a schema can't express, for flat models that need them (a required setting without a default). */
export const FLAT_FIXES: [RegExp, Record<string, unknown>][] = [[/^fal\/h3-max/, { prompt_expansion_mode: "balanced" }]];

/** Choices a schema names only in words: Krea 3's `resolution` is "1k or 2k" (Ultra thinking needs 2k). */
export const CAPS_FIXES: [RegExp, Partial<Caps>][] = [
  [/^krea\/krea-3$/, { resolution: { field: "resolution", choices: [{ value: "1k", label: "1K" }, { value: "2k", label: "2K" }], default: "2k" } }],
];
