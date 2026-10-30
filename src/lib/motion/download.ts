import "server-only";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { nanoid } from "nanoid";
import { baseArgs, friendly, lastError, runYtdlp, ytdlp, type Ytdlp } from "@/lib/server/ytdlp";
import { ToolError, uniqueName } from "./workspace";

/**
 * Footage, songs and podcasts from the internet, for Motion: what a link is (title, length,
 * chapters), its transcript timed to the word when the site has captions, and the media itself,
 * whole or in parts, downloaded with yt-dlp into the project folder.
 */

export type Found = { title: string; url: string; channel?: string; duration?: number; views?: number };

type Format = { height?: number; vcodec?: string; acodec?: string; tbr?: number; filesize?: number; filesize_approx?: number };

export type SourceInfo = {
  url: string;
  title: string;
  channel?: string;
  duration?: number;
  uploaded?: string;
  views?: number;
  description?: string;
  chapters: { start: number; title: string }[];
  heights: number[];
  live: boolean;
  formats: Format[];
  captions: { lang: string; auto: boolean } | null;
  playlist?: { title: string; entries: Found[] };
};

/** [start, end, text] in seconds of the source. */
type Span = [number, number, string];

export type Transcript = {
  title: string;
  source: string;
  duration?: number;
  language: string;
  captions: "auto" | "creator";
  lines: Span[];
  /** Every word with its own times, when the site's captions carry them (YouTube's do). */
  words?: Span[];
};

/** Leave this much room on the drive after a download. */
const KEEP_FREE = 1e9;
/** Rough sizes when a site doesn't say (bytes per second of picture and sound). */
const RATE: Record<number, number> = { 360: 45e3, 480: 70e3, 720: 110e3, 1080: 230e3, 1440: 550e3, 2160: 1.1e6 };
const SOUND_RATE = 16e3;

async function tool(): Promise<Ytdlp> {
  const yt = await ytdlp();
  if (!yt) throw new ToolError("yt-dlp isn't installed on this computer, so nothing can be downloaded. Tell the user to install it (pip install yt-dlp, or winget install yt-dlp) or to attach the file instead.");
  return yt;
}

