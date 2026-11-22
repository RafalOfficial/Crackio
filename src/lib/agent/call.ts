import "server-only";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { z } from "zod";
import pkg from "../../../package.json";
import { demoOn } from "@/lib/demo/config";
import { freeOnly } from "@/lib/server/job-scope";
import { DATA_DIR } from "@/lib/server/paths";
import { noteAddress } from "./address";
import { failure, thrownFailure, type AgentFailure } from "./errors";
import { INSTRUCTIONS } from "./guide";
import { SHOWN_DIR, type Shown } from "./pictures";
import { agentPrefs } from "./prefs";
import { agentTool, AGENT_TOOLS, listTools, type ListedTool } from "./tools";

/**
 * The agent door's two questions: what tools are there, and run one. Both transports ask them here: the stdio program
 * through /api/agent, and Streamable HTTP through /api/agent/mcp.
 */
export type CallAnswer = { ok: true; data: unknown; images: Pick<Shown, "url" | "width" | "height" | "label">[] } | { ok: false; error: AgentFailure };

/** The agent program's name as it's kept on takes: short, lower-case, nothing odd. */
export const cleanClient = (name: unknown) =>
  (typeof name === "string" ? name : "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "agent";

/** A validation problem as a failure that names the field and what it takes. */
function inputFailure(issue: z.core.$ZodIssue, toolName: string, args: unknown): AgentFailure {
  const field = issue.path.join(".") || undefined;
  // What was really sent there (zod doesn't say): undefined only when the argument is absent.
  const given = issue.path.reduce<unknown>((node, key) => (node && typeof node === "object" ? (node as Record<PropertyKey, unknown>)[key as PropertyKey] : undefined), args);
  const kind = (v: unknown) => (Array.isArray(v) ? "list" : v === null ? "null" : typeof v);
  if (issue.code === "unrecognized_keys") {
    const known = Object.keys(agentTool(toolName)?.input.shape ?? {});
    return failure("invalid_input", { field: issue.keys.join(", "), what: `${toolName} has no argument "${issue.keys.join('", "')}".`, allowed: known });
  }
  if (issue.code === "invalid_value") return failure("invalid_input", { field, what: given === undefined ? `"${field}" is missing.` : `"${field}" isn't one of the values it takes.`, allowed: issue.values as unknown[] });
  if (issue.code === "invalid_type") {
    const takes = issue.expected === "int" ? "a whole number" : issue.expected === "object" ? "an object" : issue.expected === "array" ? "a list" : `a ${issue.expected}`;
    if (!field) return failure("invalid_input", { what: `The arguments have to be an object, not a ${kind(args)}.` });
    if (given === undefined) return failure("invalid_input", { field, what: `"${field}" is missing.`, why: `It takes ${takes}.` });
    return failure("invalid_input", { field, what: `"${field}" has to be ${takes}; you sent a ${kind(given) === "number" ? "number with a fraction" : kind(given)}.` });
  }
  if (issue.code === "too_big" || issue.code === "too_small") {
    const limit = issue.code === "too_big" ? `at most ${String(issue.maximum)}` : `at least ${String(issue.minimum)}`;
    const what = issue.origin === "string" ? "characters" : issue.origin === "array" ? "items" : "";
    return failure("invalid_input", { field, what: `"${field}" takes ${limit}${what ? ` ${what}` : ""}.` });
  }
  return failure("invalid_input", { field, what: `"${field ?? "The arguments"}" isn't valid.`, why: issue.message });
}

/**
 * Arguments some agent programs add to every tool call for their own scheduling (Gemini CLI's `wait_for_previous`):
 * not the model's, so they're dropped instead of refused as unknown.
 */
const CLIENT_EXTRAS = new Set(["wait_for_previous"]);

export async function callTool(name: string, args: unknown, client: string, signal: AbortSignal, viaProgram = true): Promise<CallAnswer> {
  if (args && typeof args === "object" && !Array.isArray(args)) args = Object.fromEntries(Object.entries(args).filter(([k]) => !CLIENT_EXTRAS.has(k)));
  try {
    if (demoOn()) return { ok: false, error: failure("demo_mode") };
    const prefs = await agentPrefs();
    if (!prefs.enabled) return { ok: false, error: failure("agents_off") };
    const tool = agentTool(name);
    if (!tool) return { ok: false, error: failure("unknown_tool", { what: `Crackio has no tool "${String(name).slice(0, 60)}".`, allowed: AGENT_TOOLS.map((t) => t.name) }) };
    const parsed = tool.input.strict().safeParse(args ?? {});
    if (!parsed.success) return { ok: false, error: inputFailure(parsed.error.issues[0], name, args ?? {}) };
    const ctx = { caller: { client: cleanClient(client), seePictures: prefs.seePictures, free: prefs.spend === "free" }, prefs, signal, viaProgram };
    // Held to free paths: whatever the tool does itself (finding things, reading a product) never spends credits.
    const out = await (prefs.spend === "free" ? freeOnly(() => tool.run(parsed.data as never, ctx)) : tool.run(parsed.data as never, ctx));
    return { ok: true, data: out.data, images: (out.images ?? []).map(({ url, width, height, label }) => ({ url, width, height, ...(label ? { label } : {}) })) };
  } catch (err) {
    const error = thrownFailure(err);
    if (error.code === "unknown") console.warn(`[agent] ${name} failed: ${(err as Error)?.stack ?? err}`);
    return { ok: false, error };
  }
}

/**
 * This Crackio's own mark, kept in its data folder: the stdio program reads it from disk to know it's on the same
 * computer as the server (then results are files it can point at, with nothing to download).
 */
async function instanceId(): Promise<string> {
  const g = globalThis as unknown as { __crackioAgentInstance?: string };
  if (g.__crackioAgentInstance) return g.__crackioAgentInstance;
  const file = path.join(/*turbopackIgnore: true*/ SHOWN_DIR, "instance.json");
  let id = "";
  try {
    id = String((JSON.parse(await fs.readFile(/*turbopackIgnore: true*/ file, "utf8")) as { id?: unknown }).id ?? "");
  } catch {
    // First run: made below.
  }
  if (!/^[a-f0-9]{24}$/.test(id)) {
    id = randomBytes(12).toString("hex");
    await fs.mkdir(/*turbopackIgnore: true*/ SHOWN_DIR, { recursive: true });
    await fs.writeFile(/*turbopackIgnore: true*/ file, JSON.stringify({ id }));
  }
  return (g.__crackioAgentInstance = id);
}

export type AgentDoor = {
  name: "crackio";
  title: "Crackio";
  version: string;
  instructions: string;
  tools: ListedTool[];
  instance: string;
  /** Where Crackio keeps its files, told only to a caller on this computer. */
  dataDir?: string;
  off?: AgentFailure;
};

export async function describeDoor({ local }: { local: boolean }): Promise<AgentDoor> {
  void noteAddress();
  const prefs = await agentPrefs();
  const off = demoOn() ? failure("demo_mode") : !prefs.enabled ? failure("agents_off") : undefined;
  return {
    name: "crackio",
    title: "Crackio",
    version: pkg.version,
    instructions: INSTRUCTIONS,
    tools: listTools(),
    instance: await instanceId(),
    ...(local ? { dataDir: DATA_DIR } : {}),
    ...(off ? { off } : {}),
  };
}
