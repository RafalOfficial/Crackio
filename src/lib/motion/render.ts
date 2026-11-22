import "server-only";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { nanoid } from "nanoid";
import { EngineError } from "@/lib/engines/types";
import { ffmpegPath } from "./ffmpeg";
import { withRuntime, type Stage } from "./runtime";

/**
 * Renders a composition on this computer: headless Chrome scrubs the timeline frame by frame,
 * and ffmpeg encodes the frames, to H.264 MP4, or to VP9 WebM with an alpha channel when the
 * piece is meant to be laid over footage.
 */
const ALLOWED_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com"];

export async function launch() {
  const { chromium } = await import("playwright-core");
  // WebGL must work for three.js pieces: on the GPU when there is one, else in software.
  const args = ["--hide-scrollbars", "--mute-audio", "--force-device-scale-factor=1", "--disable-gpu-vsync", "--autoplay-policy=no-user-gesture-required", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"];
  try {
    return await chromium.launch({ channel: "chrome", headless: true, args });
  } catch {
    try {
      return await chromium.launch({ channel: "msedge", headless: true, args });
    } catch {
      try {
        return await chromium.launch({ headless: true, args });
      } catch {
        throw new EngineError("Motion needs Google Chrome (or Edge) on this computer to render.", "Install Chrome, then try again.");
      }
    }
  }
}

/** A step inside the page that never finishes (an endless loop in the piece's code) fails instead of hanging the turn. */
export async function within<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new EngineError(message)), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * ffmpeg's input, written frame by frame. When ffmpeg stops early (an encoder error, a full disk, Cancel killing it), a
 * write says so instead of waiting forever for a pipe that will never drain.
 */
export function framePipe(proc: ChildProcess) {
  let exit: number | null = null;
  const finished = new Promise<number>((resolve) => {
    proc.once("error", () => resolve(-1));
    proc.once("close", (code) => resolve(code ?? 1));
  });
  void finished.then((code) => (exit = code));
  // EPIPE/EOF once ffmpeg is gone: its exit code says why.
  proc.stdin!.on("error", () => {});
  return {
    finished,
    get exit() {
      return exit;
    },
    /** False once ffmpeg has stopped taking frames. */
    async write(frame: Buffer) {
      if (exit !== null) return false;
      if (!proc.stdin!.write(frame)) await Promise.race([once(proc.stdin!, "drain").catch(() => {}), finished]);
      return exit === null;
    },
    end() {
      if (exit === null) proc.stdin!.end();
    },
  };
}

