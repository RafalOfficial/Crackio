import "server-only";
import sharp from "sharp";
import { comfy, ComfyError, routerErrors } from "@comfyorg/sdk";
import { getSettings } from "@/lib/server/settings";
import { comfyTargets, currentTarget, withTarget, type ComfyTarget } from "@/lib/server/comfy-targets";
import { installedFiles } from "@/lib/server/local-models";
import { EngineError } from "./types";

/**
 * Text through ComfyUI, the only way Crackio writes and reads. With a Comfy API key, hosted models (Claude, Gemini,
 * GPT, DeepSeek…) answer through Comfy Router's chat endpoint, paid in Comfy credits. Without one, an open model on your
 * own ComfyUI writes it with the core Generate Text node (TextGenerate), free: some picture models' text encoders are
 * whole language models (measured on the 5090: about 10 s for a rewritten prompt, model load included).
 */

/**
 * Open language models Generate Text runs well, best first. `vision`: it reads a picture too. Qwen3-VL 4B is FLUX 3
 * Klein's own text encoder (loaded as "ltxv"), so it's there wherever Klein is: the pictures' reader first.
 */
export const LOCAL_LLMS = [
  { file: "qwen3.5_9b_w4a8_gptq.safetensors", name: "Qwen 3.5 9B", vision: false },
  { file: "qwen3vl_4b_int8_convrot.safetensors", name: "Qwen3-VL 4B", vision: true },
  { file: "qwen3vl_8b_int8_convrot.safetensors", name: "Qwen3-VL 8B", vision: true },
  { file: "qwen_3_4b.safetensors", name: "Qwen 3 4B", vision: false },
] as const;

type LocalLlm = (typeof LOCAL_LLMS)[number];

type Found = { target: ComfyTarget; llm: LocalLlm } | null;
const picked = new Map<boolean, { at: number; found: Found; eight: boolean }>();

/**
 * The ComfyUI Crackio knows with a language model on it (one that reads pictures when `vision`), or null. With several,
 * the one with the biggest card: a 6 GB card takes a minute over what a 5090 writes in seconds. Asked often (every model
 * list), so the answer is kept for half a minute.
 */
export async function localLlm(vision = false): Promise<Found> {
  // Pictures: the Qwen3-VL picked in Settings (4B unless 8B) first.
  const eight = vision && (await getSettings()).localVision === "8b";
  const hit = picked.get(vision);
  if (hit && Date.now() - hit.at < 30_000 && hit.eight === eight) return hit.found;
  const vl = (l: LocalLlm) => (l.vision ? (eight ? !l.file.includes("_4b") : l.file.includes("_4b")) : false);
  const wanted = LOCAL_LLMS.filter((l) => !vision || l.vision).sort((a, b) => Number(vl(b)) - Number(vl(a)));
  const found: { target: ComfyTarget; llm: LocalLlm; vram: number }[] = [];
  for (const target of await comfyTargets().catch(() => [])) {
    const have = await withTarget(target, () => installedFiles()).catch(() => new Set<string>());
    const llm = wanted.find((l) => have.has(`text_encoders/${l.file}`));
    if (llm) found.push({ target, llm, vram: await withTarget(target, () => vramGb()) });
  }
  found.sort((a, b) => b.vram - a.vram || LOCAL_LLMS.indexOf(a.llm) - LOCAL_LLMS.indexOf(b.llm));
  const best: Found = found[0] ? { target: found[0].target, llm: found[0].llm } : null;
  picked.set(vision, { at: Date.now(), found: best, eight });
  return best;
}

/** Each ComfyUI's card memory as last seen: a box busy rendering can miss the question, and shouldn't lose its turn for it. */
const vramSeen = new Map<string, number>();

/** The current ComfyUI's NVIDIA card memory in GB; 0 on a Mac or a CPU, or when it has never answered. */
async function vramGb() {
  const id = currentTarget().id;
  try {
    const res = await call("/system_stats", { signal: AbortSignal.timeout(6000) });
    const stats = (await res.json()) as { devices?: { type?: string; vram_total?: number }[] };
    const dev = stats.devices?.[0];
    const gb = dev?.type === "cuda" && dev.vram_total ? dev.vram_total / 1024 ** 3 : 0;
    vramSeen.set(id, gb);
    return gb;
  } catch {
    return vramSeen.get(id) ?? 0;
  }
}

async function call(route: string, init: RequestInit & { signal: AbortSignal }) {
  const t = currentTarget();
  const headers = new Headers(init.headers);
  if (t.token) headers.set("Authorization", `Bearer ${t.token}`);
  try {
    return await fetch(`${t.url}${route}`, { ...init, headers, cache: "no-store" });
  } catch (err) {
    if (init.signal.aborted) throw err;
    throw new EngineError(`ComfyUI isn't answering at ${t.url}.`, "Check that the machine and its ComfyUI are running.");
  }
}

