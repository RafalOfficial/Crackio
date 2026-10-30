import { aspectChoice, resolutionLabel, type AspectChoice, type CapChoice, type Caps, type DurationCap, type MediaInput, type MediaLimits } from "@/lib/models/caps";

/**
 * Reads what a model accepts from the OpenAPI document its provider publishes (fal and Comfy
 * Router both do, per model). Field names follow strong conventions across hundreds of models
 * (`image_url`, `end_image_url`, `duration`, `resolution`, `aspect_ratio`, `generate_audio`…), so
 * the mapping below is by name and shape, checked against fal's whole image and video catalog.
 */

type Schema = {
  $ref?: string;
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number | boolean;
  exclusiveMaximum?: number | boolean;
  items?: Schema;
  maxItems?: number;
  minItems?: number;
  anyOf?: Schema[];
  oneOf?: Schema[];
  allOf?: Schema[];
  properties?: Record<string, Schema>;
  required?: string[];
  nullable?: boolean;
  description?: string;
  maxLength?: number;
  format?: string;
  pattern?: string;
  "x-fal"?: Record<string, unknown>;
  ui?: { field?: string };
};

type Doc = { paths?: Record<string, Record<string, { requestBody?: { content?: Record<string, { schema?: Schema }> } }>>; components?: { schemas?: Record<string, Schema> } };

/** One property, with its anyOf branches folded together. */
type Info = {
  types: Set<string>;
  nullable: boolean;
  /** Every allowed literal across branches (null left out). */
  enums: (string | number)[];
  /** A branch that is a plain string with no fixed values. */
  freeString: boolean;
  min?: number;
  max?: number;
  integer: boolean;
  def: unknown;
  items?: Info;
  minItems?: number;
  maxItems?: number;
  /** Keys of an object branch (e.g. width/height of a custom size). */
  objectKeys: string[];
  xfal?: Record<string, unknown>;
  ui?: string;
  desc: string;
  maxLength?: number;
  format?: string;
  /** A pattern the value must match (e.g. "^https://"). */
  pattern?: string;
};

function deref(doc: Doc, s: Schema | undefined, depth = 0): Schema | undefined {
  if (!s || depth > 12) return s;
  if (s.$ref) {
    const name = s.$ref.split("/").pop() ?? "";
    const target = doc.components?.schemas?.[name];
    // Keep the referencing schema's own notes (default, description) over the target's.
    const { $ref: _ref, ...own } = s;
    void _ref;
    return deref(doc, target ? { ...target, ...own } : own, depth + 1);
  }
  if (s.allOf?.length) {
    const parts = s.allOf.map((x) => deref(doc, x, depth + 1) ?? {});
    const merged: Schema = { ...s, allOf: undefined };
    for (const p of parts) {
      Object.assign(merged, { ...p, ...merged, properties: { ...p.properties, ...merged.properties }, required: [...(p.required ?? []), ...(merged.required ?? [])] });
    }
    return merged;
  }
  return s;
}

function info(doc: Doc, raw: Schema): Info {
  const s = deref(doc, raw) ?? {};
  const branches = [...(s.anyOf ?? []), ...(s.oneOf ?? [])].map((b) => deref(doc, b) ?? {});
  const all = branches.length ? branches : [s];
  const out: Info = { types: new Set(), nullable: Boolean(s.nullable), enums: [], freeString: false, integer: false, def: s.default, objectKeys: [], desc: s.description ?? "", maxLength: s.maxLength, format: s.format };
  const notes = [s, ...all];
  for (const n of notes) {
    if (n.pattern && !out.pattern) out.pattern = n.pattern;
    if (n["x-fal"] && !out.xfal) out.xfal = n["x-fal"];
    if (n.ui?.field && !out.ui) out.ui = n.ui.field;
    if (n.maxLength && !out.maxLength) out.maxLength = n.maxLength;
  }
  for (const b of all) {
    const types = Array.isArray(b.type) ? b.type : b.type ? [b.type] : b.properties ? ["object"] : b.enum || b.const !== undefined ? [typeof (b.enum?.[0] ?? b.const)] : [];
    for (const t of types) {
      if (t === "null") out.nullable = true;
      else out.types.add(t);
    }
    if (b.nullable) out.nullable = true;
    const literals = b.enum ?? (b.const !== undefined ? [b.const] : null);
    if (literals) {
      for (const v of literals) if (v !== null && (typeof v === "string" || typeof v === "number") && !out.enums.includes(v)) out.enums.push(v);
    } else if (types.includes("string")) out.freeString = true;
    if (types.includes("integer")) out.integer = true;
    if (types.includes("integer") || types.includes("number")) {
      const lo = typeof b.minimum === "number" ? b.minimum : typeof b.exclusiveMinimum === "number" ? b.exclusiveMinimum : undefined;
      const hi = typeof b.maximum === "number" ? b.maximum : typeof b.exclusiveMaximum === "number" ? b.exclusiveMaximum : undefined;
      if (lo !== undefined) out.min = out.min === undefined ? lo : Math.min(out.min, lo);
      if (hi !== undefined) out.max = out.max === undefined ? hi : Math.max(out.max, hi);
    }
    if (types.includes("array") && b.items) {
      out.items = info(doc, b.items);
      out.maxItems = b.maxItems ?? out.maxItems;
      out.minItems = b.minItems ?? out.minItems;
    }
    if (types.includes("object") && b.properties) out.objectKeys.push(...Object.keys(b.properties));
    if (b.default !== undefined && out.def === undefined) out.def = b.default;
  }
  return out;
}

