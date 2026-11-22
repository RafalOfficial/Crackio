import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import CATALOG from "@/lib/local/lora-catalog.json";
import GALLERY from "@/lib/local/lora-gallery.json";
import { autoTrigger, categoryLabel, loraFileName, loraUrl, namesAnotherModel, pickFiles, stricter, takesLoras, type LoraBrowse, type LoraCategory, type LoraEntry, type LoraFile, type LoraLibrary, type LoraRecord } from "@/lib/local/loras";
import type { LocalModel } from "@/lib/local/types";
import { allLocalModels } from "./local-templates";
import { installFile, LocalError, removeFile } from "./local-models";
import { DATA_DIR } from "./paths";
import { writeFileAtomic } from "./atomic-write";

/**
 * The LoRA library on the server: Crackio's checked picks for each open model (lib/local/lora-catalog.json), every other
 * LoRA on Hugging Face made for it (`browseHub`: most popular first, filtered, with the examples that were looked at:
 * lib/local/lora-gallery.json), downloads into a ComfyUI's models/loras (local-models `installFile`, through its bridge
 * or straight to disk), and a record of what each downloaded file is (data/loras.json): the model it's for, its trigger
 * words and strength, so a job that carries it is drawn right (engines/comfy-local `lorasOf`).
 */

const RECORDS = path.join(/*turbopackIgnore: true*/ DATA_DIR, "loras.json");
const HF = "https://huggingface.co/api";

const g = globalThis as unknown as {
  __crackioLoraRecords?: Promise<Record<string, LoraRecord>>;
  __crackioLoraWrites?: Promise<unknown>;
  __crackioLoraSearch?: Map<string, { at: number; value: Promise<unknown> }>;
  /** The example each listed find shows, by its id, as the last listings had them (`previewSource`). */
  __crackioLoraShown?: Map<string, { url: string; clip: boolean }>;
  /** Whether your Hugging Face account may read a gated LoRA, by repo, as last asked (`loraAccess`). */
  __crackioLoraAccess?: Map<string, { at: number; value: Promise<"open" | "granted" | "needed" | "no-token"> }>;
};

const model = (id: string) => allLocalModels().find((m) => m.id === id) ?? null;

/* ------------------------------------------------------------------ Crackio's picks */

type Catalog = { entries: LoraEntry[]; bases: Record<string, string[]> };
const catalog = CATALOG as unknown as Catalog;

let picks: LoraEntry[] | null = null;

/** Crackio's checked LoRAs, each with the file names it gets in models/loras. */
export function curated(): LoraEntry[] {
  return (picks ??= catalog.entries
    .filter((e) => e.files?.length && e.repo && e.models?.length && !hidden.has(e.repo))
    .map((e) => ({ ...e, range: e.range ?? [0, 1.5], strength: e.strength ?? 1, local: e.files.map((f) => loraFileName(e.repo, f.path)), ...(e.preview && (e.clip ?? MOVES.test(e.preview)) ? { clip: true } : {}) })));
}

/** An example that's a clip by its name (an animated WebP says so in the catalog: `clip`). */
const MOVES = /\.(mp4|webm|mov|gif)$/i;

/**
 * Examples that were looked at, by repo (lib/local/lora-gallery.json): a find shows a picture only when it's here, or its
 * maker is one of the labs below. Hugging Face's most downloaded LoRAs for a video model are mostly adult ones, and a
 * name filter can't promise what a picture shows.
 */
const gallery = (GALLERY as unknown as { repos: Record<string, { url: string; clip?: boolean }> }).repos;
/**
 * A find's name, what it does in a sentence and its kind, written by hand where its repo's name doesn't say (by repo).
 * `trigger`: the words it adds to a prompt where its card names them badly (an example sentence, a template): "" for none.
 */
type Written = { name?: string; blurb?: string; category?: LoraCategory; trigger?: string };
const written = (GALLERY as unknown as { words?: Record<string, Written> }).words ?? {};
/** What was written by hand for a repo, if anything. */
export const wordsFor = (repo: string): Written | undefined => written[repo];

/**
 * Every listed find with the models it's for and its numbers as they were when the gallery was last indexed
 * (the gallery file's `index`): what a search across all models reads, with no call to Hugging Face.
 */
type Indexed = { models: string[]; downloads?: number; likes?: number; licence: LoraEntry["licence"]; gated?: boolean; created?: string; fileCount?: number; preview?: string; clip?: boolean };
const index = (GALLERY as unknown as { index?: Record<string, Indexed> }).index ?? {};

/**
 * The LoRAs of every model that match words (a look, a move, an effect: their names and what they do), most used
 * first: Crackio's picks and the finds it lists. `except`: a model whose own are left out (its page shows them).
 */
export function searchEverywhere(query: string, except?: string): LoraEntry[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
  if (!terms.length || terms.join("").length < 2) return [];
  const says = (e: LoraEntry) => `${e.name} ${e.blurb} ${categoryLabel(e.category)} ${e.trigger ?? ""} ${e.author ?? ""}`.toLowerCase();
  const finds: LoraEntry[] = Object.entries(index)
    .filter(([repo]) => !hidden.has(repo))
    .map(([repo, at]) => {
      const w = written[repo];
      return {
        id: `hf:${repo}`,
        name: w?.name ?? pretty(repo),
        models: at.models,
        repo,
        revision: "main",
        files: [],
        category: w?.category ?? "looks",
        blurb: w?.blurb ?? "",
        ...(w?.trigger ? { trigger: w.trigger } : {}),
        strength: 1,
        range: [0, 1.5] as [number, number],
        licence: at.licence,
        downloads: at.downloads,
        likes: at.likes,
        gated: Boolean(at.gated),
        author: repo.split("/")[0],
        found: true,
        ...(at.created ? { created: at.created } : {}),
        ...(at.fileCount ? { fileCount: at.fileCount } : {}),
        ...(at.preview ? { preview: at.preview } : {}),
        ...(at.clip ? { clip: true } : {}),
      };
    });
  return [...curated(), ...finds]
    .filter((e) => (!except || !e.models.includes(except)) && terms.every((t) => says(e).includes(t)))
    .sort((a, b) => (b.downloads ?? 0) - (a.downloads ?? 0))
    .slice(0, 48);
}

/**
 * A card's trigger words, tidied; undefined when what it gives isn't words to add to a prompt: a template to fill in
 * ("Apply ... texture to ...", "<s0><s1>"), "N/a", its tags, or advice ("For best results, use…").
 */
function cleanTrigger(raw: string | undefined): string | undefined {
  let t = (raw ?? "")
    .replace(/&quot;|&#0?34;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&#0?39;|&39;/g, "'")
    .trim()
    .replace(/^["'“”`[]+|["'“”`\]]+$/g, "")
    .replace(/[.,;\s]+$/, "")
    .trim();
  // A bracket left over from the card's own sentence ("modern anime style,)").
  if (!t.includes("(")) t = t.replace(/[).,;\s]+$/, "");
  if (t.length < 2 || t.length > 160) return undefined;
  if (/[<>{}]|\.\.\.|…/.test(t) || /^(n\/?a|none|no\b|not needed|optional|for best|use |you |this |the model)/i.test(t) || /template:|stable-diffusion|https?:/i.test(t)) return undefined;
  return t;
}
/**
 * Never listed, searched for or not, a pick or a find: not a LoRA at all, one that needs an input Crackio has no way to
 * give, or one whose file ComfyUI wouldn't read for its model (`LOADS` below).
 */
const hidden = new Set((GALLERY as unknown as { hidden?: string[] }).hidden ?? []);

/** Model makers and labs whose own LoRAs show their examples unseen: they publish under their name, for work. */
const LABS = new Set(
  ["Lightricks", "Wan-AI", "lightx2v", "alibaba-pai", "Alibaba-PAI", "Kijai", "Comfy-Org", "black-forest-labs", "Qwen", "Tongyi-MAI", "ByteDance", "tencent", "nvidia", "microsoft", "OpenMOSS-Team", "krea", "HiDream-ai", "DiffSynth-Studio", "fal", "Shakker-Labs", "XLabs-AI", "ostris", "multimodalart"].map((x) => x.toLowerCase()),
);

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
    await fs.mkdir(/*turbopackIgnore: true*/ DATA_DIR, { recursive: true });
    await writeFileAtomic(RECORDS, JSON.stringify(all, null, 1));
  });
  g.__crackioLoraWrites = next.catch(() => undefined);
  return next;
}

