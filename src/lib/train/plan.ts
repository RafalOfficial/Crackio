import { speedOf } from "@/lib/local/fit";
import type { Machine } from "@/lib/local/types";
import { GOAL_IMAGES, STEP_TABLE, type TrainProfile, type TrainWeights } from "./profiles";
import type { SettingKey, TrainGoal, TrainImage, TrainJob, TrainSettings } from "./types";

/**
 * Crackio's picks for a training run and what the run will take, from the set (how many pictures, how big), what it
 * teaches, the model and the machine. Pure and client-safe: the page shows a pick change as you drag, and the server
 * plans a run with the same code before it starts it.
 */

export const MAX_IMAGES = 300;
export const SETTING_KEYS: SettingKey[] = ["steps", "rank", "lr", "resolution", "checkpoints", "previews", "captions", "captionDropout", "offload", "seed"];
export const DEFAULT_SETTINGS: TrainSettings = { steps: 2000, rank: 32, lr: 1e-4, resolution: 1024, checkpoints: 6, previews: true, captions: "auto", captionDropout: 5, offload: false, seed: 42 };

export const RESOLUTIONS = [512, 640, 768, 896, 1024, 1280, 1536];
export const RANKS = [4, 8, 16, 32, 64, 128];

/* ------------------------------------------------------------------ what the machine is */

/** A machine as planning needs it (Settings' snapshot has all of it). */
export type PlanMachine = {
  id: string;
  label: string;
  where: string;
  kind: "this-computer" | "lan" | "rented" | "serverless" | "comfy-cloud";
  online: boolean;
  gpu: { name: string; vendor: string; memoryGb: number | null; unified: boolean; compute?: number } | null;
  ramGb: number | null;
  accel: string | null;
  diskFreeGb: number | null;
  pricePerHour: number | null;
  metered: boolean;
};

/** How fast a machine's GPU is next to an RTX 5090 (local/fit's table: the same one picture times come from). */
export function machineSpeed(m: PlanMachine): number | null {
  if (!m.gpu) return null;
  return speedOf({ gpus: [{ name: m.gpu.name, vendor: m.gpu.vendor, memoryGb: m.gpu.memoryGb, unified: m.gpu.unified, compute: m.gpu.compute }], accel: m.accel ?? "cuda" } as unknown as Machine);
}

/* ------------------------------------------------------------------ the set */

/** The megapixels a picture trains at for a longest-side setting: its own size, up to resolution². */
export const trainedMp = (i: Pick<TrainImage, "width" | "height">, resolution: number) => Math.min(resolution * resolution, i.width * i.height) / 1e6;

export type SetFacts = { count: number; skipped: number; meanMp: number; small: number; longest: number; unpaired: number; waiting: number };

/**
 * The pictures a run trains on: the ones not left out. For an edit LoRA, the pairs: an "after" picture that has its
 * "before" picture.
 */
export const trainable = (images: TrainImage[], goal?: TrainGoal) => images.filter((i) => !i.skip && !i.waiting && (goal !== "edit" || Boolean(i.source)));

/**
 * A set in numbers: how many pictures train, how big they are on average at this resolution, how many are small. For an
 * edit LoRA a picture counts twice as big: its before picture goes through the model beside it, at the same size.
 */
export function setFacts(images: TrainImage[], resolution: number, goal?: TrainGoal): SetFacts {
  const used = trainable(images, goal);
  const mps = used.map((i) => trainedMp(i, resolution) * (goal === "edit" ? 2 : 1));
  const waiting = images.filter((i) => i.waiting).length;
  const unpaired = goal === "edit" ? images.filter((i) => !i.skip && !i.waiting && !i.source).length : 0;
  return {
    unpaired,
    waiting,
    count: used.length,
    skipped: images.length - used.length - waiting - unpaired,
    meanMp: mps.length ? mps.reduce((a, b) => a + b, 0) / mps.length : (resolution * resolution) / 1e6,
    small: used.filter((i) => Math.min(i.width, i.height) < 700).length,
    longest: used.reduce((n, i) => Math.max(n, i.width, i.height), 0),
  };
}

/* ------------------------------------------------------------------ memory: which weights, and whether it fits */

const GIB = 1024 ** 3;
const weightsGb = (w: TrainWeights, bytes?: number) => (bytes ?? w.file?.bytes ?? 0) / GIB;