/** The request body schema of a model's run route, with its required fields. */
export function inputSchema(doc: Doc): { props: Record<string, Schema>; required: string[] } | null {
  for (const [route, ops] of Object.entries(doc.paths ?? {})) {
    if (/\/requests\/|\{request_id\}|\/status$|\/cancel$/.test(route)) continue;
    const body = ops.post?.requestBody?.content;
    const raw = body?.["application/json"]?.schema ?? Object.values(body ?? {})[0]?.schema;
    const s = deref(doc, raw);
    if (s?.properties) return { props: s.properties, required: s.required ?? [] };
  }
  return null;
}

/* ------------------------------------------------------------------ fields */

const MAIN_IMAGE = ["start_image_url", "first_frame_url", "first_frame_image_url", "first_image_url", "image_url", "input_image_url", "input_image", "source_image_url", "initial_image_url", "image", "start_frame", "image_reference_url", "reference_image_url", "ref_image_url"];
const IMAGE_LISTS = ["image_urls", "input_image_urls", "images", "reference_image_urls", "reference_images", "ref_image_urls"];
const REF_LISTS = ["reference_image_urls", "image_urls", "ref_image_urls", "input_image_urls", "reference_images", "images"];
const END_IMAGE = ["end_image_url", "last_frame_url", "tail_image_url", "last_image_url", "end_frame_url", "last_frame_image_url", "end_frame"];
const VIDEO_INPUT = ["video_url", "input_video_url", "source_video_url", "video"];
const DURATION = ["duration", "duration_seconds", "duration_s", "durationSeconds", "seconds", "video_length", "num_seconds", "video_duration"];
const AUDIO = ["generate_audio", "audio", "with_audio", "enable_audio", "sound", "generate_audio_switch", "add_audio"];
const COUNT = ["num_images", "n", "num_outputs", "number_of_images", "num_videos"];
const SCALE = ["upscale_factor", "scale", "scale_factor", "upscaling_factor", "desired_increase"];
const PROMPT = ["prompt", "instruction", "edit_prompt", "text_prompt"];
const MASK = ["mask_url", "mask_image_url", "mask_image", "mask"];
const KEYFRAMES = ["keyframes", "key_frames", "keyframe_images", "image_keyframes"];
const KEYFRAME_IMAGE = /^(image_url|image|url|image_uri|frame_url)$/;
const KEYFRAME_FRAME = /^(frame_index|frame|frame_number|index)$/;
const KEYFRAME_TIME = /^(time|timestamp|seconds|time_s|at|start_time)$/;
const SIZE = ["image_size", "video_size", "size"];
const RESOLUTION = ["resolution", "video_resolution", "output_resolution"];

const LIMIT_KEYS: Record<string, keyof MediaLimits> = {
  min_width: "minWidth",
  min_height: "minHeight",
  max_width: "maxWidth",
  max_height: "maxHeight",
  min_aspect_ratio: "minRatio",
  max_aspect_ratio: "maxRatio",
  max_file_size: "maxBytes",
  min_duration: "minDuration",
  max_duration: "maxDuration",
  min_fps: "minFps",
  max_fps: "maxFps",
  multiple_of: "multipleOf",
  max_area: "maxArea",
};