/** A LoRA trained on the Train page, added to the library (or its record changed): it shows under each model it's for. */
export function recordTrained(record: LoraRecord) {
  return changeRecords((all) => {
    all[record.file] = record;
  });
}

/** Every recorded LoRA file, by its name. */
export const loraRecords = () => readRecords();

/** A LoRA file's record written (an uploaded file's: server/lora-home). */
export const saveRecord = (record: LoraRecord) => recordTrained(record);

/** One record changed in place; answers with it as it is now (null: no such file). A change that throws changes nothing. */
export async function changeRecord(file: string, change: (r: LoraRecord) => void): Promise<LoraRecord | null> {
  let out: LoraRecord | null = null;
  await changeRecords((all) => {
    if (!all[file]) return;
    const next = structuredClone(all[file]);
    change(next);
    all[file] = next;
    out = next;
  });
  return out;
}

/** A record gone. */
export function dropRecord(file: string) {
  return changeRecords((all) => {
    delete all[file];
  });
}

/** A trained LoRA's record gone (its job was deleted with its LoRA). */
export function forgetTrained(job: string) {
  return changeRecords((all) => {
    for (const [file, r] of Object.entries(all)) if (r.trained === job) delete all[file];
  });
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
  for (const e of curated()) e.files.forEach((f, i) => out.set(e.local![i], { trigger: autoTrigger(e.trigger), match: f.match, end: e.triggerAt === "end", name: e.name }));
  for (const r of Object.values(await readRecords())) if (!out.has(r.file)) out.set(r.file, { trigger: autoTrigger(r.trigger), match: r.match, end: r.triggerAt === "end", ...(r.stale?.length ? { stale: r.stale } : {}), ...(r.name ? { name: r.name } : {}) });
  return out;
}

/**
 * A LoRA file's words (`end`: they go last in the prompt) and the one of a graph's models it goes on. `stale`: the
 * machines whose copy is another version of it (`LoraRecord.stale`).
 */
export type LoraMeta = { trigger?: string; match?: string; end?: boolean; stale?: string[]; name?: string };

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
  // Hugging Face refusing (it limits how often it's asked) or out of reach: what it said last time beats an empty page,
  // and it's asked again in a minute.
  const value = ask().catch((err) => {
    if (!hit) throw err;
    cache.set(key, { at: Date.now() - 9 * 60_000, value: hit.value });
    return hit.value as Promise<T>;
  });
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
/** Explicit words: checked in a find's example prompts too, and one LoRA that has them hides its maker's others. */
const EXPLICIT =
  /nsfw|porn|hentai|\bsex\b|sexual|erotic|nud(e|ity)|naked|topless|undress|nipple|pussy|penis|genital|\bcock\b|\bdick|\bcum\b|cumshot|creampie|blowjob|\bbj\b|handjob|titjob|deepthroat|gagging|gangbang|gloryhole|penetrat|dildo|masturbat|orgasm|squirt|bdsm|fetish|\banal\b|\bpiss|\bscat\b|futa|ahegao|\bloli|shota|dr34ml4y|dreamlay|onlyfans|uncensor|\bxxx\b|18\+|r18|bondage|slut|whore|fuck/i;
/** Words that rule a LoRA out by its name and tags, but mean nothing in an example's prompt ("blow out the candles"). */
const SUGGESTIVE = /skimp|insertion|\bblow\b|diaper|voluptuous|pantyhose|stocking|panties|pantsu|upskirt|thong|\bmilf|ecchi|oppai|\bero\b|\bguro\b|\bgore\b|cowgirl|c0wg1rl|doggy|missionary|bimbo|horny|naughty/i;

/**
 * Makers whose LoRAs the library never lists, whatever a repo is called: their examples were seen while the gallery was
 * reviewed (lora-gallery.json) and are explicit, or are LoRAs of real people. Names alone ("…_style", "snapshot") hide it.
 */
const MAKERS_OUT = new Set(
  [
    // Seen in the second review (Nov 2026): likenesses of real people, or those among explicit ones.
    "Rand000mGuy", "NxisZd", "Donkov", "Onise", "Edwkenway", "CJDoidge", "nikitka194", "djuuzo", "erne1234", "AlexSolo95", "Trvrxyz", "Seer777",
    "profpeng", "obsxrver", "lopi999", "Poij3012", "SlartyG", "luoruikun", "DAKARA555", "Garnish8756", "hsfhsa", "Ashle128", "punzel", "Keltezaa", "AIImageStudio", "bionicman69",
    "WRATHGODDESS", "Ceistheslug", "Coald", "sardine184", "mustafac5", "evecruzjr", "ajajajJajazznsksjsnsn", "Nobody1x1", "ZzCL4YzZ", "devarka", "NamiYagami",
    "Isafuttin", "Nogo811", "ragman5", "JulianoG121", "andrebragamkt", "rkppvc", "quarterturn", "lantianws666", "luqa03", "hinablue", "Lnypuuuu", "Playtime-AI", "Danrisi", "B0rghese",
    "Burroughs352", "LennOFF", "ManyWayne", "Redivine", "prettyshisya", "Hectore", "sololo-xyz", "thatboymentor", "Vladbambu", "Heredias", "tezrt", "Giovani134343", "Plimpumpam", "wsdZtuq3",
    "klckmd", "unmosaic", "dannys321", "selfmate32", "gitamam", "bapiga3606", "nrx83", "surface-tension1337", "Phosl", "zjr5235", "lescanor150", "shauray", "dhanishvijayan", "tylopez52",
    "crystantine", "Jeynixvfx", "D1-3105", "mgwr", "seanjang990", "213123aaa", "privcdd", "Gemneye", "leon11112", "TheDivergentAI", "SCBrazil", "EVA787797", "wxwhj", "Emma23123", "ifmylove2011",
  ].map((x) => x.toLowerCase()),
);
/**
 * LoRAs that aren't a plain add-on to a clip model: they need a guide clip, a sound or a mask that a LoRA slot doesn't
 * give (LTX's in-context "IC" LoRAs, control and audio ones), so switched on by themselves they do nothing, or harm.
 */