/** GPU memory a run needs with the whole model on the card, and with most of it streamed from RAM, at `mp` megapixels a picture. */
export function memoryFor(w: TrainWeights, mp: number, rank: number, bytes?: number) {
  const held = weightsGb(w, bytes) || w.needGb * 0.6;
  // What a step works in beyond the weights: grows with the picture, a little with the LoRA's size.
  const working = Math.max(2.5, w.needGb - held) * (0.35 + 0.65 * mp) * (1 + (rank - 32) / 320);
  return { full: held + working, streamed: Math.max(w.streamGb - 4, 3) * (0.35 + 0.65 * mp) + 4 };
}

export type TrainFit = {
  state: "great" | "ok" | "slow" | "no";
  /** The weights to train on here; null when none run. */
  weights: TrainWeights | null;
  /** Most of the model streamed from RAM. */
  offload: boolean;
  /** The longest side that fits (the one asked, or a smaller one). */
  resolution: number;
  /** One line: why. */
  why: string;
  needGb: number;
  /** What it needs with most of the model streamed from RAM (`needGb` when that's how it fits). */
  streamedGb?: number;
};

/**
 * Whether a family trains on a machine, on which of its weights, and how: the first weights that hold on the card at the
 * resolution asked; else streamed from RAM; else a smaller picture size; else it doesn't.
 */
export function fitTraining(profile: TrainProfile, m: PlanMachine, opts: { resolution: number; rank: number; meanMp?: number; sizes?: Record<string, number>; only?: TrainWeights }): TrainFit {
  const none = (why: string): TrainFit => ({ state: "no", weights: null, offload: false, resolution: opts.resolution, why, needGb: 0 });
  const gpu = m.gpu;
  if (!gpu || !gpu.memoryGb) return none(m.online ? "Crackio can't see its GPU" : "Not answering: its GPU isn't known yet");
  if (gpu.unified || m.accel === "mps") return none("Training on Apple GPUs isn't supported yet");
  if (m.kind === "comfy-cloud") return none("Comfy Cloud runs pictures and clips, not training");
  if (m.accel === "cpu") return none("Needs a GPU");
  const nvidia = gpu.vendor === "nvidia";
  const mem = gpu.memoryGb - (m.kind === "this-computer" ? 1.2 : 0.4);
  const candidates = (opts.only ? [opts.only] : profile.weights).filter((w) => !w.nvidia || nvidia);
  if (!candidates.length) return none(`${profile.name}'s trainable weights need an NVIDIA GPU`);
  // RAM: the trainer works on its own copy of the model beside ComfyUI's (FLUX 3 Klein's 10 GB weights held 22.9 GB
  // of RAM at their peak on a rented RTX A4500). A machine with less has its ComfyUI killed mid-run.
  const ram = m.ramGb ?? 0;
  const ramFor = (w: TrainWeights) => (weightsGb(w, opts.sizes?.[w.name]) || w.needGb * 0.6) * 2 + 3;
  // A tenth of the RAM is left to everything else on the machine (a pod's JupyterLab, the desktop).
  const roomy = (w: TrainWeights) => !ram || ram * 0.9 >= ramFor(w);
  const sizes = RESOLUTIONS.filter((r) => r <= opts.resolution).reverse();
  for (const resolution of sizes.length ? sizes : [opts.resolution]) {
    // A smaller longest side shrinks the average picture by about its square.
    const mp = (opts.meanMp ?? (opts.resolution * opts.resolution) / 1e6) * Math.min(1, (resolution / opts.resolution) ** 2);
    for (const w of candidates) {
      const need = memoryFor(w, mp, opts.rank, opts.sizes?.[w.name]);
      const shrunk = resolution < opts.resolution ? ` at ${resolution} px` : "";
      if (need.full <= mem && roomy(w)) {
        const easy = need.full <= mem * 0.8;
        return { state: resolution < opts.resolution ? "ok" : easy ? "great" : "ok", weights: w, offload: false, resolution, why: `${w.label} fits in ${Math.round(gpu.memoryGb)} GB${shrunk}`, needGb: need.full, streamedGb: need.streamed };
      }
    }
    // Streamed, the smallest weights first: there's less to pass through the card at every step, and less to hold
    // in RAM (a 20B model's full precision is 41 GB where its FP8 is 20). INT8 weights last: streamed, a 20B model
    // on them took ComfyUI down after a dozen steps (a CUDA illegal memory access, RTX 3090, Nov 2026), where the
    // same size in FP8 trained through.
    const size = (w: TrainWeights) => weightsGb(w, opts.sizes?.[w.name]) || w.needGb * 0.6;
    const light = [...candidates].sort((a, b) => Number(Boolean(a.nvidia)) - Number(Boolean(b.nvidia)) || size(a) - size(b));
    for (const w of light) {
      const need = memoryFor(w, mp, opts.rank, opts.sizes?.[w.name]);
      const held = weightsGb(w, opts.sizes?.[w.name]) || w.needGb * 0.6;
      if (need.streamed <= mem && (!ram || ram >= Math.max(held + 8, ramFor(w)))) {
        const shrunk = resolution < opts.resolution ? ` at ${resolution} px` : "";
        return { state: "slow", weights: w, offload: true, resolution, why: `Runs${shrunk} with part of the model streamed from RAM`, needGb: need.streamed, streamedGb: need.streamed };
      }
    }
  }
  const least = Math.min(...candidates.map((w) => memoryFor(w, 0.27, 16).streamed));
  // The GPU would do, the RAM doesn't.
  if (ram && least <= mem && !candidates.some(roomy)) return none(`Needs about ${Math.ceil(Math.min(...candidates.map(ramFor)))} GB of RAM (this machine has ${Math.round(ram)})`);
  // As the size of card it takes (what the desktop or the machine's own programs hold counts against this one's).
  return none(`Needs a GPU with about ${Math.ceil(least + (gpu.memoryGb - mem))} GB (this one has ${Math.round(gpu.memoryGb)})`);
}

