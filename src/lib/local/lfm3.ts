/**
 * LFM3-VL 2B (Liquid AI, LFM Open License v1.0: free, commercial use under US$10M a year in revenue) as Crackio's
 * bridge runs it (comfyui/crackio_bridge/lfm3.py, from models/lfm3): its two files, pinned to the Hugging Face revision
 * the bridge's bundled config and code (lfm3_vl/) match, and Crackio's own fine-tunes of it. It writes Talk's answers,
 * checks Swap's drawings (the judge) and finds things for Retouch. The bridge's lfm3_setup.py (1.9.2) says what a
 * machine has, and brings its transformers to the range below. Talk's set-up (server/voice/talk-setup) downloads it,
 * and the fine-tunes a tool asks for.
 */

export const LFM3_FOLDER = "lfm3";
export const LFM3_NAME = "LFM3-VL 2B";
export const LFM3_REVISION = "ba44bd51db20a2753f28c273a1571ccaa210d954";
/** transformers in ComfyUI's Python that runs it. */
export const LFM3_TRANSFORMERS = ">=5.21,<6";

const liquid = (path: string) => `https://huggingface.co/LiquidAI/LFM3-VL-2B/resolve/${LFM3_REVISION}/${path}`;

export type Lfm3File = { role: "model" | "tokenizer"; name: string; url: string; bytes: number; sha256: string };

/** What it needs, under the names the bridge looks for. Not gated: no Hugging Face token. */
export const LFM3_FILES: readonly Lfm3File[] = [
  { role: "model", name: "lfm3-vl-2b.safetensors", url: liquid("model.safetensors"), bytes: 3_836_417_920, sha256: "a9bb8b1c159c9d6c3007bc1c7ad8018b599f759d97da2701714e37426283e131" },
  { role: "tokenizer", name: "lfm3-vl-2b-tokenizer.json", url: liquid("tokenizer.json"), bytes: 17_908_258, sha256: "a39eed58008cbcbc09e5b629b81338a654269c64cd13348aaa6090f4db75c7e7" },
];
export const LFM3_BYTES = LFM3_FILES.reduce((s, f) => s + f.bytes, 0);

/**
 * Crackio's fine-tunes (LoRA), each beside the model under its bridge name. Their copies live in data/lfm3/runs/<run>.
 * Each is published in its own Hugging Face repo (`repo`), the file at its bridge name in the repo's root: their cards
 * differ and they ship on different days. An empty `repo` means that one isn't published yet (the user's call), so it
 * doesn't download. `private`: the repo is private until the release, so the download takes the Hugging Face token from
 * Settings → Accounts; set it false once the repo is public. `revision` pins the upload's commit, as LFM3_REVISION
 * does for the model: a newer file pushed to the repo later doesn't reach this Crackio (it would fail the checksum
 * here). The checksum is checked on download only: a machine has one when the bridge lists its name, so a copy saved
 * before a re-save with new metadata still counts.
 */
export type Lfm3LoraKey = "judge" | "retouch" | "chat";
export type Lfm3Lora = { name: string; label: string; bytes: number; sha256: string; run: string; repo: string; revision: string; private: boolean };
export const LFM3_LORAS: Record<Lfm3LoraKey, Lfm3Lora> = {
  judge: { name: "lfm3-vl-2b-lora-judge.safetensors", label: "Crackio's swap judge", bytes: 131_788_304, sha256: "c4a76a5ef91f60fcb4e20a954c93e4b5f447899302844abe1687040956b70edb", run: "judge-v9", repo: "", revision: "", private: true },
  retouch: { name: "lfm3-vl-2b-lora-retouch.safetensors", label: "Crackio's eyes for Retouch", bytes: 131_788_384, sha256: "66a588f0fcfc266331013fad8cf9618ca5224aa26e7863afb3d67b5f3d7ba33a", run: "retouch-v1", repo: "", revision: "", private: true },
  chat: { name: "lfm3-vl-2b-lora-chat.safetensors", label: "Talk's chat voice", bytes: 131_788_312, sha256: "6579669a45c1799815d670c679cbbccde117522408328a4acac8386ed7cd9d91", run: "chat-v1", repo: "", revision: "", private: true },
};

/** Where a fine-tune downloads from (its pinned commit, else main), or null while it isn't published. */
export function lfm3LoraUrl(key: Lfm3LoraKey): string | null {
  const lora = LFM3_LORAS[key];
  return lora.repo ? `https://huggingface.co/${lora.repo}/resolve/${lora.revision || "main"}/${lora.name}` : null;
}

/** The fine-tunes' bytes together. */
export const lfm3LorasBytes = (keys: readonly Lfm3LoraKey[] = []) => keys.reduce((s, k) => s + LFM3_LORAS[k].bytes, 0);

/** transformers' version string in range (5.21 or newer, under 6). */
export function lfm3TransformersOk(version: string | null | undefined) {
  const [major, minor] = (version ?? "").split(".").map((x) => Number.parseInt(x, 10));
  return Number.isFinite(major) && Number.isFinite(minor) && major === 5 && minor >= 21;
}
