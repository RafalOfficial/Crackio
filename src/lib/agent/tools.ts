import "server-only";
import { z } from "zod";
import type { AgentTool } from "./shared";
import { cast } from "./tools-cast";
import { guide, jobs, look, status, wait } from "./tools-core";
import { makeImage, makeVideo } from "./tools-create";
import { motion } from "./tools-motion";
import { director } from "./tools-director";
import { angles, relight, upscale } from "./tools-edit";
import { addFile, library, loras, models } from "./tools-info";
import { product } from "./tools-product";
import { retouch } from "./tools-retouch";
import { settings } from "./tools-settings";
import { swap } from "./tools-swap";
import { voice } from "./tools-voice";

/**
 * The tools agents get, in the order they see them (kept the same between calls, so their caches hold). Each lives with
 * its group: tools-core (status, guide, wait, jobs, look), tools-create (pictures and clips), tools-info (models,
 * LoRAs, files, the Library), tools-cast, tools-edit (Relight, Upscale), tools-retouch, tools-swap, tools-voice.
 */
export const AGENT_TOOLS: AgentTool[] = [status, guide, models, loras, addFile, makeImage, makeVideo, wait, look, jobs, library, cast, retouch, relight, angles, upscale, swap, product, director, voice, motion, settings];

export const agentTool = (name: string) => AGENT_TOOLS.find((t) => t.name === name);

/** A tool's arguments as the JSON Schema an agent reads: lean, with no `$schema` line. */
export function inputSchema(t: AgentTool): Record<string, unknown> {
  const { $schema: _drop, ...schema } = z.toJSONSchema(t.input, { io: "input" }) as Record<string, unknown>;
  void _drop;
  return lean(schema) as Record<string, unknown>;
}

/**
 * Text and list length limits are the server's to check, not words an agent needs to read; nor are a number's limits
 * where its description already says what it takes. (A value out of range is refused with the range.)
 */
function lean(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(lean);
  if (!node || typeof node !== "object") return node;
  const described = typeof (node as { description?: unknown }).description === "string";
  return Object.fromEntries(
    Object.entries(node as Record<string, unknown>)
      .filter(([k]) => k !== "maxLength" && k !== "minLength" && k !== "maxItems" && k !== "minItems" && !(described && (k === "minimum" || k === "maximum")))
      .map(([k, v]) => [k, k === "enum" || k === "required" ? v : lean(v)]),
  );
}

export type ListedTool = { name: string; title: string; description: string; inputSchema: Record<string, unknown>; annotations: { readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean }; files?: string[] };

export const listTools = (): ListedTool[] =>
  AGENT_TOOLS.map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: inputSchema(t),
    annotations: { readOnlyHint: Boolean(t.readOnly), destructiveHint: Boolean(t.destructive), openWorldHint: false },
    ...(t.files ? { files: t.files } : {}),
  }));
