import "server-only";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCli, shellQuote, stripAnsi } from "@/lib/engines/cli";

/**
 * One-click connect: the agent CLIs found on the computer Crackio's server runs on (never on a rented box or another
 * machine), and adding or removing Crackio's MCP program in each. A CLI's own "add MCP server" command is used where it
 * has one; Cursor and OpenCode's removal are edits of their config file, parsed and merged, with a backup, touching
 * nothing but the `crackio` entry. Every change is shown as text before it's made (`change`).
 */
export type CliId = "claude" | "codex" | "cursor" | "grok" | "opencode" | "gemini" | "antigravity";

export type AgentCli = {
  id: CliId;
  name: string;
  found: boolean;
  /** Crackio's entry is in its config. */
  connected: boolean;
  /** Exactly what Connect and Remove do, in words or as the command run. */
  change: { connect: string; remove: string };
  /** Where its MCP servers are kept, for the person who wants to look. */
  config: string;
};

const NAME = "crackio";
const home = os.homedir();
const tilde = (p: string) => (p.startsWith(home) ? `~${p.slice(home.length).replace(/\\/g, "/")}` : p);

/** Crackio's MCP program, as an agent CLI starts it. Forward slashes: they work on Windows and survive every config format. */
export const programPath = () => path.join(/*turbopackIgnore: true*/ process.cwd(), "scripts", "mcp", "crackio-mcp.mjs").replace(/\\/g, "/");

/** Whether a command is on this computer's PATH (with Windows' extensions), and where. */
async function onPath(bin: string): Promise<string | null> {
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").map((e) => e.toLowerCase()) : [""];
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  // Where CLIs install themselves without touching PATH until the next login.
  const extra = process.platform === "win32" ? [path.join(home, ".local", "bin"), path.join(home, "AppData", "Roaming", "npm"), path.join(home, ".grok", "bin"), path.join(home, "AppData", "Local", "cursor-agent")] : [path.join(home, ".local", "bin"), "/usr/local/bin", "/opt/homebrew/bin", path.join(home, ".grok", "bin"), path.join(home, ".bun", "bin"), path.join(home, ".opencode", "bin")];
  for (const dir of [...dirs, ...extra]) {
    for (const ext of exts) {
      const file = path.join(/*turbopackIgnore: true*/ dir, `${bin}${ext}`);
      if (await fs.stat(/*turbopackIgnore: true*/ file).then((s) => s.isFile()).catch(() => false)) return file;
    }
  }
  return null;
}

const readText = (file: string) => fs.readFile(/*turbopackIgnore: true*/ file, "utf8").catch(() => null);

/** JSON with comments and trailing commas (OpenCode's .jsonc), as plain JSON text; strings are left alone. */
function plainJson(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
      out += text.slice(start, i + 1);
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2);
      if (i < 0) break;
      i++;
    } else out += c;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

