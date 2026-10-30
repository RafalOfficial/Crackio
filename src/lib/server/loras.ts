import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import CATALOG from "@/lib/local/lora-catalog.json";
import { autoTrigger, loraFileName, loraUrl, stricter, takesLoras, type LoraCategory, type LoraEntry, type LoraFile, type LoraLibrary, type LoraRecord } from "@/lib/local/loras";
import type { LocalModel } from "@/lib/local/types";
import { allLocalModels } from "./local-templates";
import { installFile, LocalError, removeFile } from "./local-models";
import { DATA_DIR } from "./paths";
import { writeFileAtomic } from "./atomic-write";

/**
 * The LoRA library on the server: Crackio's checked picks for each open model (lib/local/lora-catalog.json), a Hugging Face
 * search for the rest, downloads into a ComfyUI's models/loras (local-models `installFile`, through its bridge or straight
 * to disk), and a record of what each downloaded file is (data/loras.json): the model it's for, its trigger words and
 * strength, so a job that carries it is drawn right (engines/comfy-local `lorasOf`).
 */

const RECORDS = path.join(DATA_DIR, "loras.json");
const HF = "https://huggingface.co/api";

const g = globalThis as unknown as {
  __crackioLoraRecords?: Promise<Record<string, LoraRecord>>;
  __crackioLoraWrites?: Promise<unknown>;
  __crackioLoraSearch?: Map<string, { at: number; value: Promise<unknown> }>;
};

const model = (id: string) => allLocalModels().find((m) => m.id === id) ?? null;

/* ------------------------------------------------------------------ Crackio's picks */

type Catalog = { entries: LoraEntry[]; bases: Record<string, string[]> };
const catalog = CATALOG as unknown as Catalog;

let picks: LoraEntry[] | null = null;

/** Crackio's checked LoRAs, each with the file names it gets in models/loras. */
export function curated(): LoraEntry[] {
  return (picks ??= catalog.entries
    .filter((e) => e.files?.length && e.repo && e.models?.length)
    .map((e) => ({ ...e, range: e.range ?? [0, 1.5], strength: e.strength ?? 1, local: e.files.map((f) => loraFileName(e.repo, f.path)) })));
}

/** Hugging Face base repos whose LoRAs fit a model, best first. */
export function basesFor(modelId: string): string[] {
  return catalog.bases[modelId] ?? [];
}

/* ------------------------------------------------------------------ what each downloaded file is */

async function readRecords(): Promise<Record<string, LoraRecord>> {
  return (g.__crackioLoraRecords ??= fs
    .readFile(RECORDS, "utf8")
    .then((text) => JSON.parse(text) as Record<string, LoraRecord>)
    .catch(() => ({})));
}

/** Records changed one after another, never two writes at once. */
function changeRecords(change: (all: Record<string, LoraRecord>) => void) {
  const next = (g.__crackioLoraWrites ?? Promise.resolve()).then(async () => {
    const all = { ...(await readRecords()) };
    change(all);
    g.__crackioLoraRecords = Promise.resolve(all);
    await fs.mkdir(DATA_DIR, { recursive: true });
    await writeFileAtomic(RECORDS, JSON.stringify(all, null, 1));
  });
  g.__crackioLoraWrites = next.catch(() => undefined);
  return next;
}

/** Everything the library pages show: the picks, each model's search bases, and what every downloaded file is. */
export async function loraLibrary(): Promise<LoraLibrary> {
  return { entries: curated(), bases: catalog.bases, records: await readRecords() };
}

/**
 * What the engine needs to know of a LoRA file by its name: the words that wake it (put in the prompt after the brief is
 * written) and the one of a graph's models it goes on (a Wan 2.2 pair's halves). From the picks and from what was downloaded.
 */