/** Hands ComfyUI a picture for LoadImage; returns its name there. */
async function upload(data: Buffer, signal: AbortSignal) {
  const form = new FormData();
  form.append("image", new Blob([new Uint8Array(data)]), `crackio-text-${Date.now()}.png`);
  form.append("overwrite", "true");
  const res = await call("/upload/image", { method: "POST", body: form, signal });
  const j = (await res.json().catch(() => ({}))) as { name?: string; subfolder?: string };
  if (!res.ok || !j.name) throw new EngineError("ComfyUI didn't take the picture.");
  return j.subfolder ? `${j.subfolder}/${j.name}` : j.name;
}

type History = { status?: { status_str?: string; messages?: [string, { exception_message?: string }][] }; outputs?: Record<string, { text?: unknown[] }> };

/** "Image 3" over a picture's cell, white on the sheet's dark ground. */
const label = (text: string, width: number, height: number) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><text x="${Math.round(height * 0.3)}" y="${Math.round(height * 0.74)}" font-family="Arial, Helvetica, sans-serif" font-size="${Math.round(height * 0.6)}" font-weight="700" fill="#ffffff">${text}</text></svg>`,
  );

/**
 * Several pictures as one contact sheet about 1 MP in all, for a model that reads one: side by side for two or three, then
 * a grid. Each sits whole in its cell under a band that says "Image 1", "Image 2"…, left to right, then top to bottom.
 */
async function contactSheet(images: Buffer[]) {
  const cols = images.length <= 3 ? images.length : Math.ceil(Math.sqrt(images.length));
  const rows = Math.ceil(images.length / cols);
  const cell = Math.floor(Math.sqrt(1_000_000 / (cols * rows)));
  const band = Math.max(28, Math.round(cell * 0.08));
  const pad = Math.round(cell * 0.02);
  const parts = await Promise.all(
    images.map(async (image, i) => {
      const { data, info } = await sharp(image).rotate().resize(cell - 2 * pad, cell - band - 2 * pad, { fit: "inside" }).png().toBuffer({ resolveWithObject: true });
      const x = (i % cols) * cell;
      const y = Math.floor(i / cols) * cell;
      return [
        { input: label(`Image ${i + 1}`, cell, band), left: x, top: y },
        { input: data, left: x + Math.round((cell - info.width) / 2), top: y + band + pad + Math.round((cell - band - 2 * pad - info.height) / 2) },
      ];
    }),
  );
  return sharp({ create: { width: cols * cell, height: rows * cell, channels: 3, background: "#1b1a1f" } })
    .composite(parts.flat())
    .png()
    .toBuffer();
}

/** What the model is told about a contact sheet, so "image 2" in the request finds its picture. */
const sheetNote = (n: number) =>
  n === 2
    ? `The attached picture shows 2 pictures side by side, each labelled at its top: "Image 1" on the left, "Image 2" on the right. "Image 1" and "Image 2" below mean those two.`
    : `The attached picture is a contact sheet of ${n} pictures, each labelled at its top: "Image 1" to "Image ${n}", left to right, then top to bottom. "Image 1", "Image 2" and so on below mean those pictures.`;

/**
 * One answer from an open model on your ComfyUI. Pictures go only to a model that reads them, and Generate Text takes one:
 * several become one labelled contact sheet (see contactSheet), and the prompt says how they're numbered. It goes to the
 * front of ComfyUI's line: a few seconds of text shouldn't wait out a render.
 */
export async function localText(input: { system: string; prompt: string; images?: Buffer[]; maxTokens?: number; signal: AbortSignal }): Promise<string> {
  const found = (input.images?.length ? await localLlm(true) : null) ?? (await localLlm());
  if (!found) throw new EngineError("No language model on your ComfyUI yet.", `Put ${LOCAL_LLMS[0].name} or ${LOCAL_LLMS[1].name} in its text_encoders folder, or add a Comfy API key in Connections.`);
  return withTarget(found.target, async () => {
    const { signal } = input;
    const pictures = found.llm.vision ? (input.images ?? []) : [];
    const prompt = pictures.length > 1 ? `${sheetNote(pictures.length)}\n\n${input.prompt}` : input.prompt;
    const graph: Record<string, { class_type: string; inputs: Record<string, unknown> }> = {
      llm: { class_type: "CLIPLoader", inputs: { clip_name: found.llm.file, type: "ltxv", device: "default" } },
      system: { class_type: "PrimitiveStringMultiline", inputs: { value: input.system } },
      write: {
        class_type: "TextGenerate",
        inputs: { clip: ["llm", 0], prompt, max_length: input.maxTokens ?? 2048, sampling_mode: "off", system_prompt: ["system", 0], use_default_template: true, thinking: false },
      },
      out: { class_type: "PreviewAny", inputs: { source: ["write", 0] } },
    };
    if (pictures.length) {
      graph.picture = { class_type: "LoadImage", inputs: { image: await upload(pictures.length > 1 ? await contactSheet(pictures) : pictures[0], signal) } };
      graph.write.inputs.image = ["picture", 0];
    }
    const sent = await call("/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: graph, front: true, extra_data: { crackio: { model: found.llm.name } } }),
      signal,
    });
    const { prompt_id: id, error } = (await sent.json().catch(() => ({}))) as { prompt_id?: string; error?: { message?: string } };
    if (!sent.ok || !id) throw new EngineError(`ComfyUI turned the text job down${error?.message ? `: ${error.message}` : ""}.`);
    // Given up on: out of the line if it's still waiting (behind someone's render), stopped if it's running.
    const post = (route: string, payload: unknown) =>
      call(route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: new AbortController().signal }).catch(() => undefined);
    const stop = () => void Promise.all([post("/queue", { delete: [id] }), post("/interrupt", { prompt_id: id })]);
    signal.addEventListener("abort", stop, { once: true });
    try {
      for (;;) {
        await new Promise((r) => setTimeout(r, 800));
        if (signal.aborted) throw new EngineError("Cancelled.");
        const entry = ((await (await call(`/history/${id}`, { signal })).json()) as Record<string, History>)[id];
        if (entry?.status?.status_str === "error") {
          const err = entry.status.messages?.find(([kind]) => kind === "execution_error")?.[1];
          throw new EngineError(`ComfyUI couldn't write it: ${(err?.exception_message ?? "unknown error").trim().slice(0, 300)}`);
        }
        if (entry?.status?.status_str === "success") {
          const text = entry.outputs?.out?.text?.find((t): t is string => typeof t === "string") ?? "";
          // A thinking model can lead with its reasoning; the answer is what follows it.
          return text.replace(/^[\s\S]*<\/think>/, "").trim();
        }
      }
    } finally {
      signal.removeEventListener("abort", stop);
    }
  });
}