const NEEDS_MORE = /\bic[-_ ]?lora|in[-_ ]?context|control[-_ ]?net|control[-_ ]?lora|[-_ ]union\b|audio|foley|\bv2a\b|speech|voice|talking|lip[-_ ]?sync|upscal|\bvae\b|inpaint|outpaint|greenscreen|\bsam\b|depth|pose/i;
const PEOPLE = /celeb|actress|\bactor\b|influencer|face.?swap|deepfake|likeness|instagram|tiktok|\bidol\b|kpop|k-pop|\bbfs\b|head.?swap|identity/i;
const IP =
  /pok[eé]mon|pikachu|marvel|disney|pixar|ghibli|star.?wars|naruto|one.?piece|dragon.?ball|simpsons|spider.?man|batman|superman|mickey|barbie|harry.?potter|genshin|zelda|\bmario\b|sonic|minecraft|fortnite|\blego\b|nintendo|arcane|jojo|evangelion|gundam|sailor.?moon|titan|demon.?slayer|jujutsu|chainsaw|frozen|shrek|transformers|warhammer|league.?of.?legends|overwatch|valorant|hello.?kitty|dreamworks|south.?park|rick.?and.?morty|wes.?anderson|tim.?burton|van.?gogh|mucha|giger|miyazaki|makoto.?shinkai|ufotable|cyberpunk.?2077|elden.?ring|final.?fantasy|resident.?evil|the.?witcher|gta|halo|street.?fighter|tekken|mortal.?kombat|bluey|peppa|spongebob|avatar|game.?of.?thrones|lord.?of.?the.?rings|stranger.?things/i;

/**
 * Words that say a LoRA nobody checked is the likeness of a person: a given name standing alone in its repo's name or
 * trigger ("Alisa", "z_sophiya", "emma watson"), or a prompt of the kind a likeness is trained with ("a photo of sks
 * woman", "1girl"). It drops some that aren't (a style named "Luna"): one nobody looked at can go unlisted.
 */
const GIVEN =
  "emma|scarlett|alice|alisa|alicia|sara|sarah|sofia|sophia|sophiya|sofie|sophie|nina|anna|ana|lena|amira|ivy|jenny|jennifer|eva|evva|evaa|marta|mary|maria|mariana|marianna|kaia|stacy|erika|erica|anika|clara|luna|amaya|yunhee|emily|emilia|olivia|ava|mia|isabella|charlotte|amelia|harper|evelyn|abigail|ella|elizabeth|camila|chloe|victoria|grace|zoe|zoey|nora|lily|hannah|lucy|layla|ellie|stella|natalie|leah|hazel|violet|aurora|savannah|audrey|brooklyn|bella|claire|skylar|paisley|everly|caroline|genesis|emery|kennedy|samantha|maya|willow|kinsley|naomi|aaliyah|elena|ariana|allison|gabriella|madelyn|cora|ruby|eva|serenity|autumn|adeline|hailey|gianna|valentina|isla|eliana|quinn|nevaeh|sadie|piper|lydia|alexa|josephine|julia|delilah|arianna|vivian|kaylee|sophie|brielle|madeline|peyton|rylee|taylor|katherine|kate|katie|jessica|ashley|amanda|megan|rachel|lauren|nicole|michelle|kim|kimberly|melissa|amy|angela|anastasia|natasha|tatiana|olga|irina|svetlana|ekaterina|yulia|daria|dasha|masha|polina|ksenia|alina|karina|kristina|veronika|diana|milana|elina|lisa|laura|lara|linda|lina|mila|nadia|nadya|katya|tanya|vika|zara|zoya|yuna|yuki|sakura|hana|mei|ling|jisoo|jennie|rose|rosa|carmen|lucia|paula|pauli|andrea|daniela|valeria|ximena|fernanda|isabel|ines|elsa|freya|ingrid|astrid|greta|heidi|petra|nia|kiara|aisha|fatima|leila|yasmin|zainab|priya|ishani|anjali|pooja|riya|john|james|robert|michael|william|david|richard|joseph|thomas|charles|christopher|daniel|matthew|anthony|mark|donald|steven|paul|andrew|joshua|kenneth|kevin|brian|george|timothy|ronald|edward|jason|jeffrey|ryan|jacob|gary|nicholas|eric|jonathan|stephen|larry|justin|scott|brandon|benjamin|samuel|gregory|alexander|patrick|frank|raymond|jack|dennis|jerry|tyler|aaron|jose|adam|nathan|henry|peter|zachary|kyle|ethan|noah|liam|lucas|mason|logan|elijah|oliver|sergey|dmitri|ivan|alexei|nikita|mikhail|andrei|vladimir|ahmed|mohammed|ali|omar|carlos|juan|luis|miguel|diego|pedro|javier";
/** The people most often cloned, as their LoRAs spell them ("emmawatson", "Scarlett_Johansson"). */
const FAMOUS =
  "emma[-_ ]?watson|scarlett[-_ ]?johansson|johansson|taylor[-_ ]?swift|ana[-_ ]?de[-_ ]?armas|sydney[-_ ]?sweeney|margot[-_ ]?robbie|billie[-_ ]?eilish|ariana[-_ ]?grande|selena[-_ ]?gomez|zendaya|dua[-_ ]?lipa|jenna[-_ ]?ortega|emma[-_ ]?stone|gal[-_ ]?gadot|kardashian|kylie[-_ ]?jenner|jennifer[-_ ]?lawrence|natalie[-_ ]?portman|angelina[-_ ]?jolie|megan[-_ ]?fox|elon[-_ ]?musk|trump|obama|biden|putin|zelensk|macron|merkel|\bmodi\b|xi[-_ ]?jinping|kim[-_ ]?jong|bezos|zuckerberg|bill[-_ ]?gates|kamala|boris[-_ ]?johnson|erdogan|netanyahu|bolsonaro|milei|meloni|starmer|sunak|messi|ronaldo|keanu|di[-_ ]?caprio|brad[-_ ]?pitt|tom[-_ ]?cruise|blackpink|lalisa|jungkook";
// A given name of five letters or more counts at the start of a longer word too ("Aliciadefleur"); a shorter one
// only standing alone ("mia", not "miami").
const PERSON = new RegExp(
  `(^|[^a-z])(${GIVEN.split("|").filter((n) => n.length >= 5).join("|")})|(^|[^a-z])(${GIVEN.split("|").filter((n) => n.length < 5).join("|")})(?![a-z])|${FAMOUS}|\\b1(girl|boy|woman|man)\\b|\\b(photo|selfie|portrait|picture|image) of (a |an )?[\\w-]{2,24} (woman|girl|man|boy|person|lady|guy)\\b|\\bsks (woman|girl|man|boy|person)\\b`,
  "i",
);

/**
 * WHEN AN UNCHECKED LoRA'S EXAMPLE IS BLURRED (it shows behind a "Show example" button instead of by itself).
 * A LoRA nobody here looked at shows its maker's own example. These words say the picture may be suggestive, or is
 * most likely a person: add a word here to blur more, take one out to blur less. (Explicit ones, real people and
 * likenesses never list at all: `EXPLICIT`, `ADULT`, `PEOPLE`, `PERSON` above.)
 * - `BLUR_WORDS`: anywhere in what's known of it: its name, tags, trigger words and its example's own prompt.
 * - `BLUR_NAMES`: in its name, tags and trigger only: a LoRA that is about a woman, a face, realism or a character
 *   (a prompt that merely has a woman in it doesn't blur).
 */
const BLUR_WORDS =
  /sexy|sensual|seduct|sultry|alluring|flirt|glamou?r|boudoir|pin[-_ ]?up|lewd|ecchi|waifu|fan[-_ ]?service|18\+|mature|bikini|swim(suit|wear)|lingerie|underwear|\bbra\b|pant(y|ies)|cleavage|busty?\b|breast|\bchest\b|curv(y|es)|thicc|thigh|\blegs?\b|\bfeet\b|\bfoot\b|booty|\bbutt\b|\bhips?\b|shirtless|barefoot|bodysuit|leotard|latex|corset|stocking|fishnet|high heels|mini[-_ ]?skirt|crop[-_ ]?top|see[-_ ]?through|sheer|\bwet\b|\bbath|shower|bedroom|on (a |the |her |his )?bed\b|selfie|influencer|instagram|tiktok|cosplay|\bmaid\b|bunny|cat[-_ ]?girl|succubus|\bgoth|kiss|tongue|blush|lips\b|pose[sd]? (seductively|provocatively)|provocative|revealing|skimp|tight (dress|top|clothes|outfit)|\bbeach|\bskirt|\bdress\b|\bodor|smell|sweat|armpit|stomach|belly|midriff|navel|\bshorts\b|tank top|off[-_ ]?shoulder|bare (shoulders|back|legs|arms)|school ?girl|uniform|sailor|nurse|\bnun\b|witch|demon girl|elf girl|monster girl|kemono|furry|anthro/i;