/* ------------------------------------------------------------------ time */

export type TrainEstimate = {
  /** Seconds a step takes. */
  pace: number;
  /** The whole run: getting ready, the steps, test pictures. */
  seconds: number;
  low: number;
  high: number;
  parts: { ready: number; steps: number; previews: number };
  /** Where the pace comes from: a run on this card, on another card (scaled), or Crackio's table. */
  basis: "measured" | "scaled" | "table";
  /** What it costs on a machine billed by time. */
  cost: number | null;
};

/** A measured pace: seconds a step at `mp` megapixels on a card of `speed`, with these weights. */
export type PaceRecord = { family: string; weights: string; gpu: string; speed: number | null; mp: number; pace: number; offload: boolean; peakGb: number | null; at: number };

/** Bigger pictures cost a little more than their pixels (attention grows faster than the tokens). */
const mpCost = (mp: number) => Math.max(0.2, mp) ** 1.15;

export function estimateTraining(input: {
  profile: TrainProfile;
  weights: TrainWeights;
  machine: PlanMachine;
  gpuKey?: string;
  settings: TrainSettings;
  facts: SetFacts;
  offload: boolean;
  /** Seconds a test picture takes on this machine (the model's own estimate), when known. */
  pictureSeconds?: number | null;
  records?: PaceRecord[];
}): TrainEstimate | null {
  const { profile, weights, machine, settings, facts } = input;
  const speed = machineSpeed(machine);
  if (!speed) return null;
  const mine = (input.records ?? []).filter((r) => r.family === profile.id && r.weights === weights.id && r.offload === input.offload);
  const same = mine.filter((r) => input.gpuKey && r.gpu === input.gpuKey).sort((a, b) => b.at - a.at)[0];
  const other = mine.filter((r) => r.speed).sort((a, b) => b.at - a.at)[0];
  let pace: number;
  let basis: TrainEstimate["basis"];
  if (same) {
    pace = (same.pace / mpCost(same.mp)) * mpCost(facts.meanMp);
    basis = "measured";
  } else if (other?.speed) {
    pace = ((other.pace * other.speed) / speed / mpCost(other.mp)) * mpCost(facts.meanMp);
    basis = "scaled";
  } else {
    // Cards without tensor cores (GTX 10 and 16) train in 32-bit floats: about twice the work.
    const old = machine.gpu?.compute !== undefined && machine.gpu.compute < 7.5 ? 2 : 1;
    pace = ((profile.seconds5090 * (weights.cost ?? 1) * mpCost(facts.meanMp)) / speed) * old * (input.offload ? 1.7 : 1);
    basis = "table";
  }
  const steps = pace * settings.steps;
  // Getting ready: the model read from disk, each picture encoded, the words read.
  const ready = 50 + (facts.count * 0.9) / Math.min(1, speed * 2) + (settings.captions === "auto" ? facts.count * 2.5 : 0);
  // Test pictures: two per saved version, plus swapping the trained model for the one that draws (and back).
  const picture = input.pictureSeconds ?? 8 / speed;
  const previews = settings.previews ? (settings.checkpoints + 1) * (2 * picture + 35) : 0;
  const seconds = ready + steps + previews;
  const spread = basis === "measured" ? 0.12 : basis === "scaled" ? 0.25 : 0.4;
  return {
    pace,
    seconds,
    low: seconds * (1 - spread * 0.6),
    high: seconds * (1 + spread),
    parts: { ready, steps, previews },
    basis,
    cost: machine.pricePerHour ? (seconds / 3600) * machine.pricePerHour : null,
  };
}