/** m:ss.d (h:mm:ss.d past an hour). */
export function clock(t: number) {
  const s = Math.max(0, t);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = (s % 60).toFixed(1).padStart(4, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** A length: m:ss, or h:mm:ss. */
export const span = (t: number) => clock(Math.round(t)).replace(/\.\d$/, "");

/** 12m05s, for file names. */
export const stamp = (t: number) => {
  const s = Math.round(t);
  const h = Math.floor(s / 3600);
  return `${h ? `${h}h` : ""}${String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, "0")}m${String(s % 60).padStart(2, "0")}s`;
};

const json = (out: string) => {
  try {
    return JSON.parse(out) as Record<string, unknown>;
  } catch {
    return null;
  }
};

const found = (e: Record<string, unknown>): Found => ({
  title: String(e.title ?? "Untitled"),
  url: String(e.webpage_url ?? e.url ?? (e.id ? `https://www.youtube.com/watch?v=${e.id}` : "")),
  channel: typeof e.channel === "string" ? e.channel : typeof e.uploader === "string" ? e.uploader : undefined,
  duration: typeof e.duration === "number" ? e.duration : undefined,
  views: typeof e.view_count === "number" ? e.view_count : undefined,
});

export const foundLine = (f: Found) =>
  `- ${f.title}${f.channel ? ` (${f.channel})` : ""}${f.duration ? `, ${span(f.duration)}` : ""}${f.views ? `, ${f.views.toLocaleString("en-US")} views` : ""}: ${f.url}`;

/** YouTube videos for a search, best matches first. */
export async function searchVideos(query: string, signal: AbortSignal, count = 8): Promise<Found[]> {
  const yt = await tool();
  const q = query.replace(/\s+/g, " ").trim().slice(0, 200);
  const r = await runYtdlp(yt.cmd, [...baseArgs(yt), "--flat-playlist", "-J", "--", `ytsearch${count}:${q}`], { timeoutMs: 60_000, signal });
  const j = json(r.out);
  if (!j) throw new ToolError(`The search failed: ${friendly(lastError(r), "youtube")}`);
  return ((j.entries as Record<string, unknown>[] | undefined) ?? []).map(found).filter((f) => f.url);
}

/** Captions to use: machine captions in the video's own language first (they're timed to the word), then the creator's. */
function pickCaptions(j: Record<string, unknown>): SourceInfo["captions"] {
  const subs = Object.keys((j.subtitles as object) ?? {}).filter((k) => k !== "live_chat");
  const auto = Object.keys((j.automatic_captions as object) ?? {});
  const lang = typeof j.language === "string" ? j.language.split("-")[0] : "";
  const orig = auto.find((k) => k.endsWith("-orig")) ?? auto.find((k) => lang && k === lang);
  if (orig) return { lang: orig, auto: true };
  const own = subs.find((k) => lang && k.split("-")[0] === lang) ?? subs[0];
  if (own) return { lang: own, auto: false };
  const en = auto.find((k) => k === "en");
  return en ? { lang: en, auto: true } : null;
}

/** What a link is, without downloading it. */
export async function readInfo(url: string, signal: AbortSignal): Promise<SourceInfo> {
  const yt = await tool();
  const r = await runYtdlp(yt.cmd, [...baseArgs(yt), "--flat-playlist", "-J", "--", url], { timeoutMs: 90_000, signal });
  const j = json(r.out);
  if (r.code !== 0 || !j) throw new ToolError(`Couldn't read ${url}: ${friendly(lastError(r), url)}`);
  const title = String(j.title ?? j.fulltitle ?? "Untitled");
  if (j._type === "playlist") {
    return {
      url,
      title,
      chapters: [],
      heights: [],
      live: false,
      formats: [],
      captions: null,
      playlist: { title, entries: ((j.entries as Record<string, unknown>[] | undefined) ?? []).map(found).filter((f) => f.url) },
    };
  }
  const formats = ((j.formats as Format[] | undefined) ?? []).filter((f) => f && typeof f === "object");
  const date = typeof j.upload_date === "string" && /^\d{8}$/.test(j.upload_date) ? `${j.upload_date.slice(0, 4)}-${j.upload_date.slice(4, 6)}-${j.upload_date.slice(6)}` : undefined;
  return {
    url: String(j.webpage_url ?? url),
    title,
    channel: typeof j.channel === "string" ? j.channel : typeof j.uploader === "string" ? j.uploader : undefined,
    duration: typeof j.duration === "number" ? j.duration : undefined,
    uploaded: date,
    views: typeof j.view_count === "number" ? j.view_count : undefined,
    description: typeof j.description === "string" ? j.description : undefined,
    chapters: ((j.chapters as { start_time?: number; title?: string }[] | undefined) ?? []).map((c) => ({ start: Number(c.start_time) || 0, title: String(c.title ?? "") })),
    heights: [...new Set(formats.filter((f) => f.height && f.vcodec !== "none").map((f) => f.height!))].sort((a, b) => a - b),
    live: j.is_live === true || j.live_status === "is_live" || j.live_status === "is_upcoming",
    formats,
    captions: pickCaptions(j),
  };
}

/** About how many bytes a download takes: the site's own sizes where it gives them, typical rates where not. */
export function estimateBytes(info: SourceInfo, get: "video" | "audio", height: number, seconds: number): number {
  const d = info.duration || seconds;
  const rate = (f: Format) => {
    const size = f.filesize ?? f.filesize_approx;
    if (size && d) return size / d;
    return f.tbr ? f.tbr * 125 : 0;
  };
  const sounds = info.formats.filter((f) => f.vcodec === "none" && f.acodec && f.acodec !== "none").map(rate).filter(Boolean);
  const sound = sounds.length ? Math.max(...sounds) : SOUND_RATE;
  if (get === "audio") return sound * seconds;
  const fits = info.heights.filter((h) => h <= height);
  const h = fits.length ? Math.max(...fits) : (info.heights[0] ?? height);
  // The H.264 file the download prefers, measured where the site gives sizes (streamed variants run larger).
  const at = info.formats.filter((f) => f.height === h && f.vcodec && f.vcodec !== "none");
  const sized = at.filter((f) => f.filesize || f.filesize_approx);
  const pool = sized.length ? sized : at;
  const h264 = pool.filter((f) => /^(avc|h264)/.test(f.vcodec ?? ""));
  const pictures = (h264.length ? h264 : pool).map(rate).filter(Boolean);
  const picture = pictures.length ? Math.max(...pictures) : (RATE[h] ?? RATE[720]);
  return (picture + sound) * seconds;
}

/** Free space on the drive that holds `dir`. */
export async function freeBytes(dir: string) {
  try {
    const s = await fs.statfs(dir);
    return s.bavail * s.bsize;
  } catch {
    return Infinity;
  }
}

export const gb = (bytes: number) => `${(bytes / 1e9).toFixed(bytes < 1e10 ? 1 : 0)} GB`;
export const size = (bytes: number) => (bytes >= 1e9 ? gb(bytes) : `${Math.max(1, Math.round(bytes / 1e6))} MB`);

/** Refuses a download that would leave the drive (nearly) full. */
export async function checkRoom(dir: string, bytes: number) {
  const free = await freeBytes(dir);
  if (free - bytes < KEEP_FREE)
    throw new ToolError(
      `Not enough room on this drive: about ${gb(bytes)} needed and ${gb(free)} free (Crackio keeps 1 GB spare). Download a part (start and end), at a lower max_height or just the audio, or tell the user to free some space.`,
    );
}

/* ---------------------------------------------------------------- captions */

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };
const plain = (s: string) =>
  s
    .replace(/<[^>]*>/g, "")
    .replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, (_, e: string) => ENTITIES[e] ?? "")
    .replace(/\s+/g, " ")
    .trim();