const BLUR_NAMES = /girl|wom[ae]n|female|\blady\b|\bgf\b|girlfriend|\bwife\b|\bmodel\b|beaut|pretty|realis|photoreal|ultra[-_ ]?real|amateur|candid|snapshot|iphone|\bskin\b|\bbody\b|\bface\b|portrait|character|\bperson\b|human|\bman\b|\bmen\b|\bboy\b|\bmale\b/i;

/**
 * FETISHES PEOPLE HIDE IN A LoRA'S NAME: one nobody here checked that has any of these in its name, tags or trigger
 * words isn't listed at all, and Add refuses it (a name like "Anime Feet" says less than its pictures show). Matched
 * inside longer words too ("feetlora"), except the short ones that are ordinary words elsewhere. Add to it freely:
 * what it wrongly hides is only an unchecked LoRA.
 */
const FETISH = new RegExp(
  [
    // feet and legs
    "feet|\\bfoot\\b|foot ?(fet|job|worship|focus|mask|control|detail|view|pose|media|sole)|\\bsoles\\b|\\btoes\\b|open ?toe|toe ?suck|toe ?ring|bare ?feet|\\bfootsie|\\bsandals?\\b|\\bheels\\b|leg ?wear|leggings|\\blegs\\b|leg ?fet|thigh ?job|thigh ?squish|thighs?\\b",
    // armpits, smell, sweat, spit
    "armpit|\\bpits\\b|sniff|\\bsmell|\\bodou?r|musk|sweat ?fet|\\bsweaty\\b|drool|saliva|\\bspit\\b|lick(ing)? ?(feet|foot|armpit|boot)",
    // tying, hurting, owning
    "tickl|spank|bondage|shibari|hog ?tie|\\bgagged|ball ?gag|\\bbdsm|fem ?dom|fin ?dom|\\bdomme\\b|dominatrix|humiliat|degrad|pet ?play|\\bleash|slave ?girl|\\bcollared|chok(e|ing) ?(her|fet|play)|strangl|asphyx|face ?sit|smother|trampl|crush ?fet|boot ?worship",
    // bodies changed
    "\\bvore\\b|giantess|macrophil|size ?difference|shrunk|body ?inflat|inflat(ed|ion) ?(girl|woman|body|belly|breast|butt)|belly ?(stuff|inflat|bulge|expan)|stomach ?bulge|weight ?gain|\\bssbbw|\\bbbw\\b|feedee|breast ?expan|butt ?expan|hyper ?(breast|butt|muscle)|muscle ?growth|lactat|pregnan|preggo|\\bfuta|bimbo|sissy|feminiz|cross ?dress|body ?swap|possession ?fet|age ?regress|petrif|statuef|encase|mummif|cocoon|quicksand|slime ?girl|tentacle ?(sex|rape|girl|pit)",
    // minds
    "hypno|mind ?control|brainwash|mind ?break|corruption ?fet",
    // fluids and nappies
    "\\bpee(ing)?\\b|\\bpiss|omorashi|watersports|\\bfart|diaper|\\babdl|\\benema",
    // clothes as the point, and losing them
    "camel ?toe|down ?blouse|nip ?slip|wardrobe ?malfunction|torn ?cloth|cloth(es|ing)? ?(rip|tear|destr|damage)|\\bx ?ray\\b|nudif|undress|see ?through|wet ?(look|shirt|clothes|t ?shirt)|\\boiled\\b|oily ?skin|zentai|spandex|lycra|latex|rubber ?suit|gas ?mask|vac ?bed|plug ?suit|pantyhose|\\bnylons?\\b|\\bstockings?\\b|thigh ?highs?|knee ?socks|\\bsocks ?fet|micro ?bikini|sling ?bikini|pasties|sukumizu|school ?swimsuit|bunny ?suit|panty ?shot|pantsu|upskirt|\\bthong|g ?string|garter|high ?heels|stiletto|under ?boob|side ?boob|areola",
    // the rest
    "\\bcuck|\\bntr\\b|netorare|hucow|\\bbreeding\\b|mating ?press|paizuri|\\bbukkake|\\bahegao|\\bloli|\\bshota|\\byiff|exhibitionis|voyeur|peeping|sleep ?(sex|fet|molest)|somno|molest|grop(e|ing)|harem|succubus|\\bmilf|\\bgilf|step ?(mom|sis|bro|dad)|incest",
  ].join("|"),
  "i",
);

/**
 * NEVER LISTED AND NEVER ADDED, WHATEVER IS CHOSEN UNDER PREFERENCES: the young in an adult setting, anything without
 * consent, animals, family, tools that strip or copy a real person, and pictures taken in secret. (Real people by name
 * and likenesses are kept out by `PEOPLE`, `PERSON` and `FAMOUS`; other people's characters and brands by `IP`.)
 */
const NEVER =
  /\bloli|lolicon|\bshota|shotacon|jail ?bait|under ?age|pre ?teen|\bpedo|toddlercon|child ?porn|\bcp\b|\brape|non ?con\b|\bforced\b|molest|grop(e|ing)|sleep ?(sex|fet|molest|assault)|somno|drugged|unconscious|passed ?out|bestial|zoophil|knotting|\bdog ?(sex|knot|cock)|horse ?(sex|cock)|necro|snuff|\bguro\b|incest|step ?(mom|sis|bro|dad|daughter|son|mother|sister|brother|father)|nudif|undress|deep ?nude|cloth(es|ing)? ?remov|\bx ?ray\b|strip ?(her|him|them)|face ?swap|deep ?fake|hidden ?cam|voyeur|peeping|up ?skirt|down ?blouse|creep ?shot|revenge ?porn/i;
/** Words for the young: an adult LoRA that has one in its name, tags, trigger or example prompt is never listed. */
const YOUNG =
  /\bchild|\bkids?\b|\bteen|school ?(girl|boy|uniform|swimsuit)|\b(1[0-7]|[1-9]) ?(yo|y o|years? old|year old)\b|young ?(girl|boy|woman|teen|lady)|little ?(girl|boy|sister|brother)|\bpetite\b|flat ?chest|\bstudent|\bjk\b|\bjc\b|\bjs\b|kindergarten|elementary|middle ?school|high ?school|\bminor\b|daughter|\bniece|\bnephew|\byouth|\bbaby\b|toddler|infant|\bimouto|onee ?chan|mesugaki|\bchibi/i;
/** Makers of adult LoRAs under mild names: theirs count as adult whatever they're called. */
const MAKERS_ADULT = new Set(["benevolent", "zamiipx", "dosesnrolls1", "ciover2024", "theuniquebob"]);

/** Raised with every change to the word lists above and below: listings kept from before are asked again. */
const FILTERS = 9;

/**
 * A repo's name as plain words, so the word lists see them: "AnimeFeetV4" and "feet_anime-pony" read "anime feet v4"
 * and "feet anime pony" (an underscore or a capital in the middle hides a word from `\b`).
 */
const asWords = (s: string) =>
  s
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[^A-Za-z0-9+]+/g, " ")
    .toLowerCase();
