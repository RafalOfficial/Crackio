import "server-only";
import { Comfy, comfy, ComfyError, routerErrors, type RunResult } from "@comfyorg/sdk";
import { getSettings } from "@/lib/server/settings";
import { aspectById } from "@/lib/shot";
import { comfyModel } from "@/lib/providers/comfy-models";
import { refinePrompt } from "./refine";
import { buildInput } from "./generic";
import { familyFor } from "./comfy-families";
import type { MediaInput } from "@/lib/models/caps";
import { closestRatio, fetchOutput, fitAspect, orderedInputs, ticker, toDataUrl } from "./util";
import { EngineError, type Engine, type EngineContext, type EngineJob, type EngineOutput, type EngineResult } from "./types";
import { recorded } from "@/lib/server/recipes";
import { lean } from "@/lib/recipes/recipe";

/**
 * Comfy Router through the official @comfyorg/sdk: one Comfy API key reaches FLUX 3,
 * GPT Image 2.5, Nano Banana, Seedream, Qwen-Image, Grok Imagine, upscalers and more.
 * Each model takes its provider's own request body, so requests are built per family.
 */
const TIMEOUT_MS = 660_000; // above Router's 10-minute synchronous deadline

const RATIOS = (ids: string[]) =>
  ids.map((id) => {
    const [w, h] = id.split(":").map(Number);
    return { id, r: w / h };
  });
const FLUX_RATIOS = RATIOS(["21:9", "16:9", "3:2", "4:3", "1:1", "3:4", "2:3", "9:16", "9:21"]);
const GEMINI_RATIOS = RATIOS(["21:9", "16:9", "3:2", "4:3", "5:4", "1:1", "4:5", "3:4", "2:3", "9:16"]);
const GROK_RATIOS = RATIOS(["2:1", "16:9", "3:2", "4:3", "1:1", "3:4", "2:3", "9:16", "1:2"]);
const BRIA_RATIOS = RATIOS(["16:9", "3:2", "4:3", "5:4", "1:1", "4:5", "3:4", "2:3", "9:16"]);

async function apiKey() {
  const key = (await getSettings()).keys.comfy || process.env.COMFY_API_KEY;
  if (!key) throw new EngineError("No Comfy API key is set.", "Add one in Connections (platform.comfy.org → API keys).");
  return key;
}

/** Turn SDK errors (synchronous runs and the queue alike) into something a person can act on. */
function explain(err: unknown): never {
  if (err instanceof EngineError) throw err;
  const routed = err instanceof routerErrors.RouterError;
  if (err instanceof ComfyError || routed) {
    const e = err as { message: string; httpStatus?: number | null; requestId?: string | null; code?: string; errorType?: string };
    const code = (routed ? e.errorType : e.code) ?? "";
    if (/^unauthorized$/i.test(code) || e.httpStatus === 401) throw new EngineError("Comfy rejected the API key.", "Check the key in Connections, or create a new one at platform.comfy.org.");
    if (/not_enabled/i.test(code)) throw new EngineError(`This isn't available on your Comfy account yet: ${e.message}`, "Pick another model, or check your Comfy workspace.");
    if (/forbidden/i.test(code) || e.httpStatus === 403) throw new EngineError("Your Comfy workspace can't use this model.", "Pick another model.");
    if (/insufficient_credits/i.test(code) || e.httpStatus === 402)
      throw new EngineError("Your Comfy workspace is out of credits.", "Add credits at platform.comfy.org, or pick another model.");
    if (/content_policy/i.test(code)) throw new EngineError("The model declined this request.", "Change the request and try again.");
    if (/model_not_found/i.test(code)) throw new EngineError(`This model isn't on Comfy anymore: ${e.message}`, "Pick another model.");
    if (/rate_limited|concurrency|queue_backlog/i.test(code)) throw new EngineError("Comfy is busy right now.", "Wait a moment and try again.");
    if (/invalid_input/i.test(code)) throw new EngineError(`The model rejected the request: ${e.message}`, "Try other settings, or another model.");
    if (/timeout|deadline/i.test(code)) throw new EngineError("Comfy took too long with this job.", "Try again; shorter clips finish faster.");
    throw new EngineError(`Comfy Router error${code ? ` (${code})` : ""}: ${e.message}${e.requestId ? ` · request ${e.requestId}` : ""}`);
  }
  throw new EngineError(`Comfy Router error: ${(err as Error).message}`);
}

/**
 * Models answer in their own shapes. Walk the response and collect every image or video it
 * points to: URLs, data URIs, and base64 fields (b64_json, inlineData.data, bytesBase64Encoded).
 */