export async function loraMeta(): Promise<Map<string, LoraMeta>> {
  const out = new Map<string, LoraMeta>();
  for (const e of curated()) e.files.forEach((f, i) => out.set(e.local![i], { trigger: autoTrigger(e.trigger), match: f.match, end: e.triggerAt === "end" }));
  for (const r of Object.values(await readRecords())) if (!out.has(r.file)) out.set(r.file, { trigger: autoTrigger(r.trigger), match: r.match, end: r.triggerAt === "end" });
  return out;
}

/** A LoRA file's words (`end`: they go last in the prompt) and the one of a graph's models it goes on. */
export type LoraMeta = { trigger?: string; match?: string; end?: boolean };

/* ------------------------------------------------------------------ Hugging Face */

async function hf<T>(pathname: string): Promise<T> {
  const res = await fetch(`${HF}${pathname}`, { headers: { "User-Agent": "crackio" }, cache: "no-store", signal: AbortSignal.timeout(15_000) });
  if (res.status === 429) throw new LocalError("Hugging Face asks to slow down: try again in a minute.", 429);
  if (!res.ok) throw new LocalError(`Hugging Face answered ${res.status}.`, 502);
  return (await res.json()) as T;
}

/** Asked again at most every 10 minutes: a search typed twice, or every model page opening, costs Hugging Face once. */
function cached<T>(key: string, ask: () => Promise<T>): Promise<T> {
  const cache = (g.__crackioLoraSearch ??= new Map());
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.value as Promise<T>;
  const value = ask();
  cache.set(key, { at: Date.now(), value });
  value.catch(() => cache.delete(key));
  if (cache.size > 300) cache.delete(cache.keys().next().value!);
  return value;
}

/**
 * What a library page never lists from a search: adult LoRAs and filter bypasses, real people (celebrities, likeness and
 * face swaps), and other people's characters, brands and named styles. A list can't catch everything, so found LoRAs are
 * marked as unchecked and show no pictures.
 */
const ADULT =
  /nsfw|nud(e|ity)|naked|porn|hentai|\bsex|erotic|lewd|uncensor|censor|bypass|refusal|abliterat|lingerie|bikini|swimsuit|boob|breast|nipple|\bass\b|butt|thicc|\bfeet\b|pussy|penis|genital|\bcum\b|bdsm|fetish|onlyfans|undress|topless|seduc|ahegao|yiff|futa|\bloli|shota|waifu|\bhot\b|sexy|busty|cleavage|\bboudoir/i;
const PEOPLE = /celeb|actress|\bactor\b|influencer|face.?swap|deepfake|likeness|instagram|tiktok|\bidol\b|kpop|k-pop|\bbfs\b|head.?swap|identity/i;
const IP =
  /pok[eé]mon|pikachu|marvel|disney|pixar|ghibli|star.?wars|naruto|one.?piece|dragon.?ball|simpsons|spider.?man|batman|superman|mickey|barbie|harry.?potter|genshin|zelda|\bmario\b|sonic|minecraft|fortnite|\blego\b|nintendo|arcane|jojo|evangelion|gundam|sailor.?moon|titan|demon.?slayer|jujutsu|chainsaw|frozen|shrek|transformers|warhammer|league.?of.?legends|overwatch|valorant|hello.?kitty|dreamworks|south.?park|rick.?and.?morty|wes.?anderson|tim.?burton|van.?gogh|mucha|giger|miyazaki|makoto.?shinkai|ufotable|cyberpunk.?2077|elden.?ring|final.?fantasy|resident.?evil|the.?witcher|gta|halo|street.?fighter|tekken|mortal.?kombat|bluey|peppa|spongebob|avatar|game.?of.?thrones|lord.?of.?the.?rings|stranger.?things/i;

export function blocked(text: string, tags: string[] = []) {
  return tags.includes("not-for-all-audiences") || ADULT.test(text) || PEOPLE.test(text) || IP.test(text);
}

