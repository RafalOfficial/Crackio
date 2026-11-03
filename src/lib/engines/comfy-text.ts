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
  if (!found) throw new EngineError("No language model on your ComfyUI yet.", `Put ${LOCAL_LLMS[0].name} or ${LOCAL_LLMS[1].name} in its text_encoders folder, or add a Comfy API key in Settings → Accounts.`);
  return withTarget(found.target, async () => {
    const { signal } = input;
    const pictures = found.llm.vision ? (input.images ?? []) : [];
    const prompt = pictures.length > 1 ? `${sheetNote(pictures.length)}\n\n${input.prompt}` : input.prompt;
    const graph: Graph = {
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
    return answer(graph, found.llm.name, signal);
  });
}

type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;

/**
 * The text a graph's PreviewAny node "out" shows, from the current ComfyUI. It goes to the front of ComfyUI's line: a
 * few seconds of text shouldn't wait out a render.
 */
async function answer(graph: Graph, model: string, signal: AbortSignal) {
  const sent = await call("/prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: graph, front: true, extra_data: { crackio: { model } } }),
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
    // A small model answers in well under a second: look often at first.
    for (let wait = 150; ; wait = Math.min(800, wait * 1.5)) {
      await new Promise((r) => setTimeout(r, wait));
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
}

/* ---------------------------------------------------------------- LFM3-VL */

/**
 * Liquid AI's LFM3-VL 2B (LFM Open License: free under $10M a year in revenue), run by the Crackio bridge's node
 * (comfyui/crackio_bridge/lfm3.py) from models/lfm3. It reads each picture at its own size, so several go in as they are
 * (no contact sheet), and answers a check in about half a second on an RTX 5090. `judge` is Crackio's own fine-tune
 * for swap checks (a LoRA on top).
 */
/** Crackio's fine-tunes of LFM3-VL, by their name in the bridge: the swap judge, Retouch's eyes, and the voice in Talk. */
export type Lfm3Lora = "none" | "judge" | "retouch" | "chat";
export const LFM3 = { file: "lfm3-vl-2b.safetensors", lora: (name: Exclude<Lfm3Lora, "none">) => `lfm3-vl-2b-lora-${name}.safetensors`, name: "LFM3-VL 2B" };
/** The fine-tune a catalog LFM3 model runs with (local:lfm3-judge → judge). */
export const lfm3LoraOf = (model: string): Lfm3Lora => (model === "lfm3-judge" ? "judge" : model === "lfm3-retouch" ? "retouch" : "none");

// On globalThis: the server's start-up (refine's warmTextModels) and its requests load this module apart. `gen` counts
// forgetLfm3() calls, so a look that started before one doesn't write back what it saw.
const lfm3State = ((globalThis as unknown as { __crackioLfm3?: { seen: Map<string, { at: number; target: ComfyTarget | null }>; looking: Map<string, Promise<ComfyTarget | null>>; gen?: number } }).__crackioLfm3 ??= {
  seen: new Map(),
  looking: new Map(),
  gen: 0,
});
const lfm3Seen = lfm3State.seen;

/** Forget which machines have LFM3 and its fine-tunes (a setup just put them on one): the next question looks again. */
export function forgetLfm3() {
  lfm3State.gen = (lfm3State.gen ?? 0) + 1;
  lfm3Seen.clear();
  lfm3Looking.clear();
}

/** The files in the current ComfyUI's models/lfm3 (the bridge adds that folder), asked of ComfyUI itself. */
async function lfm3Files() {
  try {
    const res = await call("/models/lfm3", { signal: AbortSignal.timeout(6000) });
    return new Set(res.ok ? ((await res.json()) as string[]) : []);
  } catch {
    return new Set<string>();
  }
}

/** The ComfyUI with LFM3-VL (and the fine-tune asked for) on it, the biggest card first; null when none has it. */
export async function lfm3Machine(lora: Lfm3Lora = "none"): Promise<ComfyTarget | null> {
  // Known for 30 s; a machine found stays the answer up to 10 minutes while a new look runs behind it (looked for one by
  // one, three switched-off machines held every Retouch picture up 5 s). A machine that stops answering is forgotten
  // (lfm3Text), and the next question looks again.
  const hit = lfm3Seen.get(lora);
  const age = hit ? Date.now() - hit.at : Infinity;
  if (hit && age < 30_000) return hit.target;
  const look = lfm3Looking.get(lora) ?? lookForLfm3(lora);
  if (hit?.target && age < 600_000) return hit.target;
  return look;
}

const lfm3Looking = lfm3State.looking;

/** Every machine that could have LFM3 asked at once (not RunPod's or Comfy Cloud's, which have no Crackio bridge). */
function lookForLfm3(lora: Lfm3Lora): Promise<ComfyTarget | null> {
  const gen = lfm3State.gen;
  const look = (async () => {
    const targets = (await comfyTargets().catch(() => [])).filter((t) => !t.serverless && !t.metered);
    const found = await Promise.all(
      targets.map(async (target) => {
        const have = await withTarget(target, () => lfm3Files());
        if (!have.has(LFM3.file) || (lora !== "none" && !have.has(LFM3.lora(lora)))) return null;
        return { target, vram: await withTarget(target, () => vramGb()) };
      }),
    );
    const target = found.filter((f) => f !== null).sort((a, b) => b.vram - a.vram)[0]?.target ?? null;
    if (lfm3State.gen === gen) lfm3Seen.set(lora, { at: Date.now(), target });
    return target;
  })().finally(() => {
    if (lfm3Looking.get(lora) === look) lfm3Looking.delete(lora);
  });
  lfm3Looking.set(lora, look);
  return look;
}

/**
 * Who Talk's voice is: a person with a life of their own (the user's pick), named after the voice, who says they're an AI
 * only when asked straight out. The chat fine-tune learns its replies under this prompt, names varied.
 */
const chatStyle = (name?: string) =>
  `You're ${name ? `${name}, ` : ""}talking out loud with someone. Sound like a real person with your own life, opinions and sense of humor: short, warm and natural, the right length for what they said (a few words for a few words). Remember what they told you earlier and bring it back when it fits. Only say you're an AI if they ask you straight out. No lists, no emojis, no formatting.`;

/**
 * The next reply in a spoken conversation (Voice's Talk mode): `history` is the conversation so far, the last turn
 * theirs, with any pictures shown in it; `onText` gets the reply so far as it's written. Aborting `signal` stops it: the
 * bridge stops writing at the next token. `name`: who's talking (the voice's name). The chat fine-tune answers where it's
 * installed.
 */
export async function lfm3Chat(input: {
  history: { role: "user" | "assistant"; text: string; images?: Buffer[] }[];
  name?: string;
  system?: string;
  lora?: Lfm3Lora;
  onText?: (soFar: string) => void;
  maxTokens?: number;
  signal: AbortSignal;
}): Promise<string> {
  const lora = input.lora ?? ((await lfm3Machine("chat").catch(() => null)) ? "chat" : "none");
  const target = await lfm3Machine(lora);
  if (!target) throw new EngineError(`${LFM3.name} isn't on any of your ComfyUIs yet.`, "Set up Talk in Settings → Tools (Voice) to get it.");
  const picture = async (b: Buffer) => (await sharp(b).resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer()).toString("base64");
  const history = await Promise.all(
    input.history.slice(-40).map(async (t) => ({ role: t.role, text: t.text, ...(t.images?.length ? { images: await Promise.all(t.images.slice(0, 4).map(picture)) } : {}) })),
  );
  const body = { system: input.system ?? chatStyle(input.name?.trim() || undefined), history, max_tokens: input.maxTokens ?? 160, lora };
  const asked = withTarget(target, async () => {
    if (input.onText) {
      const streamed = await lfm3Stream(body, input.onText, input.signal);
      if (streamed !== null) return streamed;
    }
    const res = await call("/crackio/lfm3", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: input.signal });
    const j = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
    if (!res.ok || typeof j.text !== "string") throw new EngineError(`${LFM3.name} couldn't answer: ${j.error ?? `status ${res.status}`}`);
    return j.text.trim();
  });
  return asked.catch((err: Error) => {
    if (/isn't answering/.test(err.message)) lfm3Seen.clear();
    throw err;
  });
}

/**
 * The bridge's answer as it's written (its server-sent events: {"text": what's new} and then {"done", "text"}), handed
 * to `onText` as the text so far. Null when the bridge has no such route (an older one): ask the plain way then.
 */
const EVENT_END = "\n\n";

async function lfm3Stream(body: Record<string, unknown>, onText: (soFar: string) => void, signal: AbortSignal): Promise<string | null> {
  const res = await call("/crackio/lfm3/stream", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal }).catch(() => null);
  if (!res || res.status === 404 || res.status === 405 || !res.body) {
    const j = res ? ((await res.json().catch(() => ({}))) as { error?: string }) : {};
    if (res?.status === 404 && j.error) throw new EngineError(`${LFM3.name} couldn't answer: ${j.error}`);
    return null;
  }
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    throw new EngineError(`${LFM3.name} couldn't answer: ${j.error ?? `status ${res.status}`}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut: number;
    while ((cut = buffer.indexOf(EVENT_END)) >= 0) {
      const line = buffer.slice(0, cut).trim();
      buffer = buffer.slice(cut + 2);
      if (!line.startsWith("data:")) continue;
      const event = JSON.parse(line.slice(5)) as { text?: string; restart?: boolean; done?: boolean; error?: string };
      if (event.done) {
        if (event.error) throw new EngineError(`${LFM3.name} couldn't answer: ${event.error}`);
        return (event.text ?? text).trim();
      }
      text = event.restart ? (event.text ?? "") : text + (event.text ?? "");
      onText(text);
    }
  }
  throw new EngineError(`${LFM3.name} stopped answering halfway.`);
}