export function extractMedia(data: unknown): { url?: string; b64?: string; mime?: string }[] {
  const found: { url?: string; b64?: string; mime?: string }[] = [];
  const seen = new Set<string>();
  const add = (item: { url?: string; b64?: string; mime?: string }) => {
    const key = item.url ?? item.b64?.slice(0, 64) ?? "";
    if (key && !seen.has(key)) {
      seen.add(key);
      found.push(item);
    }
  };
  const walk = (v: unknown, key = "", parent?: Record<string, unknown>) => {
    if (typeof v === "string") {
      if (/^data:(image|video)\//.test(v)) return add({ url: v });
      if (/^https?:\/\//.test(v) && !/(status|cancel|response|get|webhook)_?url$/i.test(key) && key !== "urls") {
        if (/(url|image|sample|video|output|result|uri|link)/i.test(key) || /\.(png|jpe?g|webp|mp4|webm)(\?|$)/i.test(v)) add({ url: v });
        return;
      }
      if (/^(b64_json|bytesBase64Encoded)$/.test(key) || (key === "data" && typeof parent?.mimeType === "string")) {
        add({ b64: v, mime: typeof parent?.mimeType === "string" ? parent.mimeType : undefined });
      }
      return;
    }
    if (Array.isArray(v)) return v.forEach((x) => walk(x, key, parent));
    if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, k, v as Record<string, unknown>);
    }
  };
  walk(data);
  return found;
}

const rawBase64 = (dataUrl: string) => dataUrl.slice(dataUrl.indexOf(",") + 1);

function withLayout(prompt: string, job: EngineJob) {
  // FLUX 3 reads subject placement as a JSON table appended to the prompt (box_N rows on a 0–1000 grid).
  return job.layout?.length ? `${prompt} ${JSON.stringify(job.layout)}` : prompt;
}

/** The size tier asked for (builtin-caps: 1K, 2K or 4K), 2K when none was. */
const tierOf = (job: EngineJob): "1k" | "2k" | "4k" => {
  const r = String(job.options?.resolution ?? "").toLowerCase();
  return r === "1k" || r === "4k" ? r : "2k";
};

/**
 * Width × height for a size given in pixels: the tier's long edge in this shape, on a grid of 16, inside a model's limits
 * on its pixel count (GPT Image 2.5 takes 655,360 to 8,294,400, so its 4K square is 2880²).
 */
function tierSize(ratio: number, tier: "1k" | "2k" | "4k", [least, most]: [number, number]) {
  const edge = { "1k": 1024, "2k": 2048, "4k": 3840 }[tier];
  let w = ratio >= 1 ? edge : edge * ratio;
  let h = ratio >= 1 ? edge / ratio : edge;
  const scale = Math.sqrt(Math.min(1, most / (w * h))) * Math.sqrt(Math.max(1, least / (w * h)));
  w = Math.floor((w * scale) / 16) * 16;
  h = Math.floor((h * scale) / 16) * 16;
  return { width: w, height: h };
}

/** The provider-native request body for one call (also used to ask Comfy for a price quote). */
export function buildBody(job: EngineJob, prompt: string, images: string[]): Record<string, unknown> {
  const a = aspectById(job.aspect);
  const ratio = a.w / a.h;
  const source = images[0];
  const tier = tierOf(job);
  switch (job.family) {
    case "flux3":
      return {
        prompt: withLayout(prompt, job).slice(0, 15_000),
        aspect_ratio: closestRatio(ratio, FLUX_RATIOS),
        resolution: tier,
        ...(images.length ? { images: images.slice(0, 10) } : {}),
      };
    case "openai": {
      const size = tier === "1k" ? { width: job.width, height: job.height } : tierSize(ratio, tier, [655_360, 8_294_400]);
      return {
        prompt,
        ...(images.length ? { image: images.slice(0, 16) } : {}),
        size: `${size.width}x${size.height}`,
        quality: "high",
        n: 1,
        output_format: "png",
      };
    }
    case "gemini":
      return {
        contents: [
          {
            role: "user",
            parts: [
              { text: prompt },
              ...images.slice(0, 14).map((d) => ({ inlineData: { mimeType: d.slice(5, d.indexOf(";")), data: rawBase64(d) } })),
            ],
          },
        ],
        generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: closestRatio(ratio, GEMINI_RATIOS), imageSize: tier.toUpperCase() } },
      };
    case "seedream":
      return {
        prompt,
        ...(images.length ? { image: images.length === 1 ? images[0] : images.slice(0, 10) } : {}),
        size: tier === "1k" ? "1K" : "2K",
        watermark: false,
        response_format: "url",
        output_format: "png",
      };
    case "qwen":
      return {
        input: { messages: [{ role: "user", content: [...images.slice(0, 3).map((image) => ({ image })), { text: prompt }] }] },
        parameters: { n: 1, watermark: false, prompt_extend: false, size: (({ width, height }) => `${width}*${height}`)(tierSize(ratio, tier === "1k" ? "1k" : "2k", [262_144, 6_553_600])) },
      };
    case "grok-router":
      return { prompt, aspect_ratio: closestRatio(ratio, GROK_RATIOS), resolution: tier === "1k" ? "1k" : "2k", n: 1 };
    case "crystal":
      return { image_url: source, scale_factor: job.options?.scale ?? 2, creativity: job.options?.creativity ?? 0, output_format: "png" };
    case "freepik-precision":
      return { image: rawBase64(source), scale_factor: job.options?.scale ?? 2, flavor: job.options?.flavor ?? "photo" };
    case "wavespeed-upscale":
      return { image: source, target_resolution: (job.options?.scale ?? 2) >= 4 ? "4k" : "2k", output_format: "png" };
    case "bria-upscale":
      return { image: rawBase64(source), desired_increase: (job.options?.scale ?? 2) >= 4 ? 4 : 2 };
    case "bria-expand": {
      const t = aspectById(job.options?.targetAspect ?? job.aspect);
      return { image: rawBase64(source), aspect_ratio: closestRatio(t.w / t.h, BRIA_RATIOS), ...(prompt ? { prompt } : {}) };
    }
    default:
      throw new EngineError(`Crackio doesn't know how to call ${job.model} yet.`, "Pick another model.");
  }
}

