import type { VoiceModelId } from "@/lib/voice/models";

/** A word as it's heard in a clip, and when (seconds). */
export type LipWord = { word: string; start: number; end: number };

/** A sentence of a clip: its words as heard (with punctuation) and when it's said. */
export type LipSentence = { id: number; text: string; start: number; end: number };

/** What a clip says, and its shape (server/lipsync/analyze). */
export type LipAnalysis = {
  /** Where it's kept (the clip's own file, its size and time). */
  key: string;
  url: string;
  fps: number;
  width: number;
  height: number;
  duration: number;
  audio: boolean;
  /** Everything it says, as heard. */
  text: string;
  words: LipWord[];
  sentences: LipSentence[];
};

/**
 * A stretch of the clip whose words change: when the old words were said, how early and how late the new ones may run
 * (from just after the words before that stay to just before the next ones), what was said and what's said instead.
 */
export type LipRegion = { from: number; start: number; end: number; until: number; was: string; text: string; sentences: number[] };

/** What a Lip Sync take was asked for (Generation.params.lipsync). */
export type LipsyncAsk = {
  /** The clip, as a media URL, and its name. */
  url: string;
  name?: string;
  /** The analysis it was planned on. */
  analysis: string;
  regions: LipRegion[];
  /** Who says the new words: the clip's own speaker (cloned from it, with permission) or one of your voices. */
  voice: { kind: "clone"; consent: boolean } | { kind: "voice"; id: string };
  /** The speech model. */
  model: VoiceModelId;
  language?: string;
  /**
   * Every line in the chosen voice (one of yours, never the clone): the lines whose words stay are said again and timed
   * word by word onto the clip's own, so its mouths still fit them and its video stays as it is; only changed lines get
   * new mouths.
   */
  whole?: boolean;
  /**
   * The mouths' settings (tests, and a best-quality mode): LatentSync's steps and guidance, where the new mouth takes its
   * looks from ("same": each frame; "open": the most open frame, teeth showing; "pair": that one for loud speech, the
   * most closed one for quiet), and how many frames its 16-frame windows overlap (they cross-fade there). Bridge 1.10.1.
   */
  tuning?: { steps?: number; guidance?: number; reference?: "same" | "open" | "pair"; overlap?: number; refine?: LipsyncRefine };
};

/**
 * Best quality: HuMo 17B redraws LatentSync's mouths lightly (CrackioMouthRefine, bridge 1.10.1) so the teeth, lips and
 * inside of the mouth are the person's own. `denoise` how much it redraws (0.35: σ 0.73 at shift 5), `steps` over the
 * whole schedule as KSampler counts them, `cfg` 1 with a CFG-distilled speed LoRA, `lora` that LoRA's file (tests only:
 * lightx2v's 4-step one is 3.5x faster but airbrushes the skin and makes the teeth bigger). Bridge 1.10.2's finer
 * drawing: `scale` the window round the face (its biggest size times this), `upscale` drawn at `size` even when the face
 * is smaller (finer teeth and lips, shrunk back when pasted), `guided` cfg on the first that many steps only (faster,
 * but the teeth go back to a white bar), `negative` HuMo's negative prompt. Bridge 1.10.3: `area` what HuMo's drawing
 * replaces, "lips" (its lips and the mouth's opening, on LatentSync's frames) or "mouth" (under the nose round the jaw,
 * on the clip's: HuMo can give a smooth face rough skin there).
 */
export type LipsyncRefine = {
  denoise?: number;
  steps?: number;
  cfg?: number;
  sampler?: string;
  lora?: string | null;
  size?: number;
  attention?: "int8" | "pytorch";
  prompt?: string;
  negative?: string;
  scale?: number;
  upscale?: boolean;
  guided?: number;
  area?: "mouth" | "lips";
};

/** How each changed stretch went (Generation.params.lipsyncReport). */
export type LipsyncReport = {
  regions: {
    start: number;
    end: number;
    text: string;
    /** The take used: its length, how much it was sped up to fit, what speech to text heard in it. */
    take: { seconds: number; stretch: number; heard?: string; missed?: number };
    /** SyncNet: how well the new mouths go with the new words, and the original mouths with the original words. */
    sync?: { new: number | null; original: number | null };
    /** How many times the mouth was drawn (a second time when the first fell under the bar), and whether the kept one is still under it. */
    tries?: number;
    low?: boolean;
    /** How far the new lips' colour was pulled back to the original's (a*, b*). */
    lips?: number[] | null;
    frames: number;
  }[];
  /**
   * The lines said again in the new voice (`whole`): how many, how many were timed word by word (the rest as a whole
   * line), how many were said a second time because the first take dropped words, and the voice's name.
   */
  voice?: { name: string; lines: number; timed: number; redone: number };
  machine?: string;
  seconds?: number;
};