/** A licence id from a model card, as what it allows. */
function licenceLevel(id: string | undefined): LoraEntry["licence"]["commercial"] {
  if (!id) return "no";
  if (/^(apache-2\.0|mit|bsd.*|cc0.*|cc-by-4\.0|cc-by-sa-4\.0|openrail\+\+|creativeml-openrail-m|openrail|unlicense|artistic-2\.0|wtfpl)$/i.test(id)) return "yes";
  if (/non-?commercial|-nc\b|cc-by-nc|research|noncommercial/i.test(id)) return "no";
  return "limited";
}

/** A guess at what a found LoRA does, from its name and tags. */
function guessCategory(text: string, video: boolean): LoraCategory {
  if (/lightning|turbo|distill|few.?step|\b\d+.?steps?\b|hyper|lcm\b|fast/i.test(text)) return "speed";
  if (/relight|lighting|\blight\b|shadow/i.test(text)) return "light";
  if (/360|panoram|equirect|hdri|skybox/i.test(text)) return "world";
  if (/multiple.?angles|camera.?angle|new.?view|novel.?view|viewpoint|turntable/i.test(text)) return video ? "motion" : "angles";
  if (/dolly|zoom|orbit|\bpan\b|tilt|crane|camera|slow.?mo|cinemagraph|\bloop|motion/i.test(text)) return video ? "motion" : "looks";
  if (/explo|melt|inflat|squish|crush|vfx|effect|transform|dissolve|shatter|levitat/i.test(text)) return "effects";
  if (/outpaint|inpaint|remov|try.?on|next.?scene|consisten|\bedit\b|object|product/i.test(text)) return "edit";
  if (/character.?sheet|turnaround|reference.?sheet/i.test(text)) return "characters";
  if (/logo|typograph|text|poster|icon|\bui\b|font|graphic|infographic|vector/i.test(text)) return "design";
  if (/detail|realis|skin|sharp|enhanc|slider|fix|hand|quality|texture|amateur|photo/i.test(text)) return "detail";
  return "looks";
}

type HubModel = {
  id: string;
  sha?: string;
  downloads?: number;
  likes?: number;
  gated?: boolean | string;
  tags?: string[];
  lastModified?: string;
  cardData?: { license?: string; instance_prompt?: string | string[] | null; tags?: string[]; base_model?: string | string[] };
};

const EXPAND = ["downloads", "likes", "cardData", "tags", "gated", "sha", "lastModified"].map((x) => `expand%5B%5D=${x}`).join("&");