/** "about 45 min", "about 1 h 20 min", "about 3 h". */
export function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds)) return "—";
  if (seconds < 90) return `${Math.max(1, Math.round(seconds / 5) * 5)} s`;
  const min = seconds / 60;
  if (min < 60) return `${Math.round(min < 10 ? min : min / 5) * (min < 10 ? 1 : 5)} min`;
  const h = Math.floor(min / 60);
  const rest = Math.round((min - h * 60) / 5) * 5;
  return rest === 60 ? `${h + 1} h` : rest ? `${h} h ${rest} min` : `${h} h`;
}

/* ------------------------------------------------------------------ Crackio's picks */

function between(table: [number, number][], n: number) {
  if (n <= table[0][0]) return table[0][1];
  for (let i = 1; i < table.length; i++) {
    const [x0, y0] = table[i - 1];
    const [x1, y1] = table[i];
    if (n <= x1) return y0 + ((y1 - y0) * (n - x0)) / (x1 - x0);
  }
  return table[table.length - 1][1];
}

/** Steps for a set of `count` pictures teaching `goal`, to the nearest hundred. */
export const stepsFor = (goal: TrainGoal, count: number, profile?: TrainProfile | null) => Math.max(300, Math.round((between(STEP_TABLE[goal], Math.max(1, count)) * (profile?.stepScale ?? 1)) / 100) * 100);

export type Plan = {
  settings: TrainSettings;
  /** Why each pick is what it is, in a sentence. */
  why: Record<SettingKey, string>;
};

/**
 * Crackio's pick for every setting, with the reason. `fit`: what the machine allows (a smaller picture size, streaming),
 * when a machine is chosen.
 */
export function planFor(input: { goal: TrainGoal; images: TrainImage[]; profile: TrainProfile | null; fit?: TrainFit | null; memoryGb?: number | null }): Plan {
  const { goal, profile } = input;
  const edit = goal === "edit";
  const count = trainable(input.images, goal).length;
  const base = profile?.resolution ?? DEFAULT_SETTINGS.resolution;
  // Pictures all smaller than the usual size: the longest side they really have, on the list.
  const longest = trainable(input.images, goal).reduce((n, i) => Math.max(n, i.width, i.height), 0);
  const capped = longest && longest < base * 0.9 ? (RESOLUTIONS.filter((r) => r <= longest).pop() ?? RESOLUTIONS[0]) : base;
  const resolution = Math.min(capped, input.fit?.state !== "no" && input.fit ? input.fit.resolution : capped);
  const steps = stepsFor(goal, count, profile);
  const tight = input.memoryGb != null && input.memoryGb < 14;
  const rank = tight ? Math.min(16, profile?.rank ?? 32) : (profile?.rank ?? 32);
  const lr = (profile?.lr ?? 1e-4) * (goal === "style" ? 0.8 : 1);
  const checkpoints = steps >= 2400 ? 8 : steps >= 1200 ? 6 : 4;
  const looks = count ? Math.round(steps / count) : 0;
  const settings: TrainSettings = {
    steps,
    rank,
    lr,
    resolution,
    checkpoints,
    previews: true,
    // An edit LoRA's words are your instruction: nothing to describe, and a pair never goes in without them.
    captions: edit ? "trigger" : "auto",
    captionDropout: edit ? 0 : goal === "style" ? 10 : 5,
    offload: Boolean(input.fit?.offload),
    seed: 42,
  };
  const why: Plan["why"] = {
    steps: count ? `${count} ${edit ? "pairs" : "pictures"}: each is seen about ${looks} times. Bigger sets need fewer looks at each ${edit ? "pair" : "picture"}.` : `Grows with the set: add ${edit ? "pairs" : "pictures"} and it follows.`,
    rank: tight ? "Kept small for this card's memory." : edit ? "Room for the change without memorising single pairs." : goal === "style" ? "Room for a look's textures and colours without memorising single pictures." : "Room for a face or a product's details without memorising single pictures.",
    lr: goal === "style" ? "A little gentler than usual: looks are learned best slowly." : `${profile?.maker || "The model's makers"} train at this rate.`,
    resolution: resolution < capped ? "Smaller than usual so it fits this card's memory." : capped < base ? "Your pictures are smaller than the model's usual size: they train at their own." : `The size ${profile?.name ?? "the model"} draws at: faces and fine detail need it.`,
    checkpoints: "The best version is often not the last one: with a few saved along the way you can pick.",
    previews: "Two test pictures with every saved version show how it's coming along, for a minute or so each time.",
    captions: edit ? "Every pair trains with your instruction, or with its own words where you wrote some." : goal === "style" ? "Crackio describes what each picture shows, so the look is what's left to learn." : "Crackio describes the clothes, place and light in each picture, so they aren't learned as part of the subject.",
    captionDropout: edit ? "A pair always goes in with its instruction." : "Now and then a picture goes in without words, so the LoRA still works when a prompt says little.",
    offload: input.fit?.offload ? "The model doesn't fit this card whole: part of it waits in RAM." : "The whole model fits on this card.",
    seed: "Any number: the same one repeats the same run.",
  };
  return { settings, why };
}