async function runOnce(job: EngineJob, prompt: string, images: string[], signal: AbortSignal): Promise<EngineOutput[]> {
  const body = buildBody(job, prompt, images);
  // The request is kept with the take (server/recipes), pictures as a note of their size.
  const result = await recorded({ kind: "router", name: job.model, endpoint: job.model, request: lean(body) }, () => comfy.models.run(job.model, body, { signal, timeoutMs: TIMEOUT_MS }));
  if (result.kind === "binary") return [{ data: Buffer.from(result.data), mime: result.contentType || "image/png" }];
  const media = extractMedia(result.data);
  if (!media.length) throw new EngineError(`${job.model} answered without an image.`, "Try again, or pick another model.");
  return Promise.all(media.map((m) => fetchOutput(m, signal, "Comfy Router")));
}

/* ------------------------------------------------------------------ any catalog model */

/** A clip as a URL Router models can fetch: uploaded to your Comfy assets, signed for a few hours. */
async function assetUrl(data: Buffer, mime: string, name: string, key: string, signal: AbortSignal) {
  try {
    const client = new Comfy({ apiKey: key, clientInfo: "crackio" });
    const asset = client.assets.fromBytes(new Uint8Array(data), { filename: name, contentType: mime });
    return (await asset.getDownloadUrl(signal)).url;
  } catch (err) {
    throw new EngineError(`Couldn't upload the clip to Comfy: ${(err as Error).message}`, "This model needs the clip as a link; try a shorter clip, or another model.");
  }
}

/** Queue the job (with its place in line) and wait for it; null when the queue isn't on for this account. */
async function queued(model: string, input: Record<string, unknown>, ctx: EngineContext, expectedMs: number): Promise<RunResult | null> {
  let stop: (() => void) | null = null;
  try {
    return await comfy.models.subscribe(model, input, {
      signal: ctx.signal,
      timeoutMs: 40 * 60_000,
      onQueueUpdate: (u) => {
        if (u.status === "IN_QUEUE") ctx.progress(0.1, u.queuePosition ? `In Comfy's queue · ${u.queuePosition} ahead` : "Starting on Comfy");
        else if (u.status === "IN_PROGRESS" && !stop) stop = ticker(ctx.progress, expectedMs, 0.12);
      },
    });
  } catch (err) {
    if (err instanceof routerErrors.NotEnabled) return null;
    throw err;
  } finally {
    (stop as (() => void) | null)?.();
  }
}