/** One answer from LFM3-VL: each picture its own input, at its own size. `odds` (bridge 1.8.4+, not through the node): JSON
 * keys answered true or false, and where to report how likely "true" was at each. */
export async function lfm3Text(input: {
  system: string;
  prompt: string;
  images?: Buffer[];
  maxTokens?: number;
  thinking?: boolean;
  lora?: Lfm3Lora;
  odds?: { keys: string[]; got: (odds: Record<string, number>) => void };
  /** The answer so far, as it's written (a bridge with /crackio/lfm3/stream; not with odds or thinking). */
  onText?: (soFar: string) => void;
  signal: AbortSignal;
}): Promise<string> {
  const lora = input.lora ?? "none";
  const target = await lfm3Machine(lora);
  if (!target) throw new EngineError(`${LFM3.name} isn't on any of your ComfyUIs yet.`, "Set LFM3-VL up in Settings → Tools (it comes with Voice → Talk).");
  const asked = withTarget(target, async () => {
    // The bridge's own route first (1.8.2+): outside ComfyUI's prompt queue, so a swap's check doesn't wait behind the
    // FLUX redraw that's running (queued, checks took 8-23 s). An older bridge only has the node.
    const pictures = (input.images ?? []).slice(0, 6).map((b) => b.toString("base64"));
    if (input.onText && !input.odds && !input.thinking) {
      const streamed = await lfm3Stream({ prompt: input.prompt, system: input.system, images: pictures, max_tokens: input.maxTokens ?? 2048, lora }, input.onText, input.signal);
      if (streamed !== null) return streamed;
    }
    const direct = await call("/crackio/lfm3", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: input.prompt, system: input.system, images: pictures, thinking: input.thinking ?? false, max_tokens: input.maxTokens ?? 2048, lora, odds: input.odds?.keys }),
      signal: input.signal,
    }).catch(() => null);
    if (direct && direct.status !== 404 && direct.status !== 405) {
      const j = (await direct.json().catch(() => ({}))) as { text?: string; error?: string; odds?: Record<string, number> };
      if (direct.ok && typeof j.text === "string") {
        if (j.odds && Object.keys(j.odds).length) input.odds?.got(j.odds);
        return j.text.replace(/^[\s\S]*<\/think>/, "").trim();
      }
      throw new EngineError(`${LFM3.name} couldn't answer: ${j.error ?? `status ${direct.status}`}`);
    }
    const ask = { prompt: input.prompt, system: input.system, thinking: input.thinking ?? false, max_tokens: input.maxTokens ?? 2048, lora, sampling: "greedy", seed: 0 };
    const graph: Graph = { ask: { class_type: "CrackioLFM3", inputs: ask }, out: { class_type: "PreviewAny", inputs: { source: ["ask", 0] } } };
    const names = await Promise.all((input.images ?? []).slice(0, 6).map((picture) => upload(picture, input.signal)));
    for (const [k, name] of names.entries()) {
      graph[`p${k + 1}`] = { class_type: "LoadImage", inputs: { image: name } };
      graph.ask.inputs[`image_${k + 1}`] = [`p${k + 1}`, 0];
    }
    return answer(graph, lora === "none" ? LFM3.name : `${LFM3.name} ${lora}`, input.signal);
  });
  // A machine that stopped answering is looked for again on the next question (lfm3Machine keeps one up to 10 minutes).
  return asked.catch((err: Error) => {
    if (/isn't answering/.test(err.message)) lfm3Seen.clear();
    throw err;
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
  if (!key) throw new EngineError("No Comfy API key is set.", "Add one in Settings → Accounts (platform.comfy.org → API keys).");
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
      if (/^unauthorized$/i.test(code) || e.httpStatus === 401) throw new EngineError("Comfy rejected the API key.", "Check the key in Settings → Accounts, or create a new one at platform.comfy.org.");
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
