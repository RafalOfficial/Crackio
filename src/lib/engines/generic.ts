import "server-only";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { probe, runFfmpeg } from "@/lib/motion/ffmpeg";
import { aspectById } from "@/lib/shot";
import {
  encodeDuration,
  fitDuration,
  fitResolution,
  nearestAspect,
  parseRatio,
  type AspectChoice,
  type Caps,
  type MediaInput,
  type MediaLimits,
} from "@/lib/models/caps";
import { orderedInputs } from "./util";
import { EngineError, type EngineJob, type EngineReference } from "./types";

/**
 * Builds the request for a model Crackio knows by its published schema (any fal model, Comfy Router
 * models with plain inputs). Pictures and clips are first made to fit the model's own limits
 * (size, shape, length, frame rate, file size), and every setting is snapped to a value the model
 * allows, so the provider never has a reason to refuse it.
 */

/** Sends a prepared file to wherever the model reads files from, and returns its URL (`input` says where it goes). */
export type Uploader = (data: Buffer, mime: string, name: string, input?: MediaInput) => Promise<string>;

type Prepared = { data: Buffer; mime: string; name: string };

/**
 * A picture made to fit: cropped to `cropTo` (width / height) when a clip is a different shape than
 * its frames, then into the model's allowed shape and size, under its file limit.
 */
export async function prepareImage(file: string, limits: MediaLimits = {}, maxEdge = 2048, cropTo?: number): Promise<Prepared> {
  // Upright first (EXIF), so crops and sizes below are in the picture's real orientation.
  const upright = await sharp(await fs.readFile(file), { failOn: "none" }).rotate().toBuffer({ resolveWithObject: true });
  let img = sharp(upright.data);
  const meta = { hasAlpha: upright.info.channels === 4 };
  let w = upright.info.width;
  let h = upright.info.height;
  if (!w || !h) throw new EngineError("Crackio couldn't read one of the pictures.");

  if (cropTo && Math.abs(Math.log(w / h / cropTo)) > 0.01) {
    const nw = w / h > cropTo ? Math.round(h * cropTo) : w;
    const nh = w / h > cropTo ? h : Math.round(w / cropTo);
    img = sharp(await img.extract({ left: Math.round((w - nw) / 2), top: Math.round((h - nh) / 2), width: nw, height: nh }).toBuffer());
    w = nw;
    h = nh;
  }

  // Shape: crop the middle into the allowed range of width / height.
  const ratio = w / h;
  if (limits.minRatio && ratio < limits.minRatio) {
    const nh = Math.round(w / limits.minRatio);
    img = img.extract({ left: 0, top: Math.round((h - nh) / 2), width: w, height: nh });
    h = nh;
  } else if (limits.maxRatio && ratio > limits.maxRatio) {
    const nw = Math.round(h * limits.maxRatio);
    img = img.extract({ left: Math.round((w - nw) / 2), top: 0, width: nw, height: h });
    w = nw;
  }

  // Size: big enough for the model's minimum, small enough for its maximum (and a sane upload).
  let scale = 1;
  const up = Math.max((limits.minWidth ?? 0) / w, (limits.minHeight ?? 0) / h, 1);
  if (up > 1) scale = up;
  const capW = Math.min(limits.maxWidth ?? Infinity, Math.max(maxEdge, limits.minWidth ?? 0));
  const capH = Math.min(limits.maxHeight ?? Infinity, Math.max(maxEdge, limits.minHeight ?? 0));
  scale = Math.min(scale, capW / w, capH / h);
  if (limits.maxArea) scale = Math.min(scale, Math.sqrt(limits.maxArea / (w * h)));
  const step = limits.multipleOf ?? 1;
  const nw = Math.max(step, Math.floor((w * scale) / step) * step);
  const nh = Math.max(step, Math.floor((h * scale) / step) * step);
  if (nw !== w || nh !== h) img = img.resize(nw, nh, { fit: "fill" });

  const alpha = Boolean(meta.hasAlpha);
  let data = alpha ? await img.png().toBuffer() : await img.jpeg({ quality: 92 }).toBuffer();
  for (let q = 82; limits.maxBytes && data.length > limits.maxBytes && q >= 42; q -= 10) data = await sharp(data).jpeg({ quality: q }).toBuffer();
  const name = `${path.basename(file, path.extname(file))}.${alpha ? "png" : "jpg"}`;
  return { data, mime: alpha ? "image/png" : "image/jpeg", name };
}