/* ---------------------------------------------------------------- Comfy Router */

export type ChatData = {
  choices?: { message?: { content?: string | null; tool_calls?: { id: string; type?: string; function: { name: string; arguments: string } }[] } }[];
};

export async function comfyTextKey() {
  return (await getSettings()).keys.comfy || process.env.COMFY_API_KEY || null;
}

/** One chat completion through Comfy Router (OpenRouter's request and answer, unchanged): tools work as they do there. */
export async function routerChat(body: Record<string, unknown>, signal: AbortSignal, what = "Comfy"): Promise<ChatData> {
  const key = await comfyTextKey();
  if (!key) throw new EngineError("No Comfy API key is set.", "Add one in Connections (platform.comfy.org → API keys).");
  comfy.config({ credentials: key });
  try {
    const result = await comfy.models.run("openrouter/chat-completions", body, { signal, timeoutMs: 600_000 });
    if (result.kind !== "json") throw new EngineError(`${what} answered without text.`, "Try again, or pick another model.");
    return result.data as ChatData;
  } catch (err) {
    if (err instanceof EngineError || signal.aborted) throw err;
    const routed = err instanceof routerErrors.RouterError;
    if (err instanceof ComfyError || routed) {
      const e = err as { message: string; httpStatus?: number | null; code?: string; errorType?: string };
      const code = (routed ? e.errorType : e.code) ?? "";
      if (/^unauthorized$/i.test(code) || e.httpStatus === 401) throw new EngineError("Comfy rejected the API key.", "Check the key in Connections, or create a new one at platform.comfy.org.");
      if (/insufficient_credits/i.test(code) || e.httpStatus === 402) throw new EngineError("Your Comfy workspace is out of credits.", "Add credits at platform.comfy.org, or pick another model.");
      if (/rate_limited|concurrency|queue_backlog/i.test(code) || e.httpStatus === 429) throw new EngineError("Comfy is busy right now.", "Wait a moment and try again.");
      throw new EngineError(`${what} didn't answer: ${e.message}`, "Try again, or pick another model.");
    }
    throw new EngineError(`${what} didn't answer: ${(err as Error).message}`, "Try again, or pick another model.");
  }
}

/** One answer from a hosted model on your Comfy key; `images` are data URLs. */
export async function routerText(input: { model: string; system: string; prompt: string; images?: string[]; what?: string; signal: AbortSignal }): Promise<string> {
  const content = input.images?.length ? [{ type: "text", text: input.prompt }, ...input.images.map((url) => ({ type: "image_url", image_url: { url } }))] : input.prompt;
  const data = await routerChat({ model: input.model, messages: [{ role: "system", content: input.system }, { role: "user", content }] }, input.signal, input.what);
  return (data.choices?.[0]?.message?.content ?? "").trim();
}