const pretty = (repo: string) =>
  (repo.split("/")[1] ?? repo)
    .replace(/[-_]+/g, " ")
    .replace(/\b(lora|safetensors)\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim() || repo;

const triggerOf = (card: HubModel["cardData"]) => {
  const t = Array.isArray(card?.instance_prompt) ? card?.instance_prompt[0] : card?.instance_prompt;
  return typeof t === "string" && t.trim() && t.length < 160 ? t.trim() : undefined;
};

/** A found repo as a library entry; its files come when someone opens it (`repoFiles`). */
function foundEntry(h: HubModel, m: LocalModel): LoraEntry {
  const text = `${h.id} ${(h.tags ?? []).join(" ")}`;
  return {
    id: `hf:${h.id}`,
    name: pretty(h.id),
    models: [m.id],
    repo: h.id,
    revision: h.sha,
    files: [],
    category: guessCategory(text, m.unit === "clip"),
    blurb: "",
    trigger: triggerOf(h.cardData),
    strength: 1,
    range: [0, 1.5],
    licence: { name: h.cardData?.license ?? "None stated", commercial: stricter(licenceLevel(h.cardData?.license), m.licence.commercial) },
    downloads: h.downloads,
    likes: h.likes,
    gated: Boolean(h.gated),
    author: h.id.split("/")[0],
    found: true,
  };
}

/**
 * LoRAs on Hugging Face made for a model (its bases' adapters), most downloaded first, or matching words. Crackio's own
 * picks for it come first on the pages, so they're left out here.
 */
export async function searchHub(modelId: string, query: string, sort: "downloads" | "likes" | "trendingScore" = "downloads"): Promise<LoraEntry[]> {
  const m = model(modelId);
  if (!m || !takesLoras(m)) throw new LocalError("Unknown model.", 404);
  const bases = basesFor(modelId);
  if (!bases.length) return [];
  const words = query.trim().slice(0, 80);
  return cached(`search:${modelId}:${sort}:${words.toLowerCase()}`, async () => {
    const lists = await Promise.all(
      bases.slice(0, 4).map((base) =>
        hf<HubModel[]>(`/models?filter=${encodeURIComponent(`base_model:adapter:${base}`)}&sort=${sort}&direction=-1&limit=60${words ? `&search=${encodeURIComponent(words)}` : ""}&${EXPAND}`).catch((err) => {
          if (err instanceof LocalError && err.status === 429) throw err;
          return [] as HubModel[];
        }),
      ),
    );
    const mine = new Set(curated().filter((e) => e.models.includes(modelId)).map((e) => e.repo.toLowerCase()));
    const seen = new Set<string>();
    const out: LoraEntry[] = [];
    for (const h of lists.flat().sort((a, b) => (sort === "likes" ? (b.likes ?? 0) - (a.likes ?? 0) : (b.downloads ?? 0) - (a.downloads ?? 0)))) {
      const key = h.id.toLowerCase();
      if (seen.has(key) || mine.has(key)) continue;
      seen.add(key);
      if (blocked(`${h.id} ${(h.cardData?.tags ?? []).join(" ")}`, h.tags ?? [])) continue;
      out.push(foundEntry(h, m));
    }
    return out.slice(0, 60);
  });
}

type HubRepo = HubModel & { siblings?: { rfilename: string; size?: number; lfs?: { sha256?: string; size?: number } }[] };

const REPO = /^[\w.\-]{1,96}\/[\w.\-]{1,96}$/;

/** A repo's LoRA files (.safetensors only: other formats can run code when loaded), their sizes and checksums. */
export async function repoFiles(repo: string): Promise<{ revision: string; gated: boolean; files: LoraFile[]; trigger?: string; licence?: string; tags: string[] }> {
  if (!REPO.test(repo)) throw new LocalError("That isn't a Hugging Face repo.", 400);
  return cached(`files:${repo}`, async () => {
    const info = await hf<HubRepo>(`/models/${repo}?blobs=true`);
    const files = (info.siblings ?? [])
      .filter((s) => /\.safetensors$/i.test(s.rfilename) && (s.size ?? s.lfs?.size ?? 0) > 0)
      .map((s) => ({ path: s.rfilename, bytes: s.size ?? s.lfs?.size ?? 0, sha256: s.lfs?.sha256 }))
      // Whole checkpoints aren't LoRAs (and wouldn't fit a model loader's LoRA chain).
      .filter((f) => f.bytes < 6 * 1024 ** 3)
      .sort((a, b) => a.path.localeCompare(b.path));
    return { revision: info.sha ?? "main", gated: Boolean(info.gated), files, trigger: triggerOf(info.cardData), licence: info.cardData?.license, tags: info.tags ?? [] };
  });
}

/**
 * The tensor names ComfyUI loads for a model's LoRAs, where it loads only some: FLUX 3's loader takes ComfyUI-native
 * (`diffusion_model.…`, ai-toolkit) and kohya (`lora_unet_…`) names, not diffusers' (`transformer.…`). A diffusers-named
 * FLUX 3 Klein LoRA ran on the 5090 with its trigger and changed nothing (Oct 2026).
 */
const NATIVE_KEYS: Record<string, RegExp> = { "flux3-klein": /^(diffusion_model\.|lora_unet_)/ };

/** A safetensors file's tensor names, read from its header alone (two small range requests); null when that fails. */
async function headerKeys(repo: string, revision: string, filePath: string): Promise<string[] | null> {
  const url = loraUrl(repo, revision, filePath);
  try {
    const head = await fetch(url, { headers: { "User-Agent": "crackio", Range: "bytes=0-7" }, signal: AbortSignal.timeout(20_000) });
    if (!head.ok) return null;
    const size = Number(Buffer.from(await head.arrayBuffer()).readBigUInt64LE(0));
    if (!size || size > 50 * 1024 ** 2) return null;
    const body = await fetch(url, { headers: { "User-Agent": "crackio", Range: `bytes=8-${8 + size - 1}` }, signal: AbortSignal.timeout(30_000) });
    if (!body.ok) return null;
    return Object.keys(JSON.parse(Buffer.from(await body.arrayBuffer()).toString("utf8")) as Record<string, unknown>).filter((k) => k !== "__metadata__");
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ pictures */

const PREVIEWS = path.join(DATA_DIR, "cache", "lora-previews");

/**
 * A pick's example picture from its repo, made small (webp, 512 px) and kept on disk: a model's page shows a dozen at once,
 * and the originals are often several-megabyte PNGs. Picks only (their pictures were looked at); a search's finds show none.
 */
export async function loraPreview(id: string): Promise<Buffer | null> {
  const e = curated().find((x) => x.id === id);
  if (!e?.preview || !/^https:\/\/huggingface\.co\/[^?#]+\.(png|jpe?g|webp|gif|mp4|webm|mov)$/i.test(e.preview)) return null;
  const safe = id.replace(/[^\w.-]+/g, "_");
  const file = path.join(PREVIEWS, `${safe}.webp`);
  const hit = await fs.readFile(file).catch(() => null);
  if (hit) return hit;
  await fs.mkdir(PREVIEWS, { recursive: true });
  let data: Buffer | null = null;
  if (/\.(mp4|webm|mov)$/i.test(e.preview)) {
    // A clip: one frame a second in, read straight from Hugging Face (ffmpeg asks for the bytes it needs, not the clip).
    const { runFfmpeg } = await import("@/lib/motion/ffmpeg");
    const frame = path.join(PREVIEWS, `${safe}.frame.png`);
    const run = await runFfmpeg(["-y", "-ss", "1", "-i", e.preview, "-frames:v", "1", "-vf", "scale=640:-2", frame], { timeoutMs: 90_000, background: true }).catch(() => null);
    data = run?.code === 0 ? await fs.readFile(frame).catch(() => null) : null;
    await fs.rm(frame, { force: true });
  } else {
    const res = await fetch(e.preview, { headers: { "User-Agent": "crackio" }, signal: AbortSignal.timeout(30_000) }).catch(() => null);
    if (res?.ok && Number(res.headers.get("content-length") ?? 0) <= 40 * 1024 * 1024) data = Buffer.from(await res.arrayBuffer());
  }
  if (!data) return null;
  const { default: sharp } = await import("sharp");
  const small = await sharp(data)
    .rotate()
    .resize({ width: 512, height: 512, fit: "inside", withoutEnlargement: true })
    .webp({ quality: 78 })
    .toBuffer()
    .catch(() => null);
  if (!small) return null;
  await fs.writeFile(file, small);
  return small;
}

/* ------------------------------------------------------------------ downloads */

/**
 * Download a LoRA to these machines: one of Crackio's picks (`id`, every file it has, a Wan pair's two halves) or a file
 * found on Hugging Face (`repo` + `path`). Each file is checked against its SHA-256 on the way in, and recorded with what
 * it's for.
 */
export async function installLora(input: { model: string; id?: string; repo?: string; path?: string; targets: string[] }) {
  const m = model(input.model);
  if (!m || !takesLoras(m)) throw new LocalError("Unknown model.", 404);
  if (!input.targets.length) throw new LocalError("Pick a machine to download it to.");
  let entry: LoraEntry;
  let files: LoraFile[];
  if (input.id) {
    const e = curated().find((x) => x.id === input.id);
    if (!e) throw new LocalError("Unknown LoRA.", 404);
    entry = e;
    files = e.files;
  } else {
    const repo = input.repo ?? "";
    const r = await repoFiles(repo);
    const f = r.files.find((x) => x.path === input.path);
    if (!f) throw new LocalError("That file isn't a LoRA in that repo.", 404);
    if (blocked(`${repo} ${r.tags.join(" ")}`, r.tags)) throw new LocalError("Crackio doesn't download that kind of LoRA.", 403);
    // A file whose names the model's ComfyUI loader skips would load without an error and do nothing.
    const native = NATIVE_KEYS[m.id];
    const keys = native && !r.gated ? await headerKeys(repo, r.revision, f.path) : null;
    if (native && keys && !keys.some((k) => native.test(k))) {
      throw new LocalError(`This LoRA is saved with diffusers names, which ComfyUI doesn't load for ${m.name}: it would do nothing. Look for a ComfyUI version of it.`, 422);
    }
    const found = foundEntry({ id: repo, sha: r.revision, gated: r.gated, tags: r.tags, cardData: { license: r.licence, instance_prompt: r.trigger } }, m);
    entry = { ...found, name: foundName(repo, f.path, r.files.length), files: [f] };
    files = [f];
  }
  const records = await readRecords();
  const names = files.map((f) => {
    const name = loraFileName(entry.repo, f.path);
    const had = records[name];
    // Another LoRA already has that name: this one takes its maker's in front.
    return had && (had.repo !== entry.repo || had.path !== f.path) ? `${entry.author.replace(/[^A-Za-z0-9_.\-]+/g, "_")}-${name}` : name;
  });
  const started: { target: string; file: string; started: number; error?: string }[] = [];
  for (const target of input.targets) {
    for (const [i, f] of files.entries()) {
      try {
        const r = await installFile({ folder: "loras", name: names[i], url: loraUrl(entry.repo, entry.revision, f.path), bytes: f.bytes, sha256: f.sha256, role: "lora" }, target);
        started.push({ target, file: names[i], started: r.started });
      } catch (err) {
        started.push({ target, file: names[i], started: 0, error: (err as Error).message });
      }
    }
  }
  if (started.every((s) => s.error)) throw new LocalError(started[0]?.error ?? "Nothing downloaded.");
  await changeRecords((all) => {
    files.forEach((f, i) => {
      const had = all[names[i]];
      all[names[i]] = {
        file: names[i],
        entry: entry.id,
        name: entry.name,
        repo: entry.repo,
        path: f.path,
        models: [...new Set([...(had?.models ?? []), ...entry.models, m.id])],
        category: entry.category,
        ...(entry.trigger ? { trigger: entry.trigger } : {}),
        ...(entry.triggerAt ? { triggerAt: entry.triggerAt } : {}),
        strength: entry.strength,
        range: entry.range,
        ...(f.match ? { match: f.match } : {}),
        licence: entry.licence,
        bytes: f.bytes,
        ...(entry.found ? { found: true } : {}),
      };
    });
  });
  return { files: names, results: started };
}

/** A found file's name in the library: its repo's, and the file's own when the repo has several. */
function foundName(repo: string, filePath: string, count: number) {
  const base = pretty(repo);
  return count > 1 ? `${base} · ${filePath.split("/").pop()!.replace(/\.safetensors$/i, "")}` : base;
}

/** Delete a LoRA file from a machine (its record stays: another machine may still have it). */
export async function removeLora(file: string, target: string) {
  if (!/^[\w.\-+ ()[\]]{1,200}\.safetensors$/i.test(file)) throw new LocalError("That isn't a LoRA file name.", 400);
  return removeFile("loras", file, target);
}