/** The pictures or clips in a result: downloaded, keeping only the kind the model makes. */
async function collect(result: RunResult, output: "image" | "video", signal: AbortSignal): Promise<EngineOutput[]> {
  if (result.kind === "binary") return [{ data: Buffer.from(result.data), mime: result.contentType || (output === "video" ? "video/mp4" : "image/png") }];
  const found = extractMedia(result.data);
  const outs = await Promise.all(found.map((m) => fetchOutput(m, signal, "Comfy Router").catch(() => null)));
  const kept = outs.filter((o): o is EngineOutput => Boolean(o) && (output === "video" ? /^video\//.test(o!.mime) || /^application\/octet/.test(o!.mime) : /^image\//.test(o!.mime)));
  return kept.map((o) => (output === "video" && !/^video\//.test(o.mime) ? { ...o, mime: "video/mp4" } : o));
}

/**
 * Any Router model from the Custom tab, driven from its schema: settings fitted to what it allows,
 * pictures sent inline, clips uploaded to your Comfy assets, nested shapes built per family.
 */
async function runCatalogModel(job: EngineJob, ctx: EngineContext, key: string): Promise<EngineResult> {
  const info = await comfyModel(job.model);
  const caps = job.caps ?? info.caps;
  if (!caps) throw new EngineError(`Crackio couldn't read ${job.model}'s settings from Comfy.`, "Try again, or pick another model.");
  let prompt = job.prompt;
  const transform = job.kind === "upscale" || job.kind === "reframe";
  if (job.refine && !transform && caps.prompt && job.userPrompt.trim()) {
    ctx.progress(0.06, "Reading the brief");
    prompt = (await refinePrompt({ text: job.userPrompt, references: job.references, aspect: aspectById(job.aspect).id, signal: ctx.signal, kind: caps.output })).prompt;
  }
  ctx.progress(0.08, "Preparing the inputs");
  // Pictures go inline unless the model only fetches links; clips always go as links.
  const upload = async (data: Buffer, mime: string, name: string, input?: MediaInput) =>
    mime.startsWith("video/") || input?.urlOnly ? assetUrl(data, mime, name, key, ctx.signal) : `data:${mime};base64,${data.toString("base64")}`;
  const flat = await buildInput({ ...job, prompt }, caps, upload, ctx.signal);
  const family = familyFor(job.model);
  const input = family ? family.nest(job.model, flat) : flat;

  const video = caps.output === "video";
  ctx.progress(0.1, "Sending to Comfy");
  const takes = !video && !caps.count ? Math.max(1, Math.min(job.count, 4)) : 1;
  const stop = video ? null : ticker(ctx.progress, 45_000);
  try {
    const results = await Promise.all(
      Array.from({ length: takes }, async () => {
        // Clips go through the queue (place in line, no 10-minute limit); pictures run directly.
        return recorded({ kind: "router", name: job.model, endpoint: job.model, request: lean(input) }, async () => {
          const viaQueue = video ? await queued(job.model, input, ctx, 180_000) : null;
          return (
            viaQueue ??
            (await comfy.models.run(job.model, input, {
              signal: ctx.signal,
              timeoutMs: video ? 25 * 60_000 : TIMEOUT_MS,
              // Veo can answer with the clip inline as base64.
              maxBytes: /^veo\//.test(job.model) ? 512 * 1024 * 1024 : undefined,
            }))
          );
        });
      }),
    );
    ctx.progress(0.95, "Saving");
    const outputs = (await Promise.all(results.map((r) => collect(r, caps.output, ctx.signal)))).flat();
    if (!outputs.length) throw new EngineError(`${job.model} answered without ${video ? "a clip" : "an image"}.`, "Try again, or pick another model.");
    return { outputs, usedPrompt: prompt || undefined };
  } catch (err) {
    return explain(err);
  } finally {
    stop?.();
  }
}

export const comfyEngine: Engine = {
  id: "comfy-cloud",
  label: "Comfy Router",
  supports: () => true,
  async run(job, ctx) {
    ctx.progress(0.04, "Connecting to Comfy");
    const key = await apiKey();
    comfy.config({ credentials: key });
    if (job.family === "comfy-custom") return runCatalogModel(job, ctx, key);
    const a = aspectById(job.aspect);
    const isTransform = job.kind === "upscale" || job.kind === "reframe";

    let prompt = job.prompt;
    if (job.refine && !isTransform) {
      ctx.progress(0.08, "Reading the brief");
      prompt = (await refinePrompt({ text: job.userPrompt, references: job.references, aspect: a.id, signal: ctx.signal })).prompt;
    }

    const refs = isTransform ? job.references : orderedInputs(job, 16);
    // Upscalers get the source at full detail; generators get lighter references.
    const images = await Promise.all(refs.map((r) => toDataUrl(r, isTransform ? 2048 : 1536)));
    if (isTransform && !images.length) throw new EngineError("Pick an image first.");

    const stop = ticker(ctx.progress, isTransform ? 25_000 : 45_000);
    try {
      // Multi-image engines are called once per take, in parallel.
      const takes = isTransform ? 1 : Math.max(1, Math.min(job.count, 4));
      const outputs = (await Promise.all(Array.from({ length: takes }, () => runOnce(job, prompt, images, ctx.signal)))).flat();
      ctx.progress(0.95, "Saving");
      // Reframes and upscales keep their own size; generations are cropped to the frame asked for.
      const finals = isTransform ? outputs : await Promise.all(outputs.map((o) => fitAspect(o, a.w / a.h)));
      return { outputs: finals, usedPrompt: prompt || undefined };
    } catch (err) {
      explain(err);
    } finally {
      stop();
    }
  },
};
