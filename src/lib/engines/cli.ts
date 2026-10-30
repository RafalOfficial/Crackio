import "server-only";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { nanoid } from "nanoid";

/** Quote one argument for a Windows/POSIX shell command line. */
export const shellQuote = (s: string) => `"${s.replace(/(["\\$`])/g, "\\$1")}"`;

/**
 * Stop a CLI and everything it started. CLIs are launched through a shell (npm shims on
 * Windows need one), so killing only the shell would leave the real process running.
 */
export function killTree(child: ChildProcess) {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === "win32") {
    execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], () => {});
  } else {
    try {
      process.kill(-child.pid, "SIGTERM"); // the whole process group (spawned detached)
    } catch {
      child.kill("SIGTERM");
    }
  }
}

/** Spawn an installed CLI through the shell, in its own process group on POSIX. */
export function spawnCli(bin: string, args: string[], cwd = os.tmpdir(), env?: Record<string, string>) {
  return spawn(bin, args, {
    shell: true,
    windowsHide: true,
    cwd,
    detached: process.platform !== "win32",
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", ...env },
  });
}

/**
 * Run an installed CLI (codex, grok) and collect its output. Long text goes through stdin
 * or a temp file so nothing is lost to shell parsing.
 */
export function runCli(
  bin: string,
  args: string[],
  { stdin, signal, timeoutMs = 120_000, cwd }: { stdin?: string; signal?: AbortSignal; timeoutMs?: number; cwd?: string } = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawnCli(bin, args, cwd);
    let stdout = "";
    let stderr = "";
    const stop = () => killTree(child);
    const timer = setTimeout(stop, timeoutMs);
    signal?.addEventListener("abort", stop, { once: true });
    child.stdout?.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr?.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      resolve({ code, stdout, stderr });
    });
    if (stdin !== undefined) child.stdin?.end(stdin);
    else child.stdin?.end();
  });
}

export async function withTempFile<T>(content: string, fn: (file: string) => Promise<T>) {
  const file = path.join(os.tmpdir(), `crackio-${nanoid(8)}.txt`);
  await fs.writeFile(file, content, "utf8");
  try {
    return await fn(file);
  } finally {
    await fs.rm(file, { force: true });
  }
}

/** Strip terminal color codes from CLI output. */
export const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
