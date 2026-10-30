import type { Generation } from "@/lib/generations/types";
import { takeKey, type TakeKey } from "@/lib/hooks/use-library";
import { GENERAL } from "@/lib/library/types";
import { aspectById } from "@/lib/shot";
import { toolBySlug } from "@/lib/tools";

/** One card in the Library: an output of a generation, or a generation still rendering (or one that failed). */
export type Take = {
  gen: Generation;
  index: number;
  key: TakeKey;
  /** GENERAL or the project it's filed in. */
  folder: string;
  /** What it is, or will be once it renders. */
  kind: "image" | "video";
  /** The tool it came from, as the filter knows it (see toolOf). */
  tool: string;
  /** Width over height. */
  ratio: number;
};

const VIDEO_TOOLS = new Set(["motion", "recast", "video"]);

/** Quick shots from the home composer were once saved as "home"; clips made before the Video page existed, under Motion. */
export const toolOf = (g: Generation) => (g.tool === "home" ? "image" : g.tool === "motion" && g.params?.kind === "video" ? "video" : g.tool);

export const toolName = (t: string) =>
  t === "image" ? "Image" : t === "video" ? "Video" : t === "templates" ? "Templates" : (toolBySlug(t)?.name ?? t.charAt(0).toUpperCase() + t.slice(1));

/** The app icon for a tool: its own glyph and hue, or the graphite one for the pages that aren't tools. */
export function toolIcon(t: string): { glyph: string; hue?: string } {
  const tool = toolBySlug(t);
  if (tool) return { glyph: tool.glyph, hue: tool.hue };
  return { glyph: t === "video" ? "/icons/video.png" : t === "templates" ? "/icons/templates.png" : "/icons/image.png" };
}

export function takesOf(gen: Generation, folderOf: (key: TakeKey) => string): Take[] {
  const tool = toolOf(gen);
  const aspect = aspectById(gen.aspect);
  if (gen.status !== "done" || !gen.outputs.length) {
    const kind = gen.params?.kind === "video" || VIDEO_TOOLS.has(gen.tool) ? "video" : "image";
    // Still rendering, or failed: it shows in General until there's a take to file.
    return [{ gen, index: 0, key: takeKey(gen.id, 0), folder: GENERAL, kind, tool, ratio: aspect.w / aspect.h }];
  }
  return gen.outputs.map((o, index) => {
    const key = takeKey(gen.id, index);
    return { gen, index, key, folder: folderOf(key), kind: o.kind, tool, ratio: o.width && o.height ? o.width / o.height : aspect.w / aspect.h };
  });
}

const haystacks = new WeakMap<Generation, string>();

/** Every word of the search appears somewhere in the take's prompt, model, tool or shape. */
export function matches(take: Take, words: string[]) {
  if (!words.length) return true;
  const g = take.gen;
  let hay = haystacks.get(g);
  if (hay === undefined) {
    hay = [g.prompt, g.compiledPrompt, g.modelName, toolName(toolOf(g)), g.aspect].filter(Boolean).join(" \n ").toLowerCase();
    haystacks.set(g, hay);
  }
  const h = `${hay} ${take.kind === "video" ? "video clip" : "image still photo"}`;
  return words.every((w) => h.includes(w));
}

/** "0:08", "1:10", "1:02:03". */
export function clock(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** "840 KB", "12.4 MB". */
export function fileSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(bytes < 10 * 1024 ** 2 ? 1 : 0)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/** "42 s", "1 min 42 s", "1 h 3 min". */
export function span(ms: number) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** A name to save a take under: "crackio-storyboard-2026-10-21-1432-2.mp4". */
export function downloadName(take: Take) {
  const url = take.gen.outputs[take.index]?.url ?? "";
  const ext = /\.([a-z0-9]+)(?:[?#]|$)/i.exec(url)?.[1] ?? (take.kind === "video" ? "mp4" : "png");
  const d = new Date(take.gen.createdAt);
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  const n = take.gen.outputs.length > 1 ? `-${take.index + 1}` : "";
  return `crackio-${take.tool}-${stamp}${n}.${ext}`;
}

/** Saves a file the way a download link would. */
export function download(url: string, name: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