function limitsOf(i: Info | undefined): MediaLimits | undefined {
  const x = i?.xfal ?? i?.items?.xfal;
  if (!x) return undefined;
  const out: MediaLimits = {};
  for (const [k, v] of Object.entries(x)) if (LIMIT_KEYS[k] && typeof v === "number") out[LIMIT_KEYS[k]] = v;
  return Object.keys(out).length ? out : undefined;
}

const isUrlString = (name: string, i: Info) =>
  i.types.has("string") && !i.enums.length && (/(url|uri)$|^(image|video|start_frame|end_frame)$|_image$|_frame$/.test(name) || i.ui === "image" || i.ui === "video" || Boolean(i.xfal) || i.format === "uri");

const isUrlList = (name: string, i: Info) =>
  i.types.has("array") && Boolean(i.items?.types.has("string")) && !i.items?.enums.length && (/urls$|^(images|videos|frames|reference_images)$/.test(name) || Boolean(i.items?.xfal) || i.items?.ui === "image");

function mediaInput(name: string, i: Info, required: boolean): MediaInput {
  const array = i.types.has("array");
  return {
    field: name,
    required,
    array,
    min: array ? Math.max(required ? 1 : 0, i.minItems ?? 0) : required ? 1 : 0,
    max: array ? Math.max(1, i.maxItems ?? (typeof i.def === "object" && Array.isArray(i.def) ? Math.max(4, i.def.length) : 4)) : 1,
    limits: limitsOf(i),
    ...(/^\^https?/.test(i.pattern ?? i.items?.pattern ?? "") ? { urlOnly: true } : {}),
  };
}

function durationCap(name: string, i: Info): DurationCap | null {
  const auto = i.enums.find((v) => typeof v === "string" && /^auto$/i.test(v)) as string | undefined;
  const values = i.enums.filter((v) => v !== auto);
  if (values.length) {
    const parsed = values.map((v) => (typeof v === "number" ? v : Number(String(v).replace(/s$/i, "")))).filter((n) => Number.isFinite(n) && n > 0);
    if (!parsed.length) return null;
    const suffix = values.some((v) => typeof v === "string" && /s$/i.test(v));
    const encode = suffix ? "suffix" : values.every((v) => typeof v === "number") ? "number" : "string";
    const d = typeof i.def === "number" ? i.def : typeof i.def === "string" ? (/^auto$/i.test(i.def) ? "auto" : Number(i.def.replace(/s$/i, ""))) : null;
    return { field: name, mode: "list", seconds: [...new Set(parsed)].sort((a, b) => a - b), encode, auto: auto ?? null, default: typeof d === "number" && !Number.isFinite(d) ? null : d };
  }
  if (i.types.has("integer") || i.types.has("number") || i.freeString) {
    const d = typeof i.def === "number" ? i.def : typeof i.def === "string" && Number.isFinite(Number(i.def)) ? Number(i.def) : null;
    if (i.max === undefined) return d ? { field: name, mode: "list", seconds: [d], encode: i.freeString ? "string" : "number", auto: null, default: d } : null;
    const picks = i.nullable && /null|smart|auto|decide|pick/i.test(i.desc);
    return { field: name, mode: "range", min: Math.max(i.min ?? 1, 0.1), max: i.max, integer: i.integer || !i.types.has("number"), encode: i.freeString && !i.types.has("number") && !i.types.has("integer") ? "string" : "number", auto: picks, default: picks && d === null ? "auto" : d };
  }
  return null;
}

function framesCap(frames: Info, fps: Info | undefined): DurationCap | null {
  if (frames.max === undefined) return null;
  const rate = typeof fps?.def === "number" ? fps.def : 24;
  const def = typeof frames.def === "number" ? frames.def : null;
  const said = /8\s*[nk]\s*\+\s*1/i.test(frames.desc) ? 8 : /4\s*[nk]\s*\+\s*1/i.test(frames.desc) ? 4 : 0;
  const snap = (said || (def !== null && def % 8 === 1 ? 8 : def !== null && def % 4 === 1 ? 4 : 1)) as 1 | 4 | 8;
  return { field: "num_frames", mode: "frames", min: frames.min ?? 1, max: frames.max, fps: rate, snap, default: def };
}