const parseJson = (text: string | null): Record<string, unknown> | null => {
  if (text === null) return null;
  try {
    const v = JSON.parse(plainJson(text)) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

async function backup(file: string) {
  const text = await readText(file);
  if (text !== null) await fs.writeFile(/*turbopackIgnore: true*/ `${file}.before-crackio`, text);
}

/** The indent a JSON file uses (two spaces when it can't be told). */
const indentOf = (text: string) => /\n([ \t]+)"/.exec(text)?.[1] ?? "  ";

type Def = {
  id: CliId;
  name: string;
  bins: string[];
  /** A folder that also counts as "it's here" (an editor with no CLI on PATH). */
  folder?: string;
  config: string;
  connected: () => Promise<boolean>;
  /** The CLI's own commands, as arguments after its name; null: a file edit instead. */
  add: ((program: string) => string[]) | null;
  remove: string[] | null;
  editAdd?: (program: string) => Promise<void>;
  editRemove?: () => Promise<void>;
  words?: { connect: string; remove: string };
};

const cursorFile = path.join(home, ".cursor", "mcp.json");
const openCodeFiles = [path.join(home, ".config", "opencode", "opencode.jsonc"), path.join(home, ".config", "opencode", "opencode.json")];
const openCodeFile = async () => {
  for (const f of openCodeFiles) if ((await readText(f)) !== null) return f;
  return openCodeFiles[1];
};

const hasToml = (file: string) => async () => new RegExp(`^\\s*\\[mcp_?servers?\\.["']?${NAME}["']?\\]`, "m").test((await readText(file)) ?? "");
const hasJsonKey = (file: string, ...keys: string[]) => async () => {
  let node: unknown = parseJson(await readText(file));
  for (const k of [...keys, NAME]) node = node && typeof node === "object" ? (node as Record<string, unknown>)[k] : undefined;
  return node !== undefined;
};

const DEFS: Def[] = [
  {
    id: "claude",
    name: "Claude Code",
    bins: ["claude"],
    config: path.join(home, ".claude.json"),
    connected: hasJsonKey(path.join(home, ".claude.json"), "mcpServers"),
    add: (p) => ["mcp", "add", "-s", "user", NAME, "--", "node", p],
    remove: ["mcp", "remove", NAME, "-s", "user"],
  },
  {
    id: "codex",
    name: "Codex CLI",
    bins: ["codex"],
    config: path.join(home, ".codex", "config.toml"),
    connected: hasToml(path.join(home, ".codex", "config.toml")),
    add: (p) => ["mcp", "add", NAME, "--", "node", p],
    remove: ["mcp", "remove", NAME],
  },
  {
    id: "cursor",
    name: "Cursor",
    bins: ["cursor-agent", "cursor"],
    folder: path.join(home, ".cursor"),
    config: cursorFile,
    connected: hasJsonKey(cursorFile, "mcpServers"),
    add: null,
    remove: null,
    words: { connect: `Adds a "${NAME}" entry to ${tilde(cursorFile)} (the editor and its CLI both read it). A copy of the file is kept beside it first.`, remove: `Takes the "${NAME}" entry out of ${tilde(cursorFile)}. Nothing else in it changes.` },
    async editAdd(program) {
      const text = await readText(cursorFile);
      const json = text === null ? {} : parseJson(text);
      if (!json) throw new Error(`${tilde(cursorFile)} isn't valid JSON, so Crackio left it alone.`);
      await backup(cursorFile);
      const servers = { ...((json.mcpServers as Record<string, unknown> | undefined) ?? {}), [NAME]: { command: "node", args: [program] } };
      await fs.mkdir(/*turbopackIgnore: true*/ path.dirname(cursorFile), { recursive: true });
      await fs.writeFile(/*turbopackIgnore: true*/ cursorFile, `${JSON.stringify({ ...json, mcpServers: servers }, null, text ? indentOf(text) : "  ")}\n`);
    },
    async editRemove() {
      const text = await readText(cursorFile);
      const json = parseJson(text);
      if (!text || !json) return;
      const servers = { ...((json.mcpServers as Record<string, unknown> | undefined) ?? {}) };
      if (!(NAME in servers)) return;
      delete servers[NAME];
      await backup(cursorFile);
      await fs.writeFile(/*turbopackIgnore: true*/ cursorFile, `${JSON.stringify({ ...json, mcpServers: servers }, null, indentOf(text))}\n`);
    },
  },
  {
    id: "grok",
    name: "Grok CLI",
    bins: ["grok"],
    config: path.join(home, ".grok", "config.toml"),
    connected: hasToml(path.join(home, ".grok", "config.toml")),
    add: (p) => ["mcp", "add", "-s", "user", NAME, "node", "--", p],
    remove: ["mcp", "remove", NAME],
  },
  {
    id: "opencode",
    name: "OpenCode",
    bins: ["opencode"],
    config: openCodeFiles[0],
    async connected() {
      const json = parseJson(await readText(await openCodeFile()));
      const mcp = json?.mcp as Record<string, unknown> | undefined;
      return Boolean(mcp && (NAME in mcp || (mcp.servers && typeof mcp.servers === "object" && NAME in (mcp.servers as object))));
    },
    add: (p) => ["mcp", "add", NAME, "--", "node", p],
    remove: null,
    words: { connect: "", remove: `Takes the "${NAME}" entry out of ${tilde(openCodeFiles[0])} (OpenCode has no remove command). A copy of the file is kept beside it first.` },
    async editRemove() {
      const file = await openCodeFile();
      const text = await readText(file);
      if (!text || !new RegExp(`"${NAME}"\\s*:`).test(text)) return;
      // The entry as OpenCode writes it: an object with at most one more level inside (its command list, its environment).
      const entry = new RegExp(`(,\\s*)?"${NAME}"\\s*:\\s*\\{(?:[^{}]|\\{[^{}]*\\})*\\}(\\s*,)?`);
      let next = text.replace(entry, (_all, before: string | undefined, after: string | undefined) => (before && after ? "," : ""));
      // An "mcp" (or "servers") block left empty goes too, with the comma that led to it.
      for (const key of ["servers", "mcp"]) next = next.replace(new RegExp(`(,\\s*)?"${key}"\\s*:\\s*\\{\\s*\\}(\\s*,)?`), (_all, before: string | undefined, after: string | undefined) => (before && after ? "," : ""));
      if (!parseJson(next)) throw new Error(`Crackio couldn't take its entry out of ${tilde(file)} safely, so it left the file alone. Remove the "${NAME}" entry under "mcp" by hand.`);
      await backup(file);
      await fs.writeFile(/*turbopackIgnore: true*/ file, next);
    },
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    bins: ["gemini"],
    config: path.join(home, ".gemini", "settings.json"),
    connected: hasJsonKey(path.join(home, ".gemini", "settings.json"), "mcpServers"),
    add: (p) => ["mcp", "add", "-s", "user", NAME, "node", p],
    remove: ["mcp", "remove", "-s", "user", NAME],
  },
  {
    // Google's Antigravity CLI (`agy`): its own add and remove commands; it keeps the entry with Gemini's files.
    id: "antigravity",
    name: "Antigravity CLI",
    bins: ["agy"],
    config: path.join(home, ".gemini", "config", "mcp_config.json"),
    connected: hasJsonKey(path.join(home, ".gemini", "config", "mcp_config.json"), "mcpServers"),
    add: (p) => ["mcp", "add", NAME, "node", p],
    remove: ["mcp", "remove", NAME],
  },
];

const commandLine = (bin: string, args: string[]) => [bin, ...args.map((a) => (/[\s"]/.test(a) ? shellQuote(a) : a))].join(" ");

async function binOf(def: Def): Promise<{ bin: string; file: string } | null> {
  for (const bin of def.bins) {
    const file = await onPath(bin);
    if (file) return { bin, file };
  }
  return null;
}

async function describe(def: Def): Promise<AgentCli> {
  const [bin, folder, connected] = await Promise.all([binOf(def), def.folder ? fs.stat(/*turbopackIgnore: true*/ def.folder).then((s) => s.isDirectory()).catch(() => false) : false, def.connected().catch(() => false)]);
  const program = programPath();
  return {
    id: def.id,
    name: def.name,
    found: Boolean(bin || folder),
    connected,
    config: tilde(def.config),
    change: {
      connect: def.add ? `Runs: ${commandLine(def.bins[0], def.add(program))}` : (def.words?.connect ?? ""),
      remove: def.remove ? `Runs: ${commandLine(def.bins[0], def.remove)}` : (def.words?.remove ?? ""),
    },
  };
}

export const agentClis = () => Promise.all(DEFS.map(describe));

/** Runs a CLI's own command from the home folder (a project's config there is never what gets written). */
async function runOwn(def: Def, args: string[]) {
  const bin = await binOf(def);
  if (!bin) throw new Error(`${def.name} isn't on this computer.`);
  const quoted = args.map((a) => (/[\s"&|<>^]/.test(a) ? shellQuote(a) : a));
  const out = await runCli(shellQuote(bin.file), quoted, { timeoutMs: 60_000, cwd: home });
  const said = stripAnsi(`${out.stdout}\n${out.stderr}`).trim();
  if (out.code !== 0) throw new Error(said.split("\n").filter(Boolean).slice(-3).join(" ").slice(0, 300) || `${def.name} refused (exit ${out.code}).`);
  return said;
}

export async function connectCli(id: CliId): Promise<AgentCli> {
  const def = DEFS.find((d) => d.id === id);
  if (!def) throw new Error("Unknown agent.");
  const program = programPath();
  if (!(await fs.stat(/*turbopackIgnore: true*/ program).catch(() => null))) throw new Error("Crackio's MCP program is missing from this install (scripts/mcp/crackio-mcp.mjs).");
  // Adding twice makes two entries in some CLIs: an entry that's there is replaced.
  if (await def.connected().catch(() => false)) await removeCli(id).catch(() => undefined);
  if (def.add) await runOwn(def, def.add(program));
  else await def.editAdd?.(program);
  // Cursor loads a new server only once it's approved: its CLI says so for us, when it's there.
  if (def.id === "cursor" && (await onPath("cursor-agent"))) await runOwn({ ...def, bins: ["cursor-agent"] }, ["mcp", "enable", NAME]).catch(() => undefined);
  const now = await describe(def);
  if (!now.connected) throw new Error(`${def.name} took the command, but Crackio's entry isn't in ${now.config}. Add it by hand: node ${program}`);
  return now;
}

export async function removeCli(id: CliId): Promise<AgentCli> {
  const def = DEFS.find((d) => d.id === id);
  if (!def) throw new Error("Unknown agent.");
  if (def.remove) await runOwn(def, def.remove);
  else await def.editRemove?.();
  return describe(def);
}

/** Whether Crackio's MCP program starts and reaches this Crackio: what "the connection works" rests on for every CLI. */
export function checkProgram(): Promise<{ ok: boolean; tools?: number; error?: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [programPath(), "--check"], { timeout: 30_000, windowsHide: true, env: { ...process.env, CRACKIO_URL: `http://127.0.0.1:${process.env.PORT || 3000}` } }, (_err, stdout) => {
      try {
        const answer = JSON.parse(String(stdout).trim().split("\n").pop() ?? "") as { ok?: boolean; tools?: number; error?: { what?: string }; off?: string };
        resolve(answer.ok ? { ok: true, tools: answer.tools } : { ok: false, error: answer.off ?? answer.error?.what ?? "The program couldn't reach Crackio." });
      } catch {
        resolve({ ok: false, error: "The program didn't start. Is Node.js on this computer's PATH?" });
      }
    });
  });
}