export async function renderComposition({
  html,
  stage,
  origin,
  base,
  transparent = false,
  signal,
  onProgress,
}: {
  html: string;
  stage: Stage;
  /** Where Crackio itself is reachable from this computer, for /api/media files. */
  origin: string;
  /** Where relative file names in the document resolve (defaults to Crackio's root). */
  base?: string;
  /** Keep the background see-through (VP9 WebM with alpha). */
  transparent?: boolean;
  signal: AbortSignal;
  onProgress: (done: number, total: number) => void;
}): Promise<{ data: Buffer; errors: string[] }> {
  const browser = await launch();
  const out = path.join(os.tmpdir(), `crackio-motion-${nanoid(8)}.${transparent ? "webm" : "mp4"}`);
  let ffmpeg: ReturnType<typeof spawn> | null = null;
  const stop = () => {
    ffmpeg?.kill("SIGKILL");
    void browser.close().catch(() => {});
  };
  signal.addEventListener("abort", stop, { once: true });
  // What went wrong inside the page (a script error, a library that didn't load), for the agent to fix.
  const errors: string[] = [];
  const note = (text: string) => errors.length < 8 && !errors.includes(text) && errors.push(text.slice(0, 300));
  const withErrors = (message: string) => (errors.length ? `${message} The page reported: ${errors.join(" | ")}` : message);
  try {
    const page = await browser.newPage({ viewport: { width: stage.width, height: stage.height }, deviceScaleFactor: 1 });
    page.on("pageerror", (e) => note(e.message));
    page.on("console", (m) => m.type() === "error" && note(m.text()));
    // Compositions only reach Crackio's own media and libraries (GSAP, three.js), data/blob URLs and Google Fonts.
    await page.route("**/*", (route) => {
      const url = route.request().url();
      if (url.startsWith("data:") || url.startsWith("blob:") || url.startsWith(`${origin}/api/media/`) || url.startsWith(`${origin}/api/motion/lib/`)) return route.continue();
      try {
        if (ALLOWED_HOSTS.includes(new URL(url).hostname)) return route.continue();
      } catch {
        /* fall through */
      }
      return route.abort();
    });
    await page.setContent(withRuntime(html, stage, base ?? `${origin}/`), { waitUntil: "load", timeout: 60_000 });
    const runtime = await page.evaluate(() => typeof (window as unknown as { __crackio?: { ready?: unknown } }).__crackio?.ready === "function");
    if (!runtime) throw new EngineError(withErrors("The page lost Crackio's timing runtime (window.__crackio is Crackio's; read window.__crackio.duration, never assign to it)."));
    await within(
      page.evaluate(() => (window as unknown as { __crackio: { ready: () => Promise<void> } }).__crackio.ready()),
      5 * 60_000,
      withErrors("The page took over 5 minutes to get ready: a font, picture or clip that never loads, or a promise that never settles?"),
    );

    const total = Math.max(1, Math.round(stage.duration * stage.fps));
    const encode = transparent
      ? ["-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", "24", "-row-mt", "1", "-deadline", "realtime", "-cpu-used", "8", "-auto-alt-ref", "0"]
      : ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "medium", "-crf", "18", "-movflags", "+faststart"];
    const proc = spawn(
      // Ignored by the bundler, as in runFfmpeg: otherwise production builds trace the whole project.
      /*turbopackIgnore: true*/ ffmpegPath(),
      ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(stage.fps), "-c:v", "png", "-i", "-", ...encode, "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", out],
      { windowsHide: true },
    );
    ffmpeg = proc;
    let stderr = "";
    proc.stderr?.on("data", (c: Buffer) => {
      if (stderr.length < 8000) stderr += c.toString();
    });
    const pipe = framePipe(proc);

    // Chrome's fast capture path: PNG encoded for speed is about 3× quicker than a regular screenshot
    // (and keeps alpha when the default background is see-through).
    const cdp = await page.context().newCDPSession(page);
    if (transparent) await cdp.send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
    for (let i = 0; i < total; i++) {
      if (signal.aborted) throw new EngineError("Cancelled.");
      await within(
        page.evaluate((t) => (window as unknown as { __crackio: { seek: (t: number) => Promise<void> } }).__crackio.seek(t), i / stage.fps),
        2 * 60_000,
        withErrors(`Frame ${i + 1} took over 2 minutes to draw: an endless loop in window.onFrame, or a seek that never settles?`),
      );
      const shot = await cdp.send("Page.captureScreenshot", { format: "png", optimizeForSpeed: true });
      if (!(await pipe.write(Buffer.from(shot.data, "base64")))) break;
      if (i % 3 === 0 || i === total - 1) onProgress(i + 1, total);
    }
    pipe.end();
    const code = await pipe.finished;
    if (signal.aborted) throw new EngineError("Cancelled.");
    if (code !== 0) throw new EngineError(withErrors(`The video encoder failed: ${stderr.trim().slice(0, 300) || `exit ${code}`}`));
    return { data: await fs.readFile(/*turbopackIgnore: true*/ out), errors };
  } catch (err) {
    // Cancel closes the browser under the loop: say so, not "Target page closed".
    if (signal.aborted) throw new EngineError("Cancelled.");
    if (err instanceof EngineError) throw err;
    throw new EngineError(withErrors(err instanceof Error ? err.message : String(err)));
  } finally {
    signal.removeEventListener("abort", stop);
    await browser.close().catch(() => {});
    await fs.rm(/*turbopackIgnore: true*/ out, { force: true }).catch(() => {});
  }
}
