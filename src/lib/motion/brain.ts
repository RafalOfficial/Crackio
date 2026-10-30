import "server-only";
import { EngineError } from "@/lib/engines/types";
import { routerChat, type ChatData } from "@/lib/engines/comfy-text";
import type { ModelAvailability } from "@/lib/models/catalog";

/**
 * The model behind Motion, seen as an agent: it gets the conversation and the tools, answers
 * with text and tool calls, and gets each tool's result back, turn after turn, over Comfy Router's chat endpoint
 * (your Comfy key).
 */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export type ToolSpec = { name: string; description: string; parameters: Record<string, unknown> };
export type ToolCall = { id: string; name: string; args: Record<string, unknown>; invalid?: boolean };
export type BrainTurn = { text: string; calls: ToolCall[] };
/** A tool's answer; `images` are data URLs the model should see. */
export type ToolResult = { id: string; output: string; images?: string[] };

export type StepHooks = { onText?: (soFar: string) => void; onArgs?: (chars: number) => void; onThinking?: (summary: string) => void };

export type Brain = {
  step(o: { signal: AbortSignal; effort: Effort } & StepHooks): Promise<BrainTurn>;
  results(r: ToolResult[]): void;
};

type First = { text: string; images: string[] };

/** Older images are dropped from the history once this many newer ones exist (requests stay small). */
const KEEP_IMAGES = 8;

function parseArgs(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------- Chat completions (Comfy Router) */

type Complete = (body: Record<string, unknown>, signal: AbortSignal) => Promise<ChatData>;

/** A chat-completions model as an agent: tool calls in, tool results back. */
function chatBrain(complete: Complete, model: string, instructions: string, tools: ToolSpec[], first: First): Brain {
  type Part = { type: string; text?: string; image_url?: { url: string; detail?: string } };
  type Msg = { role: string; content: string | Part[] | null; tool_calls?: unknown[]; tool_call_id?: string };
  const messages: Msg[] = [
    { role: "system", content: instructions },
    { role: "user", content: [{ type: "text", text: first.text }, ...first.images.map((url) => ({ type: "image_url", image_url: { url, detail: "high" } }))] },
  ];
  const imageMessages: Msg[] = [];
  return {
    async step({ signal, onText }) {
      const data = await complete(
        {
          model,
          messages,
          ...(tools.length ? { tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })), tool_choice: "auto" } : {}),
        },
        signal,
      );
      const msg = data.choices?.[0]?.message ?? {};
      messages.push({ role: "assistant", content: msg.content ?? "", ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}) });
      if (msg.content) onText?.(msg.content);
      return {
        text: (msg.content ?? "").trim(),
        calls: (msg.tool_calls ?? []).map((c) => {
          const args = parseArgs(c.function.arguments);
          return { id: c.id, name: c.function.name, args: args ?? {}, invalid: !args };
        }),
      };
    },
    results(results) {
      for (const r of results) messages.push({ role: "tool", tool_call_id: r.id, content: r.output });
      const images = results.flatMap((r) => r.images ?? []);
      if (images.length) {
        const m: Msg = {
          role: "user",
          content: [{ type: "text", text: "(Images from the tool results above, in order.)" }, ...images.map((url) => ({ type: "image_url", image_url: { url, detail: "high" } }))],
        };
        messages.push(m);
        imageMessages.push(m);
        let seen = 0;
        for (const old of [...imageMessages].reverse()) {
          const n = (old.content as Part[]).filter((p) => p.type === "image_url").length;
          if (seen + n > KEEP_IMAGES) old.content = "(Earlier tool images, omitted to save space.)";
          seen += n;
        }
      }
    },
  };
}

/* ---------------------------------------------------------------- Pick the route */

export async function createBrain(model: ModelAvailability, instructions: string, tools: ToolSpec[], first: First): Promise<Brain> {
  switch (model.family) {
    case "comfy-text":
      return chatBrain((body, signal) => routerChat(body, signal, model.name), model.model, instructions, tools, first);
    case "comfy-local-text":
      throw new EngineError("The open model on your GPU is too small to run Motion.", "Pick a Comfy model (Claude Sonnet 5 works best) with a Comfy API key in Connections.");
    default:
      throw new EngineError(`${model.name} can't run Motion.`, "Pick a Comfy model (Claude Sonnet 5 works best) with a Comfy API key in Connections.");
  }
}