/** LoRAs made for the anime fine-tunes of SDXL, filed under SDXL: they don't fit the base model. */
const SDXL_TUNES = /(^| )(pony|ponyxl|illustrious|noob|noobai|animagine|nai ?\d?|autismmix)( |$)/;

const NOT_AN_ADDON = /control[-_ ]?net|control[-_ ]?lora|refcontrol|ip[-_ ]?adapter|pulid|instant[-_ ]?id|t2i[-_ ]?adapter|in[-_ ]?context|upscaler|(^|[-_ .])(tcd|lcm|dmd2?|hyper[-_ ]?sd|lightning|flash|turbo[-_ ]?lora|[248][-_ ]?steps?|lightx2v)([-_ .]|$)/i;

export function blocked(text: string, tags: string[] = []) {
  return tags.includes("not-for-all-audiences") || ADULT.test(text) || EXPLICIT.test(text) || SUGGESTIVE.test(text) || PEOPLE.test(text) || IP.test(text);
}

/** A licence id from a model card, as what it allows. */
function licenceLevel(id: string | undefined): LoraEntry["licence"]["commercial"] {
  if (!id) return "no";
  if (/^(apache-2\.0|mit|bsd.*|cc0.*|cc-by-4\.0|cc-by-sa-4\.0|openrail\+\+|creativeml-openrail-m|openrail|unlicense|artistic-2\.0|wtfpl)$/i.test(id)) return "yes";
  if (/non-?commercial|-nc\b|cc-by-nc|research|noncommercial/i.test(id)) return "no";
  return "limited";
}

/** A guess at what a found LoRA does, from its name and tags. */
export function guessCategory(text: string, video: boolean): LoraCategory {
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
  createdAt?: string;
  cardData?: { license?: string; instance_prompt?: string | string[] | null; tags?: string[]; base_model?: string | string[]; widget?: { text?: string; output?: { url?: string } }[] };
  siblings?: { rfilename: string }[];
};

const EXPAND = ["downloads", "likes", "cardData", "tags", "gated", "sha", "lastModified", "createdAt", "siblings"].map((x) => `expand%5B%5D=${x}`).join("&");

/** Words in a repo's name that say which model it's for or what kind of file it is, not what the LoRA does. */
const NOT_A_NAME =
  /^(safetensors|comfyui|diffusers|ic|flux[.\d]*|flux\d?klein|fluxklein|fluxdev|klein|kontext|dev|schnell|krea\d?|sdxl|xl|sd|qwen\d*|qwenimage|image|edit|qie|z|zimage|zit|turbo|moss|sft|ltxv?[\d.]*|wan[\d.]*|i2v|t2v|ti2v|a14b|\d+b|redmond|v\d+(\.\d+)*|\d+(\.\d+)?|for|the|style)$/i;

/**
 * A find's name as a card shows it, from its repo's: "LTX-2.5-22b-LoRA-Slow-Motion-Control" reads "Slow Motion Control",
 * "krea-2-grainy-nineties-film-lora" "Grainy Nineties Film". The model's own name, versions and "LoRA" say nothing
 * on a page that is already one model's LoRAs.
 */
function pretty(repo: string) {
  const words = (repo.split("/")[1] ?? repo)
    .replace(/loras?/gi, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[-_.\s]+/)
    .filter(Boolean);
  const kept = words.filter((w) => !NOT_A_NAME.test(w));
  const name = (kept.length ? kept : words).map((w) => (/^[a-z]/.test(w) || (/^[A-Z]+$/.test(w) && w.length > 4) ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w)).join(" ");
  return name || repo;
}

const triggerOf = (card: HubModel["cardData"]) => {
  const t = Array.isArray(card?.instance_prompt) ? card?.instance_prompt[0] : card?.instance_prompt;
  return typeof t === "string" ? cleanTrigger(t) : undefined;
};

/** A found repo as a library entry; its files come when someone opens it (`repoFiles`). */
function foundEntry(h: HubModel, m: LocalModel): LoraEntry {
  // Its name and its own tags: the tags every LoRA carries ("text-to-image", "lora", its base model) say nothing of what it does.
  const text = `${h.id.split("/")[1] ?? h.id} ${(h.cardData?.tags ?? []).filter((t) => !/^(text-to-|image-to-|video-to-|lora$|diffusers|template:|base_model|license|region|safetensors|en$|flux|wan|ltx|qwen|sdxl|stable-diffusion)/i.test(t)).join(" ")}`;
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
    ...(h.createdAt ? { created: h.createdAt } : {}),
    ...(h.siblings ? { fileCount: h.siblings.filter((x) => /\.safetensors$/i.test(x.rfilename)).length } : {}),
  };
}

const MEDIA = /\.(png|jpe?g|webp|gif|mp4|webm)$/i;
/** Pictures in a repo that aren't examples of what it draws. */
const NOT_EXAMPLE = /loss|plot|graph|chart|workflow|logo|banner|node|screenshot|diagram|thumb|icon|cover/i;