const r2 = (n: number) => Math.round(n * 100) / 100;

/** YouTube's json3 captions: each event is a line, and machine captions time every word inside it. */
function fromJson3(raw: string): { lines: Span[]; words: Span[] } {
  const j = JSON.parse(raw) as { events?: { tStartMs?: number; dDurationMs?: number; segs?: { utf8?: string; tOffsetMs?: number }[] }[] };
  const events = (j.events ?? []).filter((e) => e.segs?.some((s) => s.utf8?.trim()));
  const lines: Span[] = [];
  const words: Span[] = [];
  // Creators' captions come one piece per line: there are no word times to give.
  const byWord = events.filter((e) => e.segs!.filter((s) => s.utf8?.trim()).length > 1).length > events.length * 0.3;
  events.forEach((e, i) => {
    const start = (e.tStartMs ?? 0) / 1000;
    const next = events[i + 1] ? (events[i + 1].tStartMs ?? 0) / 1000 : start + (e.dDurationMs ?? 0) / 1000;
    const end = Math.min(start + (e.dDurationMs ?? 0) / 1000, Math.max(next, start + 0.2));
    lines.push([r2(start), r2(end), plain(e.segs!.map((s) => s.utf8 ?? "").join(""))]);
    if (!byWord) return;
    const segs = e.segs!.filter((s) => s.utf8?.trim());
    segs.forEach((s, k) => {
      const at = start + (s.tOffsetMs ?? 0) / 1000;
      const after = segs[k + 1] ? start + (segs[k + 1].tOffsetMs ?? 0) / 1000 : next;
      const word = plain(s.utf8 ?? "");
      // A word lasts until the next one starts, but not through a pause.
      words.push([r2(at), r2(Math.max(at + 0.05, Math.min(after, at + 0.25 + 0.075 * word.length))), word]);
    });
  });
  return { lines: lines.filter((l) => l[2]), words: words.filter((w) => w[2]) };
}

const cueTime = (s: string) => {
  const m = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/.exec(s);
  return m ? Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, "0")) / 1000 : NaN;
};

/** WebVTT or SubRip: one line per cue (rolling captions that repeat the last line are folded). */
function fromCues(raw: string): Span[] {
  const lines: Span[] = [];
  for (const block of raw.replace(/\r/g, "").split(/\n{2,}/)) {
    const rows = block.split("\n");
    const at = rows.findIndex((r) => r.includes("-->"));
    if (at < 0) continue;
    const [a, b] = rows[at].split("-->");
    const text = plain(rows.slice(at + 1).join(" "));
    const start = cueTime(a);
    const end = cueTime(b);
    if (!text || !Number.isFinite(start)) continue;
    const last = lines.at(-1);
    if (last && last[2] === text) {
      last[1] = r2(end);
      continue;
    }
    lines.push([r2(start), r2(Number.isFinite(end) ? end : start + 2), text]);
  }
  return lines;
}