/** A job's settings with Crackio's picks filled in for the ones still on auto. */
export function resolvedSettings(job: Pick<TrainJob, "settings" | "auto">, plan: Plan): TrainSettings {
  const out = { ...job.settings } as Record<SettingKey, TrainSettings[SettingKey]>;
  for (const key of job.auto) out[key] = plan.settings[key];
  return out as TrainSettings;
}

/* ------------------------------------------------------------------ words */

/** A made-up word from a name: rare enough that the model has no picture of it already ("Lena" → "lenavq"). */
export function suggestTrigger(name: string) {
  const stem = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 6);
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const odd = "qxzvkj";
  const tail = `${odd[h % odd.length]}${odd[(h >>> 3) % odd.length]}`;
  return `${stem || "my"}${tail}`;
}

/** What the trigger stands for in a caption: "lenavq woman", or just the trigger. */
export const subjectWords = (job: Pick<TrainJob, "trigger" | "noun" | "goal">) => (job.goal === "style" ? job.trigger : [job.trigger, job.noun.trim()].filter(Boolean).join(" ")).trim();

/**
 * The words a picture trains with. Yours, when you wrote some (with the trigger put in if it's missing); else the
 * trigger with what Crackio saw around the subject; else the trigger alone.
 */
export function captionFor(job: Pick<TrainJob, "trigger" | "noun" | "goal" | "instruction">, image: Pick<TrainImage, "caption">): string {
  const subject = subjectWords(job);
  const text = (image.caption ?? "").replace(/\s+/g, " ").trim();
  // An edit LoRA's pair trains with the instruction: the pair's own where it has one, else the job's.
  if (job.goal === "edit") return text || (job.instruction ?? "").replace(/\s+/g, " ").trim();
  if (job.goal === "style") {
    if (!text) return subject ? `a picture in ${subject} style` : "";
    if (!subject || text.toLowerCase().includes(job.trigger.toLowerCase())) return text;
    return `${text.replace(/[.,;]+$/, "")}, in ${subject} style`;
  }
  if (!text) return subject ? `a picture of ${subject}` : "";
  if (!subject || text.toLowerCase().includes(job.trigger.toLowerCase())) return text;
  return `${subject}, ${text}`;
}

/** What test pictures show for a goal; {t} is the subject ("lenavq woman") or the style's trigger. */
export const TEST_PROMPTS: Record<TrainGoal, string[]> = {
  person: ["{t}, a portrait on a city street at golden hour, looking at the camera, shallow depth of field", "{t} sitting in a cafe by the window, reading, candid photo, soft daylight"],
  character: ["{t} standing in a forest clearing in morning light, full body", "{t} in a busy city street at night, neon signs, medium shot"],
  object: ["{t} on a marble table, studio product photo, soft light from the left", "a hand holding {t} outdoors in bright sunlight, close-up"],
  style: ["a lighthouse on a cliff at sunset, in {t} style", "a portrait of an old sailor with a white beard, in {t} style"],
  // An edit LoRA's test pictures are before pictures redone with the instruction (server/train/run `editTests`).
  edit: [],
};

export function testPrompts(job: Pick<TrainJob, "trigger" | "noun" | "goal" | "testPrompts">): string[] {
  const own = job.testPrompts.map((p) => p.trim()).filter(Boolean);
  const subject = subjectWords(job) || "it";
  return (own.length ? own : TEST_PROMPTS[job.goal]).slice(0, 4).map((p) => (p.includes("{t}") ? p.replaceAll("{t}", subject) : p));
}

