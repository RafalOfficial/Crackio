import "server-only";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { killTree } from "@/lib/engines/cli";
import { ffmpegPath } from "@/lib/motion/ffmpeg";

/**
 * yt-dlp on this computer, for Templates (the real viral clips) and Motion (footage, songs and
 * podcasts you link). Crackio doesn't ship it: it's found where you installed it, and looked up
 * again after a minute, so installing or updating it takes effect without a restart.
 */

/** YouTube changes often; yt-dlp releases from before this can't read it any more. */
const YOUTUBE_SINCE = "2025.11.12";

export type Ytdlp = { cmd: string; pre: string[]; version: string };
export type YtdlpRun = { code: number; out: string; err: string };

type State = { tool: Promise<Ytdlp | null> | null; at: number };
const g = globalThis as unknown as { __crackioYtdlp?: State };
const state: State = (g.__crackioYtdlp ??= { tool: null, at: 0 });

/**
 * Runs yt-dlp (or anything else) without a shell and collects what it prints. `onLine` gets each
 * line of output as it comes; abort or the timeout stops it and everything it started.
 */
export function runYtdlp(
  cmd: string,
  args: string[],
  { timeoutMs, signal, onLine }: { timeoutMs: number; signal?: AbortSignal; onLine?: (line: string) => void },
): Promise<YtdlpRun> {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let partial = "";
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(cmd, args, { windowsHide: true });
    } catch (e) {
      resolve({ code: -1, out, err: String(e) });
      return;
    }
    const stop = () => killTree(proc);
    const timer = setTimeout(stop, timeoutMs);
    signal?.addEventListener("abort", stop, { once: true });
    proc.stdout?.on("data", (d: Buffer) => {
      const text = d.toString();
      out += text;
      if (!onLine) return;
      const lines = (partial + text).split(/\r?\n|\r/);
      partial = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) onLine(line);
    });
    proc.stderr?.on("data", (d: Buffer) => (err = (err + d.toString()).slice(-4000)));
    const done = (code: number) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      resolve({ code, out, err });
    };
    proc.on("error", (e) => {
      err += String(e);
      done(-1);
    });
    proc.on("close", (code) => done(code ?? -1));
  });
}

/**
 * yt-dlp run from Python with Windows' WMI version query switched off: yt-dlp asks for the Windows
 * version as it starts, and when the WMI service hangs (it does, after a memory crunch) so would
 * every download. Python then reads the version another way.
 */
const NO_WMI = "import platform, sys\ndef _skip(*a, **k):\n    raise OSError('skipped')\nplatform._wmi_query = _skip\nfrom yt_dlp import main\nmain()";

/** yt-dlp on this computer: CRACKIO_YTDLP, Python's module (WMI-safe, above), or the yt-dlp command. */
export function ytdlp(): Promise<Ytdlp | null> {
  if (!(Date.now() - state.at < 60_000)) {
    state.tool = null;
    state.at = Date.now();
  }
  state.tool ??= (async () => {
    const owner = await ownerPython();
    const tries: [string, string[]][] = [
      ...(process.env.CRACKIO_YTDLP ? [[process.env.CRACKIO_YTDLP, []] as [string, string[]]] : []),
      ...(owner ? [[owner, ["-c", NO_WMI]] as [string, string[]]] : []),
      ["python", ["-c", NO_WMI]],
      ["python3", ["-c", NO_WMI]],
      ["py", ["-c", NO_WMI]],
      ["yt-dlp", []],
    ];
    for (const [cmd, pre] of tries) {
      const r = await runYtdlp(cmd, [...pre, "--version"], { timeoutMs: 20_000 });
      const version = r.out.trim().split(/\s+/)[0] ?? "";
      if (r.code === 0 && /^\d{4}\.\d{2}\.\d{2}/.test(version)) return { cmd, pre, version };
    }
    return null;
  })();
  return state.tool;
}

/** The Python a pip-installed yt-dlp command belongs to (…\Python312\Scripts\yt-dlp.exe → …\Python312\python.exe). */
async function ownerPython(): Promise<string | null> {
  const exe = process.platform === "win32" ? ["yt-dlp.exe"] : ["yt-dlp"];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const name of exe) {
      if (!(await fs.stat(path.join(/*turbopackIgnore: true*/ dir, name)).catch(() => null))) continue;
      const python = path.join(/*turbopackIgnore: true*/ dir, "..", process.platform === "win32" ? "python.exe" : "python3");
      const sibling = path.join(/*turbopackIgnore: true*/ dir, process.platform === "win32" ? "python.exe" : "python3");
      for (const p of [python, sibling]) if (await fs.stat(p).catch(() => null)) return p;
    }
  }
  return null;
}

export const youtubeReady = (t: Ytdlp | null) => Boolean(t && t.version >= YOUTUBE_SINCE);

/** What every run needs: Crackio's ffmpeg for merging and cutting, and a JavaScript runtime for YouTube. */
export const baseArgs = (t: Ytdlp) => [
  ...t.pre,
  "--no-warnings",
  "--no-playlist",
  "--socket-timeout", "20",
  "--retries", "3",
  "--ffmpeg-location", ffmpegPath(),
  ...(youtubeReady(t) ? ["--js-runtimes", `node:${process.execPath}`] : []),
];

/** yt-dlp's last error line from a run. */
export const lastError = (r: YtdlpRun) => r.err.split("\n").filter((l) => /ERROR/.test(l)).pop() ?? r.err.trim().split("\n").pop() ?? "";

/** yt-dlp's last error, in words people can act on. */
export function friendly(err: string, url: string) {
  if (/ffmpeg|ffprobe/i.test(err)) return "yt-dlp couldn't use ffmpeg to join or cut the download.";
  if (/login required|rate-limit|cookies/i.test(err)) return "That post needs a sign-in to download.";
  if (/Requested format is not available|Sign in to confirm/i.test(err) && /youtu/.test(url)) return "YouTube refused this yt-dlp. Update it: pip install -U yt-dlp.";
  if (/unavailable|removed|not found|404|private/i.test(err)) return "The post is gone or private.";
  if (/timed out|timeout|ECONN|getaddrinfo/i.test(err)) return "The site didn't answer. Check your connection and try again.";
  return err.replace(/^ERROR:\s*/, "").slice(0, 200) || "yt-dlp couldn't download it.";
}