function choicesOf(i: Info): CapChoice[] {
  return i.enums.map((v) => ({ value: v, label: resolutionLabel(v) }));
}

/** fal's named sizes ("landscape_16_9") or pixel sizes ("1024x768"); "auto" alone doesn't make a field a size. */
const isSizePreset = (v: string | number) => typeof v === "string" && (/^(square|portrait|landscape)/.test(v) || /^\d+x\d+$/i.test(v));
const isSizeValue = (v: string | number) => isSizePreset(v) || (typeof v === "string" && /^auto(_|$)/i.test(v));

function sizeCap(name: string, i: Info): Caps["size"] {
  const presets = i.enums
    .filter((v): v is string => typeof v === "string")
    .map(aspectChoice)
    .filter((c): c is AspectChoice => c !== null);
  const custom = i.objectKeys.includes("width") && i.objectKeys.includes("height");
  if (!presets.length && !custom) return null;
  return { field: name, presets, custom, default: typeof i.def === "string" ? i.def : null };
}

/* ------------------------------------------------------------------ caps */

/**
 * What a model accepts, from its OpenAPI document. `output` says what it makes (from the
 * provider's category); null when the document has no run route Crackio can read.
 */
export function capsFromOpenApi(doc: unknown, output: "image" | "video"): Caps | null {
  const d = doc as Doc;
  const input = inputSchema(d);
  if (!input) return null;
  const props = Object.fromEntries(Object.entries(input.props).map(([k, v]) => [k, info(d, v)]));
  const required = new Set(input.required);
  const used = new Set<string>();
  const take = (name: string | undefined) => (name ? (used.add(name), name) : undefined);
  const first = (names: string[], ok: (n: string, i: Info) => boolean) => names.find((n) => props[n] && !used.has(n) && ok(n, props[n]));

  const caps: Caps = {
    output,
    prompt: null,
    negative: null,
    image: null,
    refs: null,
    end: null,
    video: null,
    mask: null,
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

  const promptName = take(first(PROMPT, (_, i) => i.types.has("string") && !i.enums.length));
  if (promptName) caps.prompt = { field: promptName, required: required.has(promptName), maxLength: props[promptName].maxLength };
  if (props.negative_prompt?.types.has("string")) caps.negative = take("negative_prompt")!;
  if (props.seed && (props.seed.types.has("integer") || props.seed.types.has("number"))) caps.seed = take("seed")!;

  // Pictures and clips.
  const video = take(first(VIDEO_INPUT, isUrlString));
  if (video) caps.video = mediaInput(video, props[video], required.has(video));
  const end = take(first(END_IMAGE, isUrlString));
  if (end) caps.end = mediaInput(end, props[end], required.has(end));
  const main = take(first(MAIN_IMAGE, isUrlString)) ?? take(first(IMAGE_LISTS, isUrlList));
  if (main) caps.image = mediaInput(main, props[main], required.has(main));
  const refs = take(first(REF_LISTS, isUrlList));
  if (refs) caps.refs = mediaInput(refs, props[refs], required.has(refs));
  const mask = output === "image" ? take(first(MASK, (n, i) => isUrlString(n, i) || (i.types.has("string") && !i.enums.length))) : undefined;
  if (mask) caps.mask = mediaInput(mask, props[mask], required.has(mask));
  // Keyframes: a list of {picture, where in the clip}. The frame rate is the one the docs give (24 fps when unsaid).
  const kf = output === "video" ? first(KEYFRAMES, (_, i) => i.types.has("array") && Boolean(i.items?.objectKeys.length)) : undefined;
  if (kf) {
    const keys = props[kf].items!.objectKeys;
    const image = keys.find((k) => KEYFRAME_IMAGE.test(k));
    const frame = keys.find((k) => KEYFRAME_FRAME.test(k));
    const time = keys.find((k) => KEYFRAME_TIME.test(k));
    const fps = Number(/(\d{2})\s*fps|fps\s*(?:of|=|:)?\s*(\d{2})/i.exec(props[kf].desc)?.slice(1).find(Boolean) ?? 24);
    if (image && (frame || time)) {
      caps.keyframes = { field: take(kf)!, image, at: (frame ?? time)!, unit: frame ? "frame" : "second", fps, min: props[kf].minItems ?? 0, max: props[kf].maxItems ?? 10, required: required.has(kf) };
    }
  }

  // Length.
  const dur = first(DURATION, (_, i) => i.enums.length > 0 || i.types.has("integer") || i.types.has("number") || i.freeString);
  if (dur && output === "video") {
    caps.duration = durationCap(dur, props[dur]);
    if (caps.duration) used.add(dur);
  }
  if (!caps.duration && output === "video" && props.num_frames && (props.num_frames.types.has("integer") || props.num_frames.types.has("number"))) {
    caps.duration = framesCap(props.num_frames, props.fps ?? props.frames_per_second);
    if (caps.duration) used.add("num_frames");
  }

  // Shape and size.
  const sizeName = first([...SIZE, ...RESOLUTION], (_, i) => (i.objectKeys.includes("width") && i.objectKeys.includes("height")) || i.enums.some(isSizePreset));
  if (sizeName) {
    caps.size = sizeCap(sizeName, props[sizeName]);
    if (caps.size) used.add(sizeName);
  }
  const res = first(RESOLUTION, (_, i) => i.enums.length > 0 && !i.enums.every(isSizeValue));
  if (res) {
    caps.resolution = { field: take(res)!, choices: choicesOf(props[res]), default: (props[res].def as string | number | undefined) ?? null };
  }
  if (output === "image" && props.quality?.enums.length) {
    caps.quality = { field: take("quality")!, choices: props.quality.enums.map((v) => ({ value: v, label: String(v)[0].toUpperCase() + String(v).slice(1) })), default: (props.quality.def as string | undefined) ?? null };
  }
  const aspect = first(["aspect_ratio", "aspect", "ratio"], (_, i) => i.enums.length > 0);
  if (aspect) {
    const choices = props[aspect].enums
      .filter((v): v is string => typeof v === "string")
      .map(aspectChoice)
      .filter((c): c is AspectChoice => c !== null);
    if (choices.length) caps.aspect = { field: take(aspect)!, choices, default: typeof props[aspect].def === "string" ? (props[aspect].def as string) : null };
  }

  // Sound, takes, scale.
  const audio = first(AUDIO, (_, i) => i.types.has("boolean") || (i.enums.length === 2 && i.enums.includes("on") && i.enums.includes("off")));
  if (audio && output === "video") {
    const words = !props[audio].types.has("boolean");
    caps.audio = words ? { field: take(audio)!, default: props[audio].def === "on", values: ["on", "off"] } : { field: take(audio)!, default: props[audio].def !== false };
  }
  const count = first(COUNT, (_, i) => i.types.has("integer") || i.types.has("number"));
  if (count) caps.count = { field: take(count)!, min: Math.max(1, props[count].min ?? 1), max: Math.max(1, props[count].max ?? 4) };
  const scale = first(SCALE, (_, i) => i.types.has("integer") || i.types.has("number") || i.enums.length > 0);
  if (scale) {
    const i = props[scale];
    const nums = i.enums.map((v) => (typeof v === "number" ? v : Number(String(v).replace(/x$/i, "")))).filter((n) => Number.isFinite(n) && n > 0);
    caps.scale = {
      field: take(scale)!,
      choices: nums.length ? nums : null,
      min: nums.length ? Math.min(...nums) : (i.min ?? 1),
      max: nums.length ? Math.max(...nums) : (i.max ?? 4),
      default: typeof i.def === "number" ? i.def : null,
      encode: i.enums.some((v) => typeof v === "string") ? "string" : "number",
    };
  }

  // Required fields Crackio doesn't drive: fill them with their defaults, or note what's missing.
  for (const name of required) {
    if (used.has(name)) continue;
    const i = props[name];
    if (!i) continue;
    if (i.def !== undefined) caps.fixed[name] = i.def;
    else if (i.enums.length) caps.fixed[name] = i.enums[0];
    else if (i.types.has("boolean")) caps.fixed[name] = false;
    else if (i.nullable) caps.fixed[name] = null;
    else caps.missing.push(name);
  }
  // A required picture, clip or sound in a role Crackio can't fill (a mask, a pose, a voice…).
  for (const [name, i] of Object.entries(props)) {
    if (used.has(name) || !required.has(name) || caps.missing.includes(name)) continue;
    if ((isUrlString(name, i) || isUrlList(name, i)) && i.def === undefined) {
      caps.missing.push(name);
      delete caps.fixed[name];
    }
  }
  return caps;
}
