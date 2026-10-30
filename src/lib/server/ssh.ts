import "server-only";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DATA_DIR } from "./paths";
import { demoOn } from "@/lib/demo/config";

/**
 * SSH from this computer to a rented GPU box, through the system's own OpenSSH client (Windows 10+, macOS and Linux all
 * ship one). Crackio uses it to set a box up: read its address and token, copy the Crackio bridge into its ComfyUI and
 * restart it. Jobs go over HTTP; a tunnel through SSH is the way in only when a box shows no web address.
 */

export type SshLogin = { host: string; port: number; user: string };

const SSH_DIR = path.join(/*turbopackIgnore: true*/ DATA_DIR, "ssh");
const OWN_KEY = path.join(SSH_DIR, "crackio_ed25519");
const KNOWN_HOSTS = path.join(SSH_DIR, "known_hosts");
/** The usual key files, which a cloud account often has already. */
const USUAL_KEYS = ["id_ed25519", "id_ecdsa", "id_rsa"].map((k) => path.join(os.homedir(), ".ssh", k));

const exists = (file: string) => fs.access(file).then(() => true, () => false);
const bin = (name: "ssh" | "ssh-keygen") => (process.platform === "win32" ? `${name}.exe` : name);

export class SshError extends Error {}

/**
 * Whether an SSH server answers at a login's address: its "SSH-" banner within the time. A box still starting refuses
 * or times out; a cloud's proxy port for it can take the connection and close it without a word.
 */
export function sshAnswers(login: Pick<SshLogin, "host" | "port">, timeoutMs = 6000): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: login.host, port: login.port });
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(timeoutMs, () => done(false));
    s.once("data", (d) => done(d.toString("latin1").startsWith("SSH-")));
    s.once("error", () => done(false));
    s.once("close", () => done(false));
  });
}

/** The keys ssh offers a box: the usual ones in ~/.ssh, then Crackio's own. */
async function keyFiles() {
  const found: string[] = [];
  for (const k of [...USUAL_KEYS, OWN_KEY]) if ((await exists(k)) && (await exists(`${k}.pub`))) found.push(k);
  return found;
}

/**
 * The public key to put on a cloud account (vast.ai and RunPod give every new box the account's keys): the first of the
 * usual keys there is, else Crackio's own, made once.
 */
export async function publicKey(): Promise<{ key: string; file: string; own: boolean }> {
  const have = await keyFiles();
  const file = have[0] ?? (await makeOwnKey());
  const line = (await fs.readFile(`${file}.pub`, "utf8")).trim();
  // A live demo gives its key without the comment (it names the server: user@host).
  return { key: demoOn() ? line.split(/\s+/).slice(0, 2).join(" ") : line, file: `${file}.pub`, own: file === OWN_KEY };
}

async function makeOwnKey() {
  await fs.mkdir(SSH_DIR, { recursive: true });
  await new Promise<void>((resolve, reject) =>
    execFile(bin("ssh-keygen"), ["-q", "-t", "ed25519", "-N", "", "-C", `crackio@${os.hostname()}`, "-f", OWN_KEY], { timeout: 30_000 }, (err) =>
      err ? reject(new SshError(`Couldn't make an SSH key (${err.message}). Install OpenSSH, or make one with ssh-keygen.`)) : resolve(),
    ),
  );
  return OWN_KEY;
}

/** ssh's options as one line each: a path in quotes, so a user name with a space in it still works. */
const quoted = (file: string) => `"${file.replace(/\\/g, "/")}"`;

async function baseArgs(login: SshLogin) {
  const keys = await keyFiles();
  await fs.mkdir(SSH_DIR, { recursive: true });
  return [
    "-p", String(login.port),
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", `UserKnownHostsFile=${quoted(KNOWN_HOSTS)}`,
    "-o", "ConnectTimeout=20",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=4",
    "-o", "LogLevel=ERROR",
    ...(keys.length ? ["-o", "IdentitiesOnly=yes", ...keys.flatMap((k) => ["-i", k])] : []),
  ];
}

/** A rented box's address goes to the next renter with a new host key: forget the old one (they asked for this box). */
async function forgetHost(login: SshLogin) {
  const name = login.port === 22 ? login.host : `[${login.host}]:${login.port}`;
  await new Promise<void>((resolve) => execFile(bin("ssh-keygen"), ["-R", name, "-f", KNOWN_HOSTS], { timeout: 15_000 }, () => resolve()));
}