/** What a set of this size is good for, in a line (and whether it can train at all). */
export function setVerdict(goal: TrainGoal, count: number): { ok: boolean; tone: "bad" | "thin" | "good" | "great"; text: string } {
  const g = GOAL_IMAGES[goal];
  if (goal === "edit") {
    if (count < g.least) return { ok: false, tone: "bad", text: `Add at least ${g.least} pairs (${g.ideal[0]}–${g.ideal[1]} is where it gets good).` };
    if (count < g.few) return { ok: true, tone: "thin", text: `${count} pairs will work, but it's thin: ${g.ideal[0]}–${g.ideal[1]} give a LoRA that makes the change to pictures unlike these.` };
    if (count < g.ideal[0]) return { ok: true, tone: "good", text: `${count} pairs is enough. A few more, of other subjects and places, would make it sturdier.` };
    return { ok: true, tone: "great", text: `${count} pairs: a good set.` };
  }
  if (count < g.least) return { ok: false, tone: "bad", text: `Add at least ${g.least} pictures (${g.ideal[0]}–${g.ideal[1]} is where it gets good).` };
  if (count < g.few) return { ok: true, tone: "thin", text: `${count} pictures will work, but it's thin: ${g.ideal[0]}–${g.ideal[1]} give a LoRA that holds up in new scenes.` };
  if (count < g.ideal[0]) return { ok: true, tone: "good", text: `${count} pictures is enough. A few more from other angles and places would make it sturdier.` };
  return { ok: true, tone: "great", text: `${count} pictures: a good set.` };
}

/** Each setting in plain words: what it is, and what turning it up or down does. */
export const SETTING_HELP: Record<SettingKey, { label: string; what: string; more: string; unit?: string }> = {
  steps: {
    label: "Steps",
    what: "How many times the model is shown one of your pictures and corrected.",
    more: "Too few and the LoRA hardly shows. Too many and it starts copying your pictures instead of learning from them: the same pose, the same background. Time grows with it one for one.",
  },
  rank: {
    label: "Size (rank)",
    what: "How much the LoRA can hold.",
    more: "A bigger one keeps finer detail, makes a bigger file, needs a little more memory, and memorises single pictures sooner. 32 suits most things; 16 is safer for small sets; 64 only if a likeness stops improving.",
  },
  lr: {
    label: "Learning rate",
    what: "How hard each correction pushes.",
    more: "Higher learns faster and breaks sooner (colours burn, the picture turns to noise). Lower is steadier and needs more steps. Leave it unless a run failed.",
  },
  resolution: {
    label: "Picture size",
    what: "The longest side your pictures are trained at. Each keeps its own shape; nothing is cropped square or enlarged.",
    more: "Bigger shows the model more detail (faces, labels) and takes more memory and time: 768 px is about half the work of 1024 px.",
    unit: "px",
  },
  checkpoints: {
    label: "Versions to save",
    what: "The LoRA is saved this many times along the way, the last time when it's done.",
    more: "The best version is often from the middle of a run. Each is a file of its own on the GPU machine; pick one when it's done and the rest can go.",
  },
  previews: {
    label: "Test pictures",
    what: "Draws two pictures with every saved version, and once without the LoRA to compare.",
    more: "You see it learn, and Crackio can tell if a LoRA changes nothing. It adds about a minute per version: the model you train on makes room for the one that draws, then comes back.",
  },
  captions: {
    label: "Captions",
    what: "The words each picture is trained with.",
    more: "The model learns whatever the words don't explain. So Crackio describes everything except what you're teaching (clothes, place, light for a person; what's shown for a style) and adds your trigger word. Trigger only skips the describing: quicker, and the LoRA soaks up backgrounds and outfits more.",
  },
  captionDropout: {
    label: "Pictures without words",
    what: "The share of steps where a picture goes in with no caption at all.",
    more: "A little of this keeps the LoRA working with short prompts and helps the model follow your prompt strongly. Styles like a bit more.",
    unit: "%",
  },
  offload: {
    label: "Stream from RAM",
    what: "Keeps most of the model in the computer's memory and passes it through the GPU piece by piece.",
    more: "Lets a card with too little memory train at all, at about half the speed. Crackio switches it on by itself when the model doesn't fit.",
  },
  seed: {
    label: "Seed",
    what: "The number the run's random choices start from.",
    more: "The same seed with the same pictures and settings gives the same LoRA. Change it to get a different one from the same set.",
  },
};