/** Downloads the link's captions and keeps them as a transcript. Returns null, with why, when there are none. */
export async function fetchTranscript(info: SourceInfo, signal: AbortSignal): Promise<{ transcript: Transcript | null; why?: string }> {
  if (!info.captions) return { transcript: null, why: "the site has no captions for it" };
  const yt = await tool();
  const tmp = await fs.mkdtemp(path.join(/*turbopackIgnore: true*/ os.tmpdir(), "crackio-captions-"));
  try {
    const { lang, auto } = info.captions;
    const r = await runYtdlp(
      yt.cmd,
      [...baseArgs(yt), "--skip-download", auto ? "--write-auto-subs" : "--write-subs", "--sub-langs", lang, "--sub-format", "json3/vtt/srt/best", "-o", path.join(/*turbopackIgnore: true*/ tmp, "subs.%(ext)s"), "--", info.url],
      { timeoutMs: 90_000, signal },
    );
    const got = (await fs.readdir(tmp)).find((f) => f.startsWith("subs.") && /\.(json3|vtt|srt)$/.test(f));
    if (!got) return { transcript: null, why: r.code === 0 ? "its captions came in a format Crackio can't read" : friendly(lastError(r), info.url) };
    const raw = await fs.readFile(path.join(/*turbopackIgnore: true*/ tmp, got), "utf8");
    const parsed = got.endsWith(".json3") ? fromJson3(raw) : { lines: fromCues(raw), words: undefined };
    if (!parsed.lines.length) return { transcript: null, why: "its captions are empty" };
    return {
      transcript: {
        title: info.title,
        source: info.url,
        duration: info.duration,
        language: lang.replace(/-orig$/, ""),
        captions: auto ? "auto" : "creator",
        lines: parsed.lines,
        words: parsed.words?.length ? parsed.words : undefined,
      },
    };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

/* ---------------------------------------------------------------- media */

/**
 * Downloads the media into a hidden folder inside the project folder (so half-written files never
 * show up as project files), then moves it in under `stem`. Returns the file's name.
 */
export async function fetchMedia(o: {
  url: string;
  dir: string;
  stem: string;
  get: "video" | "audio";
  height: number;
  section?: { start: number; end: number };
  signal: AbortSignal;
  onProgress: (text: string) => void;
}): Promise<string> {
  const yt = await tool();
  const work = path.join(/*turbopackIgnore: true*/ o.dir, `.download-${nanoid(6)}`);
  await fs.mkdir(work, { recursive: true });
  const what = o.get === "audio" ? "the sound" : "the video";
  const started = Date.now();
  let lastPercent = "";
  const tick = setInterval(() => !lastPercent && o.onProgress(`Downloading ${what} · ${Math.round((Date.now() - started) / 1000)} s`), 2000);
  try {
    const args = [
      ...baseArgs(yt),
      "--newline",
      "--progress-template", "download:@@%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s",
      "-N", "4",
      ...(o.get === "audio"
        ? ["-f", "ba/b", "-x", "--audio-format", "m4a"]
        : ["-f", `bv*[height<=?${o.height}]+ba/b[height<=?${o.height}]/bv*+ba/b`, "-S", `res:${o.height},vcodec:h264,acodec:aac,ext:mp4:m4a`, "--merge-output-format", "mp4"]),
      ...(o.section ? ["--download-sections", `*${o.section.start.toFixed(2)}-${o.section.end.toFixed(2)}`, "--force-keyframes-at-cuts"] : []),
      "-o", path.join(/*turbopackIgnore: true*/ work, "media.%(ext)s"),
      "--",
      o.url,
    ];
    const r = await runYtdlp(yt.cmd, args, {
      timeoutMs: 45 * 60_000,
      signal: o.signal,
      onLine: (line) => {
        if (line.startsWith("@@")) {
          const [percent, speed, eta] = line.slice(2).split("|").map((s) => s.trim());
          lastPercent = percent;
          o.onProgress(`Downloading ${what} · ${percent}${speed && !/unknown/i.test(speed) ? ` · ${speed}` : ""}${eta && /^\d/.test(eta) ? ` · ${eta} left` : ""}`);
        } else if (/^\[Merger\]/.test(line)) o.onProgress("Joining picture and sound");
        else if (/^\[ExtractAudio\]/.test(line)) o.onProgress("Extracting the sound");
        else if (/Destination: .*\.f\d+\.(m4a|webm|mp3|opus)$/.test(line)) lastPercent = "";
      },
    });
    if (o.signal.aborted) throw new ToolError("Cancelled.");
    const got = (await fs.readdir(work)).find((f) => f.startsWith("media.") && !/\.(part|ytdl|temp|json|vtt|srt|json3)$/i.test(f) && !/\.f\d+\./.test(f));
    if (r.code !== 0 || !got) throw new ToolError(`The download failed: ${friendly(lastError(r), o.url)}`);
    const ext = path.extname(got).slice(1).toLowerCase();
    const name = await uniqueName(o.dir, `${o.stem}.${ext}`);
    await fs.rename(path.join(/*turbopackIgnore: true*/ work, got), path.join(/*turbopackIgnore: true*/ o.dir, name));
    return name;
  } finally {
    clearInterval(tick);
    await fs.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

/* ---------------------------------------------------------------- reading a transcript */

export async function readTranscript(file: string): Promise<Transcript> {
  const t = JSON.parse(await fs.readFile(file, "utf8").catch(() => "null")) as Transcript | null;
  if (!t || !Array.isArray(t.lines)) throw new ToolError(`${path.basename(file)} isn't a transcript. Transcripts come from download, saved as NAME.transcript.json.`);
  return t;
}

const s2 = (t: number) => t.toFixed(2);
const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, "").replace(/^'+|'+$/g, "");

function header(t: Transcript) {
  return `${t.title}${t.duration ? `, ${span(t.duration)} long` : ""}: ${t.captions === "auto" ? "machine captions" : "the creator's captions"}, ${t.words ? "timed to the word" : "timed by line (no word times)"}. Times are seconds of the source.`;
}

/** What's said between `from` and `to`, with every word's start in short windows. */
export function transcriptWindow(t: Transcript, from: number, to: number) {
  const lines = t.lines.filter((l) => l[0] >= from && l[0] < to);
  const detailed = Boolean(t.words) && to - from <= 120;
  const out = [header(t), ""];
  for (const l of lines) {
    out.push(`${s2(l[0])} (${clock(l[0])})  ${l[2]}`);
    if (detailed) {
      const words = t.words!.filter((w) => w[0] >= l[0] && w[0] < l[1] && w[0] >= from && w[0] < to);
      if (words.length) out.push(`    ${words.map((w) => `${w[2]} ${s2(w[0])}`).join(" · ")}`);
    }
  }
  if (!lines.length) out.push(`Nothing is said between ${s2(from)} and ${s2(to)} s.`);
  const later = t.lines.find((l) => l[0] >= to);
  if (later) out.push("", `More from ${s2(to)} s${detailed ? "" : " (ask for 2 minutes or less to get every word's time)"}.`);
  return out.join("\n");
}

/** Every place each word or phrase is said, with the times of exactly those words. */
export function findInTranscript(t: Transcript, terms: string[]) {
  const out = [header(t)];
  const words = (t.words ?? []).map((w) => ({ w, n: norm(w[2]) })).filter((x) => x.n);
  for (const term of terms) {
    const want = term.split(/\s+/).map(norm).filter(Boolean);
    if (!want.length) continue;
    const hits: string[] = [];
    let count = 0;
    if (words.length) {
      for (let i = 0; i + want.length <= words.length; i++) {
        if (!want.every((x, k) => words[i + k].n === x)) continue;
        count++;
        if (hits.length >= 30) continue;
        const a = words[i].w;
        const b = words[i + want.length - 1].w;
        const before = words.slice(Math.max(0, i - 5), i).map((x) => x.w[2]).join(" ");
        const after = words.slice(i + want.length, i + want.length + 5).map((x) => x.w[2]).join(" ");
        const said = words.slice(i, i + want.length).map((x) => x.w[2]).join(" ");
        hits.push(`  ${s2(a[0])}-${s2(b[1])} (${clock(a[0])})  …${before} [${said}] ${after}…`);
      }
    } else {
      const needle = want.join(" ");
      for (const l of t.lines) {
        if (!l[2].split(/\s+/).map(norm).filter(Boolean).join(" ").includes(needle)) continue;
        count++;
        if (hits.length < 30) hits.push(`  ${s2(l[0])}-${s2(l[1])} (${clock(l[0])})  ${l[2]}`);
      }
    }
    out.push("", `"${term}": ${count ? `${count} time${count === 1 ? "" : "s"}${count > hits.length ? ` (the first ${hits.length})` : ""}` : "not said"}${count && !words.length ? ", times are whole lines" : ""}`, ...hits);
  }
  return out.join("\n");
}