/** A repo's own first example (its card's, else a picture among its files), at the commit listed: a lab's find shows it. */
function ownExample(h: HubModel): { url: string; clip: boolean } | null {
  const at = (file: string) => `https://huggingface.co/${h.id}/resolve/${h.sha ?? "main"}/${file.split("/").map(encodeURIComponent).join("/")}`;
  const card = (h.cardData?.widget ?? []).map((w) => w.output?.url).find((u): u is string => typeof u === "string" && MEDIA.test(u.split("?")[0]));
  const file = (h.siblings ?? []).map((x) => x.rfilename).find((f) => MEDIA.test(f) && !NOT_EXAMPLE.test(f));
  const url = card ? (/^https?:\/\//.test(card) ? card.split("?")[0] : at(card.replace(/^\.?\//, ""))) : file ? at(file) : null;
  return url ? { url, clip: MOVES.test(url) } : null;
}

/** The example a LoRA shows, by its id: a pick's own, or a find's as its last listing had it. Null: it shows none. */
export function previewSource(id: string): { url: string; clip: boolean } | null {
  const pick = curated().find((x) => x.id === id);
  if (pick) return pick.preview ? { url: pick.preview, clip: Boolean(pick.clip) } : null;
  const repo = id.startsWith("hf:") ? id.slice(3) : null;
  if (!repo) return null;
  const seen = gallery[repo];
  if (seen) return { url: seen.url, clip: seen.clip ?? MOVES.test(seen.url) };
  // As its last listing had it; else (a search across models, before that model's page was opened) as indexed.
  const listed = (g.__crackioLoraShown ??= new Map()).get(id);
  const at = index[repo];
  return listed ?? (at?.preview && !hidden.has(repo) ? { url: at.preview, clip: Boolean(at.clip) } : null);
}

/**
 * Every LoRA on Hugging Face made for a model (its bases' adapters), most popular first, or the ones matching words:
 * what the library's page for the model lists after Crackio's own picks (which are left out here; `counts` has their
 * numbers as they are today). Left out: adult LoRAs, real people and other people's characters and brands (by name,
 * tags and example prompts), every LoRA of a maker who publishes explicit ones, LoRAs that aren't a plain add-on (a
 * clip model's in-context, control and sound ones; speed LoRAs, which fight the few-step set-up a model already runs
 * with), copies of a LoRA under another account, and repos that are a dump of hundreds of files.
 *
 * Without words it lists only the LoRAs that show an example: ones whose name and picture were looked at
 * (lora-gallery.json), and the labs' own. A name filter can't tell a LoRA of a real person, or what a picture shows, so
 * the page a beginner lands on holds nothing unseen. Words search everything that passes the filters (`everything`
 * lists it all without words, for the gallery's review), and those finds show no picture.
 */
export async function browseHub(modelId: string, query: string, sort: "downloads" | "likes" | "new" = "downloads", scope: "checked" | "all" | "review" = "checked"): Promise<LoraBrowse> {
  const everything = scope === "review";
  // Whether an adult chose to see adult LoRAs here, and blurred or not (Settings → Preferences).
  const allow = await import("./lora-policy").then((p) => p.adultAllowed()).catch(() => ({ adult: false, blur: true }));
  const m = model(modelId);
  if (!m || !takesLoras(m)) throw new LocalError("Unknown model.", 404);
  const bases = basesFor(modelId);
  if (!bases.length) return { entries: [], counts: {} };
  const words = query.trim().slice(0, 80);
  // Without words the most downloaded are read whatever order is asked (the ones the gallery knows are among them: a
  // base with thousands of LoRAs would drop them from its 300 newest), and put in that order here.
  const order = !words ? "downloads" : sort === "new" ? "createdAt" : sort;
  // Hugging Face matches words against repo names only: "film grain" is asked as written, joined ("filmgrain") and
  // hyphenated ("film-grain"), and its first word alone. Two letters or fewer find too much to be a search there.
  const asked = !words ? [""] : words.length < 3 ? [] : [...new Set([words, words.replace(/s+/g, ""), words.replace(/s+/g, "-"), words.split(/s+/)[0]])].filter((w) => w.length >= 3).slice(0, 3);
  const look = async (): Promise<LoraBrowse> => {
    const lists = await Promise.all(
      bases.slice(0, words ? 3 : 4).flatMap((base) =>
        asked.map((w) =>
          hf<HubModel[]>(`/models?filter=${encodeURIComponent(`base_model:adapter:${base}`)}&sort=${order}&direction=-1&limit=${w ? 60 : 300}${w ? `&search=${encodeURIComponent(w)}` : ""}&${EXPAND}`).catch((err) => {
            if (err instanceof LocalError && err.status === 429) throw err;
            return [] as HubModel[];
          }),
        ),
      ),
    );
    const all = lists.flat();
    const clipModel = m.unit === "clip";
    const text = (h: HubModel) => `${h.id} ${asWords(h.id.split("/")[1] ?? "")} ${(h.cardData?.tags ?? []).join(" ")}`;
    const prompts = (h: HubModel) => (h.cardData?.widget ?? []).map((w) => w.text ?? "").join(" ");
    const words_ = (h: HubModel) => `${prompts(h)} ${[h.cardData?.instance_prompt ?? ""].flat().join(" ")}`;
    const explicit = (h: HubModel) => (h.tags ?? []).includes("not-for-all-audiences") || EXPLICIT.test(text(h)) || EXPLICIT.test(words_(h));
    const tainted = new Set(all.filter(explicit).map((h) => h.id.split("/")[0].toLowerCase()));
    const mine = new Set(curated().filter((e) => e.models.includes(modelId)).map((e) => e.repo.toLowerCase()));
    const counts: LoraBrowse["counts"] = {};
    const seen = new Set<string>();
    // A pick's repo uploaded again under another account isn't another LoRA.
    const names = new Set<string>(curated().map((e) => (e.repo.split("/")[1] ?? "").toLowerCase()));
    const shown = (g.__crackioLoraShown ??= new Map());
    const out: LoraEntry[] = [];
    const rank = (h: HubModel) => (sort === "likes" ? (h.likes ?? 0) : sort === "new" ? Date.parse(h.createdAt ?? "") || 0 : (h.downloads ?? 0));
    for (const h of all.sort((a, b) => rank(b) - rank(a))) {
      const key = h.id.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      if (mine.has(key)) {
        counts[h.id] = { downloads: h.downloads, likes: h.likes };
        continue;
      }
      const [author, name = ""] = key.split("/");
      const plain = asWords(h.id.split("/")[1] ?? "");
      const checked = Boolean(gallery[h.id]) || LABS.has(author);
      // Everything it says of itself: its name (as words too), its tags, its trigger and its example's own prompt.
      const said = `${text(h)} ${words_(h)}`;
      // Never listed, whatever is chosen under Preferences. One that was looked at is judged by its name and tags (its
      // example was seen: a prompt's "forced perspective" or "a child's drawing" means nothing); the rest by all they say.
      const judged = checked ? text(h) : said;
      if (hidden.has(h.id) || MAKERS_OUT.has(author) || NEVER.test(judged) || PEOPLE.test(judged) || IP.test(text(h))) continue;
      // Adult: listed only where an adult chose to see them, and never one that has a word for the young.
      const nsfw =
        (h.tags ?? []).includes("not-for-all-audiences") ||
        tainted.has(author) ||
        MAKERS_ADULT.has(author) ||
        ADULT.test(text(h)) ||
        EXPLICIT.test(said) ||
        SUGGESTIVE.test(text(h)) ||
        (!checked && (ADULT.test(words_(h)) || FETISH.test(said)));
      if (nsfw && (!allow.adult || YOUNG.test(said))) continue;
      const loraFiles = (h.siblings ?? []).filter((x) => /\.safetensors$/i.test(x.rfilename)).length;
      // None to get, or a dump of everything someone trained: not one LoRA to add.
      if (!loraFiles || loraFiles > 30) continue;
      if (clipModel && NEEDS_MORE.test(text(h))) continue;
      // Filed as adapters of the model on Hugging Face, and not LoRAs to switch on: control nets and reference adapters
      // (they need their own inputs), and speed LoRAs under other names (Crackio sets a model's fast set-up itself).
      if (!gallery[h.id] && NOT_AN_ADDON.test(name)) continue;
      if (!gallery[h.id] && /sdxl/.test(modelId) && SDXL_TUNES.test(plain)) continue;
      // Filed under this model on Hugging Face, named for another ("Wan2.2_…" among Z-Image's): one nobody checked goes.
      if (!gallery[h.id] && namesAnotherModel(modelId, name)) continue;
      // The same LoRA uploaded again under another account: the most used copy stands for it.
      if (names.has(name)) continue;
      const entry = { ...foundEntry(h, m), ...written[h.id] };
      if (entry.category === "speed") continue;
      names.add(name);
      // One nobody here looked at. What's left of a model's LoRAs after the checked ones is, for the picture models,
      // mostly a likeness of someone (a first name for a repo, "a photo of … woman" for a prompt; seen on Z-Image, Nov
      // 2026): those go, whatever is chosen.
      if (!checked && PERSON.test(`${name} ${plain} ${words_(h)}`)) continue;
      const example = gallery[h.id] ? { url: gallery[h.id].url, clip: gallery[h.id].clip ?? MOVES.test(gallery[h.id].url) } : LABS.has(author) || (!everything && (words || scope === "all")) ? ownExample(h) : null;
      // Without words: only what was looked at, unless everything is asked for.
      if (!checked && !words && scope === "checked") continue;
      if (!example && !words && scope === "checked") continue;
      if (example) {
        shown.set(entry.id, example);
        Object.assign(entry, { preview: example.url, ...(example.clip ? { clip: true } : {}) });
      }
      // The rest show their maker's example, unseen by Crackio: blurred behind a button when its words say it may be
      // suggestive or is most likely a person (`BLUR_WORDS`, `BLUR_NAMES`).
      // An adult one (listed because an adult chose to see them) is marked, and blurred unless they chose otherwise.
      if (nsfw) Object.assign(entry, { adult: true, ...(checked ? {} : { unchecked: true }), ...(allow.blur && example ? { blur: true } : {}) });
      else if (!checked) {
        const about = `${name} ${plain} ${(h.cardData?.tags ?? []).join(" ")} ${entry.trigger ?? ""}`;
        // Also one almost nobody uses: a LoRA with a handful of downloads and no like is, more often than not, somebody's
        // likeness under a name no list knows ("emma" finds "emmadorschu" beside a style).
        const unknown = (h.downloads ?? 0) < 10 && !h.likes;
        const veiled = Boolean(example) && (unknown || BLUR_NAMES.test(about) || BLUR_WORDS.test(`${about} ${words_(h)}`) || SUGGESTIVE.test(words_(h)));
        Object.assign(entry, { unchecked: true, ...(veiled ? { blur: true } : {}) });
      }
      out.push(entry);
    }
    if (shown.size > 4000) for (const k of [...shown.keys()].slice(0, 1000)) shown.delete(k);
    return { entries: out.slice(0, 400), counts };
  };
  // The review reads it as it is now (a filter may just have changed); the pages share one look for ten minutes.
  // `FILTERS`: a listing made under older word lists must not outlive them (it is kept ten minutes); nor one made
  // under another choice about adult LoRAs.
  return everything ? look() : cached(`browse:${FILTERS}:${allow.adult ? "adult" : "all-ages"}:${allow.blur ? "blur" : "plain"}:${modelId}:${sort}:${scope}:${words.toLowerCase()}`, look);
}

type HubRepo = Omit<HubModel, "siblings"> & { siblings?: { rfilename: string; size?: number; lfs?: { sha256?: string; size?: number } }[] };

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
 * What a find's own card says it does, in a few plain sentences, and the trigger words it names: its README without the
 * front matter, pictures, tables and code. Null when it says nothing (a trainer's empty template), or says too much.
 */
export async function repoAbout(repo: string): Promise<{ about: string | null; trigger?: string }> {
  if (!REPO.test(repo)) throw new LocalError("That isn't a Hugging Face repo.", 400);
  return cached(`about:${repo}`, async () => {
    const res = await fetch(`https://huggingface.co/${repo}/raw/main/README.md`, { headers: { "User-Agent": "crackio" }, signal: AbortSignal.timeout(15_000) }).catch(() => null);
    if (!res?.ok) return { about: null };
    const raw = (await res.text()).slice(0, 60_000);
    const body = raw
      .replace(/^---[\s\S]*?\n---\s*/, "")
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
    // "Use the trigger prompt:" followed by a code block holds it there; else it stands on the line that names it (the
    // paragraph after an empty "Trigger:" line is advice, not the trigger).
    const fenced = /(?:trigger|activate|following prompt)[^\n]{0,60}[:：][ \t]*\n+```[a-z]*\n([^\n`]{2,160})\n```/i.exec(raw)?.[1]?.trim();
    const named = fenced ?? /trigger(?:\s*(?:word|phrase|token|prompt)s?)?[^\n:：]{0,24}[:：][ \t]*[`"“*]*([^\n`"”*]{2,80})/i.exec(body)?.[1]?.trim();
    const trigger = named && !EXPLICIT.test(named) ? cleanTrigger(named) : undefined;
    const prose = body
      .split(/\n\s*\n/)
      .map((para) => para.replace(/\s+/g, " ").trim())
      .filter((para) => para.length >= 40 && !/^(#|\||[-*]\s|>|\d+\.\s)/.test(para) && /[a-z]{3,}\s+[a-z]{2,}/i.test(para) && !/^(download|weights for this model|use (it )?with|you should use|trigger words?|this lora was trained|model description$)/i.test(para));
    let about = "";
    for (const para of prose) {
      if (about && `${about} ${para}`.length > 420) break;
      about = about ? `${about} ${para}` : para;
      if (about.length >= 160) break;
    }
    about = about.replace(/[*_`#]+/g, "").trim();
    if (about.length > 440) about = `${about.slice(0, 430).replace(/\s+\S*$/, "")}…`;
    return { about: about && !EXPLICIT.test(about) ? about : null, ...(trigger ? { trigger } : {}) };
  });
}

/**
 * How a LoRA's tensors must be named for ComfyUI to load them, by model family: a file named another way loads without
 * an error and changes nothing (a diffusers-named FLUX 3 Klein LoRA ran on the 5090 with its trigger and did nothing,
 * Oct 2026). Read in ComfyUI 0.42.1's `comfy/lora.py` (`model_lora_keys_unet`), Nov 2026:
 * - every model: `diffusion_model.…` and `lora_unet_…`;
 * - FLUX.1 / FLUX.2, Qwen-Image, Krea 2, Z-Image: also diffusers' `transformer.…`, `lycoris_…` and bare names;
 * - HiDream: also `transformer.…`, `lycoris_…`; LTX: also bare names;
 * - Wan, FLUX 3, MOSS: nothing more.
 * A raw PEFT save (`base_model.model.…`, what fal's trainer writes) is mapped for none of them. Families not listed here
 * aren't checked.
 * - SDXL: kohya's `lora_unet_…` / `lora_te…`; of diffusers' saves only the old attention-processor names
 *   (`unet.….processor.…`). A newer diffusers save (`unet.….attn2.to_q.lora.down.weight`) ran on an L4 with ComfyUI
 *   0.46 in Nov 2026: 293 keys not loaded, the same picture with and without.
 */
const WRAPPED = /^(base_model\.|unet\.|text_encoder|lora_te\d?_|lora_unet_|lora_transformer_|lora_prior_|lycoris_|transformer\.|diffusion_model\.|model\.)/;
const COMFY_NAMES = /^(diffusion_model\.|lora_unet_)/;
const DIFFUSERS_TOO = /^(diffusion_model\.|lora_unet_|transformer\.|lycoris_|lora_transformer_)/;
const LOADS: [RegExp, { named: RegExp; bare: boolean }][] = [
  [/wan|flux3|moss/, { named: COMFY_NAMES, bare: false }],
  [/flux[12]|qwen|krea-2|z-image/, { named: DIFFUSERS_TOO, bare: true }],
  [/hidream/, { named: DIFFUSERS_TOO, bare: false }],
  [/ltx/, { named: COMFY_NAMES, bare: true }],
  [/sdxl/, { named: /^(diffusion_model\.|lora_unet_|lora_te\d?_|lycoris_|unet\..*\.processor\.)/, bare: false }],
];
/** Whether ComfyUI would load any of a file's tensors on that model; true for a family that isn't checked. */
function loadsOn(modelId: string, keys: string[]): boolean {
  const rule = LOADS.find(([id]) => id.test(modelId))?.[1];
  return !rule || keys.some((k) => (WRAPPED.test(k) ? rule.named.test(k) : rule.bare));
}

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

/**
 * A LoRA's example, small (server/lora-previews): its still, or the short loop of one that moves. Only what the library
 * decided to show (`previewSource`): a pick's example, a find's that was looked at, a lab's own.
 */
export async function loraPreview(id: string, kind: "still" | "clip" | "blur" = "still"): Promise<string | null> {
  const source = previewSource(id);
  if (!source) return null;
  const { loraStill, loraClip, loraBlur } = await import("./lora-previews");
  if (kind === "blur") {
    const token = (await import("./settings").then((m) => m.getSettings()).catch(() => null))?.keys.hf?.trim() || process.env.HF_TOKEN?.trim() || undefined;
    return loraBlur(id, source.url, token);
  }
  // A gated repo's example (Lightricks' LTX LoRAs) is read with your Hugging Face token, like its files.
  const token = (await import("./settings").then((m) => m.getSettings()).catch(() => null))?.keys.hf?.trim() || process.env.HF_TOKEN?.trim() || undefined;
  return kind === "clip" ? (source.clip ? loraClip(id, source.url, token) : null) : loraStill(id, source.url, token);
}

/**
 * Whether you may download a LoRA whose makers ask you to accept their terms on Hugging Face first (Lightricks' LTX
 * LoRAs): "open" when it asks nothing, "no-token" with no Hugging Face token in Crackio (Settings → Accounts),
 * "granted" once your account accepted its terms, "needed" until then. Asked of Hugging Face itself (one of the
 * LoRA's own files, with your token), and kept for twenty seconds only: accepting the terms shows on the next look.
 */
export type LoraAccess = "open" | "granted" | "needed" | "no-token";
export async function loraAccess(repo: string, revision?: string, filePath?: string): Promise<LoraAccess> {
  if (!REPO.test(repo)) throw new LocalError("That isn't a Hugging Face repo.", 400);
  const asked = (g.__crackioLoraAccess ??= new Map());
  const hit = asked.get(repo);
  if (hit && Date.now() - hit.at < 20_000) return hit.value;
  const value = (async (): Promise<LoraAccess> => {
    // A pick brings its file; a find's are looked up (which also says whether it asks for anything).
    let at = revision && filePath ? { revision, path: filePath, gated: true } : null;
    if (!at) {
      const r = await repoFiles(repo);
      if (!r.gated) return "open";
      if (!r.files[0]) return "needed";
      at = { revision: r.revision, path: r.files[0].path, gated: true };
    }
    const token = (await import("./settings").then((m) => m.getSettings()).catch(() => null))?.keys.hf?.trim() || process.env.HF_TOKEN?.trim() || "";
    if (!token) return "no-token";
    const res = await fetch(loraUrl(repo, at.revision, at.path), { method: "HEAD", redirect: "manual", headers: { "User-Agent": "crackio", Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
    // The file itself, or its place on the CDN: yours to read. 401 and 403: not yet.
    if (res.ok || (res.status >= 300 && res.status < 400)) return "granted";
    if (res.status === 401 || res.status === 403) return "needed";
    throw new LocalError(`Hugging Face answered ${res.status}.`, 502);
  })();
  asked.set(repo, { at: Date.now(), value });
  value.catch(() => asked.delete(repo));
  if (asked.size > 200) asked.delete(asked.keys().next().value!);
  return value;
}

/* ------------------------------------------------------------------ downloads */

/**
 * Download a LoRA to these machines: one of Crackio's picks (`id`, every file it has, a Wan pair's two halves) or one
 * found on Hugging Face (`repo`: the file Crackio picks from it, `pickFiles`, or the one named by `path`). Each file is
 * checked against its SHA-256 on the way in, and recorded with what it's for.
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
    // The file named, else the one (or the Wan pair) Crackio picks from the repo.
    const chosen = input.path ? r.files.filter((x) => x.path === input.path) : pickFiles(m, r.files, repo);
    const f = chosen[0];
    if (!f) throw new LocalError(input.path ? "That file isn't a LoRA in that repo." : "That repo has no .safetensors LoRA file.", 404);
    const named = `${repo} ${asWords(repo.split("/")[1] ?? "")} ${r.tags.join(" ")}`;
    // The same rules as the listing: what's never added, and what's added only where an adult chose to see adult LoRAs.
    const maker = repo.split("/")[0].toLowerCase();
    const told = `${named} ${r.trigger ?? ""}`;
    if (hidden.has(repo) || MAKERS_OUT.has(maker) || NEVER.test(told) || PEOPLE.test(told) || IP.test(named)) throw new LocalError("Crackio doesn't download that kind of LoRA.", 403);
    const nsfw = r.tags.includes("not-for-all-audiences") || MAKERS_ADULT.has(maker) || ADULT.test(named) || EXPLICIT.test(told) || SUGGESTIVE.test(named) || (!gallery[repo] && FETISH.test(told));
    if (nsfw) {
      const allow = await import("./lora-policy").then((p) => p.adultAllowed()).catch(() => ({ adult: false, blur: true }));
      if (YOUNG.test(told)) throw new LocalError("Crackio doesn't download that kind of LoRA.", 403);
      if (!allow.adult) throw new LocalError("That's an adult LoRA, and those are off here (Settings → Preferences).", 403);
    }
    // A file whose names the model's ComfyUI loader skips would load without an error and do nothing.
    const keys = r.gated ? null : await headerKeys(repo, r.revision, f.path);
    if (keys?.length && !loadsOn(m.id, keys)) {
      throw new LocalError(`This LoRA's file is saved in a way ComfyUI doesn't read for ${m.name}: it would load and change nothing. Look for a ComfyUI version of it.`, 422);
    }
    const found = foundEntry({ id: repo, sha: r.revision, gated: r.gated, tags: r.tags, cardData: { license: r.licence, instance_prompt: r.trigger } }, m);
    // One whose example was looked at keeps the name, the kind and the trigger words written for it; else its card's.
    const mine = wordsFor(repo);
    const { trigger: said, ...rest } = found;
    const trigger = mine && "trigger" in mine ? mine.trigger || undefined : (said ?? (await repoAbout(repo).catch(() => null))?.trigger);
    entry = {
      ...rest,
      name: mine?.name ?? foundName(repo, f.path, chosen.length > 1 ? 1 : r.files.length),
      ...(mine?.category ? { category: mine.category } : {}),
      ...(mine?.blurb ? { blurb: mine.blurb } : {}),
      files: chosen,
      ...(trigger ? { trigger } : {}),
    };
    files = chosen;
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
        ...(files.length > 1 ? { pair: names.filter((_, j) => j !== i) } : {}),
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

/**
 * A LoRA Crackio knows the source of, started downloading onto a machine that lacks it: one of its picks (checked
 * against its SHA-256 on the way in), or a file once downloaded from Hugging Face (from where it came). Null for one it
 * can't place: your own uploads and trained LoRAs travel from this computer instead (lora-home), and a file put in
 * models/loras by hand has no source.
 */
export async function fetchLora(file: string, target: string): Promise<{ name: string; bytes: number } | null> {
  const pick = curated().find((e) => e.local?.includes(file));
  const part = pick ? pick.files[pick.local!.indexOf(file)] : undefined;
  const rec = part ? undefined : (await readRecords())[file];
  if (!part && (!rec || rec.uploaded || rec.trained || !rec.repo || !rec.path)) return null;
  const spec = part ? { url: loraUrl(pick!.repo, pick!.revision, part.path), bytes: part.bytes, sha256: part.sha256 } : { url: loraUrl(rec!.repo, undefined, rec!.path), bytes: rec!.bytes };
  await installFile({ folder: "loras", name: file, ...spec, role: "lora" }, target);
  return { name: pick?.name ?? rec!.name, bytes: spec.bytes };
}

/** A found file's name in the library: its repo's, and the file's own when the repo has several. */
function foundName(repo: string, filePath: string, count: number) {
  const base = pretty(repo);
  return count > 1 ? `${base} · ${filePath.split("/").pop()!.replace(/\.safetensors$/i, "")}` : base;
}

/** Delete a LoRA file from a machine (its record stays: another machine may still have it). */
export async function removeLora(file: string, target: string, forget = false) {
  // Any name a LoRA can be downloaded under ("left&right_9B", "p@int_sm3ar", "micro details, fine details"), never a path.
  if (!/^[^\\/:*?"<>|\u0000-\u001f]{1,200}\.safetensors$/i.test(file) || file.includes("..")) throw new LocalError("That isn't a LoRA file name.", 400);
  const out = await removeFile("loras", file, target);
  // A test download: what Crackio noted of the file goes too (a LoRA you keep a copy of, uploaded or trained, stays).
  if (forget) await changeRecords((all) => void (!all[file]?.uploaded && !all[file]?.trained && delete all[file]));
  return out;
}