export type SshResult = { code: number; stdout: string; stderr: string };

/** Run a bash script on the box (sent on stdin, so nothing in it needs quoting for the shell). */
export async function sshRun(login: SshLogin, script: string, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<SshResult> {
  const once = async (): Promise<SshResult> => {
    const args = [...(await baseArgs(login)), `${login.user}@${login.host}`, "bash -s"];
    return new Promise((resolve, reject) => {
      const child = spawn(bin("ssh"), args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => child.kill(), opts.timeoutMs ?? 120_000);
      const abort = () => child.kill();
      opts.signal?.addEventListener("abort", abort, { once: true });
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(new SshError(/ENOENT/.test(err.message) ? "This computer has no ssh client. Install OpenSSH (Windows: Settings → Optional features → OpenSSH Client)." : err.message));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", abort);
        resolve({ code: code ?? -1, stdout, stderr });
      });
      child.stdin.end(script.replace(/\r\n/g, "\n"));
    });
  };
  let res = await once();
  if (/HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(res.stderr)) {
    await forgetHost(login);
    res = await once();
  }
  if (res.code === 255) throw new SshError(sshProblem(res.stderr, login));
  return res;
}

/** What went wrong reaching the box, in words. */
function sshProblem(stderr: string, login: SshLogin) {
  const where = `${login.user}@${login.host} port ${login.port}`;
  if (/Permission denied|publickey/i.test(stderr)) return `The box at ${where} didn't take Crackio's SSH key. Add the key shown under Connections → GPUs to your cloud account, then rent again (or add it to this box).`;
  if (/timed out|Connection refused|No route|Could not resolve/i.test(stderr)) return `Couldn't reach ${where}: ${stderr.trim().split("\n").pop()}`;
  return `SSH to ${where} failed: ${stderr.trim().split("\n").slice(-2).join(" ").slice(0, 300) || "no answer"}`;
}

/** The JSON a script printed after a marker line (login banners and warnings can come before it). */
export function markedJson<T>(stdout: string, marker = "CRACKIO_JSON"): T | null {
  const line = stdout.split("\n").reverse().find((l) => l.startsWith(`${marker} `));
  if (!line) return null;
  try {
    return JSON.parse(line.slice(marker.length + 1)) as T;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ tunnels */

type Tunnel = { child: ChildProcess; localPort: number; ready: Promise<number> };
const g = globalThis as unknown as { __crackioSshTunnels?: Map<string, Tunnel> };
const tunnels = (g.__crackioSshTunnels ??= new Map());

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });

const answers = (port: number) =>
  new Promise<boolean>((resolve) => {
    const sock = net.connect(port, "127.0.0.1");
    sock.once("connect", () => (sock.destroy(), resolve(true)));
    sock.once("error", () => resolve(false));
  });

/**
 * A port on this computer that leads to `remotePort` on the box, kept open while Crackio runs and opened again when it
 * drops. Returns the local port.
 */
export async function sshTunnel(login: SshLogin, remotePort: number): Promise<number> {
  const key = `${login.user}@${login.host}:${login.port}>${remotePort}`;
  const open = tunnels.get(key);
  if (open && open.child.exitCode === null) return open.ready;
  const localPort = open?.localPort && !(await answers(open.localPort)) ? open.localPort : await freePort();
  const args = [...(await baseArgs(login)), "-N", "-C", "-o", "ExitOnForwardFailure=yes", "-L", `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`, `${login.user}@${login.host}`];
  const child = spawn(bin("ssh"), args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  let stderr = "";
  child.stderr?.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
  const ready = (async () => {
    for (let i = 0; i < 60; i++) {
      if (child.exitCode !== null) throw new SshError(sshProblem(stderr, login));
      if (await answers(localPort)) return localPort;
      await new Promise((r) => setTimeout(r, 500));
    }
    child.kill();
    throw new SshError(`The tunnel to ${login.host} didn't open.`);
  })();
  tunnels.set(key, { child, localPort, ready });
  ready.catch(() => tunnels.delete(key));
  return ready;
}

export function closeTunnels(login: SshLogin) {
  for (const [key, t] of tunnels) {
    if (key.startsWith(`${login.user}@${login.host}:${login.port}>`)) {
      t.child.kill();
      tunnels.delete(key);
    }
  }
}