/** A clip made to fit: trimmed to the allowed length, scaled and re-timed into the allowed size and frame rate. */
export async function prepareVideo(file: string, limits: MediaLimits = {}, signal?: AbortSignal): Promise<Prepared> {
  const info = await probe(file);
  if (!info.width || !info.height) throw new EngineError("Crackio couldn't read the clip.");
  const duration = info.duration ?? 0;
  if (limits.minDuration && duration && duration < limits.minDuration - 0.05) {
    throw new EngineError(`This model needs a clip of at least ${limits.minDuration} seconds; yours is ${duration.toFixed(1)} s.`, "Pick a longer clip, or another model.");
  }
  const trim = limits.maxDuration && duration > limits.maxDuration ? Math.max(0.5, limits.maxDuration - 0.1) : null;

  let w = info.width;
  let h = info.height;
  const up = Math.max((limits.minWidth ?? 0) / w, (limits.minHeight ?? 0) / h, 1);
  const down = Math.min((limits.maxWidth ?? Infinity) / w, (limits.maxHeight ?? Infinity) / h, limits.maxArea ? Math.sqrt(limits.maxArea / (w * h)) : Infinity, 1);
  const scale = up > 1 ? up : down;
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  if (scale !== 1) {
    w = even(w * scale);
    h = even(h * scale);
  }
  const fps = info.fps && limits.minFps && info.fps < limits.minFps ? limits.minFps : info.fps && limits.maxFps && info.fps > limits.maxFps ? limits.maxFps : null;
  const tooBig = limits.maxBytes ? info.bytes > limits.maxBytes : false;
  const mp4 = /\.mp4$/i.test(file);
  if (!trim && scale === 1 && !fps && !tooBig && mp4) return { data: await fs.readFile(file), mime: "video/mp4", name: path.basename(file) };

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "crackio-fit-"));
  try {
    const out = path.join(dir, "clip.mp4");
    const filters = [scale !== 1 ? `scale=${w}:${h}` : "", fps ? `fps=${fps}` : ""].filter(Boolean).join(",");
    const run = await runFfmpeg(
      [
        "-y",
        "-i", file,
        ...(trim ? ["-t", trim.toFixed(2)] : []),
        ...(filters ? ["-vf", filters] : []),
        "-c:v", "libx264", "-preset", "fast", "-crf", tooBig ? "26" : "19", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "160k",
        "-movflags", "+faststart",
        out,
      ],
      { signal },
    );
    if (run.code !== 0) throw new EngineError("Crackio couldn't prepare the clip for this model.");
    return { data: await fs.readFile(out), mime: "video/mp4", name: "clip.mp4" };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ settings */

/**
 * The shape to ask for: the one picked in the tool, else "follow the picture" when there is one
 * (the model's own default among those, e.g. auto_2K over auto_1K), else the closest.
 */
function pickShape(choices: AspectChoice[], job: EngineJob, followInput: boolean, fallback: string | null = null): AspectChoice | null {
  const picked = job.options?.aspectValue ? choices.find((c) => c.value === job.options?.aspectValue) : undefined;
  if (picked) return picked;
  if (followInput) {
    const auto = choices.find((c) => c.ratio === null && c.value === fallback) ?? choices.find((c) => c.ratio === null);
    if (auto) return auto;
  }
  const a = aspectById(job.aspect);
  return nearestAspect(choices, a.w / a.h) ?? choices[0] ?? null;
}

/** Width and height for a custom size: the shape asked for at about a megapixel (a little more for clips, or the megapixels picked), in steps of 16. */
function customSize(ratio: number, video: boolean, megapixels?: number) {
  const area = megapixels ? megapixels * 1024 * 1024 : video ? 1280 * 720 : 1024 * 1024;
  const w = Math.sqrt(area * ratio);
  const snap = (n: number) => Math.max(256, Math.round(n / 16) * 16);
  return { width: snap(w), height: snap(w / ratio) };
}

async function sendImages(refs: EngineReference[], input: MediaInput, upload: Uploader, cropTo?: number): Promise<string[]> {
  const take = refs.slice(0, input.max);
  return Promise.all(
    take.map(async (r) => {
      const p = await prepareImage(r.path, input.limits, 2048, cropTo);
      return upload(p.data, p.mime, p.name, input);
    }),
  );
}

/** The shape a clip was asked for, when its frames should be cropped to it. */
function frameCrop(job: EngineJob): number | undefined {
  if (!job.options?.cropFrames) return undefined;
  const picked = job.options.aspectValue ? parseRatio(job.options.aspectValue) : null;
  const a = aspectById(job.aspect);
  return picked ?? a.w / a.h;
}

/**
 * The model's request body for a job. Throws a plain-language error when the job lacks something
 * the model requires (a start frame, a picture to edit, a clip).
 */
export async function buildInput(job: EngineJob, caps: Caps, upload: Uploader, signal?: AbortSignal): Promise<Record<string, unknown>> {
  if (caps.missing.length) {
    throw new EngineError(`This model needs inputs Crackio can't send yet (${caps.missing.join(", ")}).`, "Pick another model.");
  }
  const input: Record<string, unknown> = { ...caps.fixed };
  const video = job.kind === "video";

  // Words.
  if (caps.prompt) {
    const text = (job.prompt || job.userPrompt).trim();
    if (text) input[caps.prompt.field] = caps.prompt.maxLength ? text.slice(0, caps.prompt.maxLength) : text;
    else if (caps.prompt.required) throw new EngineError("This model needs a prompt.", "Describe what you want first.");
  }

  // Pictures and clips.
  let hasPicture = false;
  if (caps.video?.required && !job.source) throw new EngineError("This model edits a clip; there's none to send.", "Pick another model for this tool.");
  if (caps.video && job.source) {
    const clip = await prepareVideo(job.source.path, caps.video.limits, signal);
    input[caps.video.field] = await upload(clip.data, clip.mime, clip.name, caps.video);
    hasPicture = true;
    // Pictures beside a clip are references (a person to swap in, a look to match).
    const refs = job.references;
    const slot = caps.image ?? caps.refs;
    if (slot && refs.length) {
      const urls = await sendImages(refs, slot, upload);
      input[slot.field] = slot.array ? urls : urls[0];
      // One picture field and a reference list (Kling Omni): the rest go in the list.
      const rest = refs.slice(urls.length);
      if (caps.image && caps.refs && rest.length) {
        const more = await sendImages(rest, caps.refs, upload);
        input[caps.refs.field] = caps.refs.array ? more : more[0];
      }
    } else if (slot?.required) {
      throw new EngineError("This model needs a reference picture beside the clip.", "Attach an image to a change, or @mention someone from your cast.");
    }
  } else if (video) {
    const start = job.start ?? job.references.find((r) => /start frame/i.test(r.label ?? "")) ?? (job.references.length && !job.end ? job.references[0] : undefined);
    const end = job.end ?? job.references.find((r) => /end frame/i.test(r.label ?? ""));
    const others = job.references.filter((r) => r !== start && r !== end && r.path !== start?.path && r.path !== end?.path);
    const crop = frameCrop(job);
    if (caps.keyframes) {
      // Keyframe models: the start frame at 0, the end frame at the clip's last moment, the rest where they were pinned.
      const k = caps.keyframes;
      const length = caps.duration ? fitDuration(caps.duration, job.options?.duration) : 5;
      const seconds = typeof length === "number" ? length : typeof caps.duration?.default === "number" ? caps.duration.default : 5;
      const last = k.unit === "frame" ? Math.round(seconds * k.fps) : seconds;
      const pinned = [
        ...(start ? [{ ref: start, t: 0 }] : []),
        ...(job.keyframes ?? []).filter((f) => f.t > 0 && f.t < seconds).map((f) => ({ ref: f as EngineReference, t: f.t })),
        ...(end ? [{ ref: end, t: seconds }] : []),
      ];
      const items: Record<string, unknown>[] = [];
      const taken = new Set<number>();
      for (const p of pinned.slice(0, k.max)) {
        const at = k.unit === "frame" ? Math.min(last, Math.max(0, Math.round(p.t * k.fps))) : Math.min(seconds, Math.max(0, Math.round(p.t * 10) / 10));
        // Two pictures can't share a moment: the later one moves on by a frame.
        let spot = at;
        while (taken.has(spot) && spot < last) spot += k.unit === "frame" ? 1 : 0.1;
        taken.add(spot);
        const [url] = await sendImages([p.ref], { field: k.field, required: false, array: false, min: 0, max: 1 }, upload, crop);
        items.push({ [k.image]: url, [k.at]: spot });
      }
      if (items.length < Math.max(1, k.min) && k.required) throw new EngineError("This model animates between pictures: add a start frame.", "Or pick a text-to-video model.");
      if (items.length) {
        input[k.field] = items;
        hasPicture = true;
      }
    } else if (caps.image && start) {
      const [url] = await sendImages([start], caps.image, upload, crop);
      input[caps.image.field] = caps.image.array ? [url] : url;
      hasPicture = true;
    } else if (caps.refs && start) {
      const urls = await sendImages([start, ...others], caps.refs, upload);
      input[caps.refs.field] = caps.refs.array ? urls : urls[0];
      hasPicture = true;
    } else if (caps.image?.required || caps.refs?.required) {
      throw new EngineError("This model animates a picture: add a start frame.", "Or pick a text-to-video model.");
    }
    if (caps.refs && caps.image && others.length) {
      const urls = await sendImages(others, caps.refs, upload);
      input[caps.refs.field] = caps.refs.array ? urls : urls[0];
    }
    if (caps.end && end) {
      const [url] = await sendImages([end], caps.end, upload, crop);
      input[caps.end.field] = url;
    } else if (caps.end?.required) {
      throw new EngineError("This model needs an end frame too.", "Add one, or pick another model.");
    }
  } else {
    const total = (caps.image?.max ?? 0) + (caps.refs?.max ?? 0);
    const list = orderedInputs(job, Math.max(1, total));
    if (caps.image && list.length) {
      if (caps.image.array) {
        const urls = await sendImages(list, caps.image, upload);
        input[caps.image.field] = urls;
      } else {
        const [url] = await sendImages(list.slice(0, 1), caps.image, upload);
        input[caps.image.field] = url;
        if (caps.refs && list.length > 1) {
          const urls = await sendImages(list.slice(1), caps.refs, upload);
          input[caps.refs.field] = caps.refs.array ? urls : urls[0];
        }
      }
      hasPicture = true;
    } else if (caps.refs && list.length) {
      const urls = await sendImages(list, caps.refs, upload);
      input[caps.refs.field] = caps.refs.array ? urls : urls[0];
      hasPicture = true;
    } else if (caps.image?.required || caps.refs?.required) {
      throw new EngineError("This model edits a picture: add one first.", "Or pick a text-to-image model.");
    } else if (list.some((r) => r.role === "edit-target")) {
      // An edit tool sent a picture to change, and this model can't take pictures at all.
      throw new EngineError("This model makes images from words only, so it can't edit your picture.", "Pick an edit model (it says “Edit” in the Custom tab).");
    }
    // Where an inpainting model paints. The mask is the main picture's size, so the same crop and
    // scale as the picture keeps it lined up.
    if (caps.mask) {
      if (job.mask && hasPicture) {
        const m = await prepareImage(job.mask.path, caps.image?.limits, 2048);
        input[caps.mask.field] = await upload(m.data, m.mime, m.name, caps.mask);
      } else if (caps.mask.required) {
        throw new EngineError("This model only paints inside a marked area.", "Use it from Retouch, or pick another model.");
      }
    }
  }

  // Length, resolution, shape, sound.
  if (video && caps.duration && !job.source) Object.assign(input, encodeDuration(caps.duration, fitDuration(caps.duration, job.options?.duration)));
  if (caps.resolution) {
    const value = fitResolution(caps.resolution.choices, job.options?.resolution, caps.resolution.default);
    if (value !== null) input[caps.resolution.field] = value;
  }
  if (caps.quality && job.options?.quality && caps.quality.choices.some((c) => c.value === job.options?.quality)) input[caps.quality.field] = job.options.quality;
  // A reframe asks for the new shape; anything else with a picture keeps the picture's shape unless told otherwise.
  const target = job.kind === "reframe" ? job.options?.targetAspect : undefined;
  const shaped: EngineJob = target ? { ...job, aspect: aspectById(target).id, options: { ...job.options, aspectValue: target } } : job;
  const follow = hasPicture && !job.options?.cropFrames && !target;
  if (caps.aspect) {
    const shape = pickShape(caps.aspect.choices, shaped, follow, caps.aspect.default);
    if (shape) input[caps.aspect.field] = shape.value;
  }
  if (caps.size) {
    const shape = pickShape(caps.size.presets, shaped, follow, caps.size.default);
    const a = aspectById(shaped.aspect);
    const want = shaped.options?.aspectValue && !target ? null : a.w / a.h;
    // A size picked in megapixels: the shape at that many pixels (a picture whose shape follows the input keeps its preset).
    const mp = !video && caps.size.custom ? shaped.options?.megapixels : undefined;
    const sized = mp ? (shape?.ratio ?? (shape ? null : want)) : null;
    if (mp && sized) input[caps.size.field] = customSize(sized, video, mp);
    else if (shape && (shape.ratio === null || want === null || Math.abs(Math.log(shape.ratio / want)) < 0.02 || !caps.size.custom)) input[caps.size.field] = shape.value;
    else if (caps.size.custom && want) input[caps.size.field] = customSize(want, video, mp);
  }
  if (caps.audio && video) {
    const on = job.options?.sound ?? caps.audio.default;
    input[caps.audio.field] = caps.audio.values ? caps.audio.values[on ? 0 : 1] : on;
  }
  if (caps.count && !video) input[caps.count.field] = Math.min(caps.count.max, Math.max(caps.count.min, job.count));
  if (caps.scale && job.options?.scale) {
    const s = job.options.scale;
    const value = caps.scale.choices ? caps.scale.choices.reduce((b, v) => (Math.abs(v - s) < Math.abs(b - s) ? v : b)) : Math.min(caps.scale.max, Math.max(caps.scale.min, s));
    input[caps.scale.field] = caps.scale.encode === "string" ? String(value) : value;
  }
  // Fields a tool knows this model wants (Templates: MiniMax's enhance_realism, SCAIL's replacement mode).
  if (job.options?.extra) Object.assign(input, job.options.extra);
  return input;
}
