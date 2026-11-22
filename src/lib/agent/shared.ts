import "server-only";
import { z } from "zod";
import type { ResolutionId } from "@/lib/local/resolution";
import { probe } from "@/lib/motion/ffmpeg";
import { urlToPath } from "@/lib/server/media";
import { ourHost } from "@/lib/server/our-host";
import { ASPECTS, type AspectId } from "@/lib/shot";
import { fail } from "./errors";
import { jobView, showResults, waitFor, type Caller } from "./jobs";
import type { Shown } from "./pictures";
import type { Plan } from "./plan";
import { spendNow, type AgentPrefs } from "./prefs";

/**
 * What every agent tool is made of. A tool is one definition: its name, a one- or two-sentence description (they sit in
 * the agent's context all session, so every word costs), its arguments as a zod schema (the list an agent sees is made
 * from it, and the same schema checks every call), and what it does. Depth lives in the guide, not in descriptions.
 */
export type ToolContext = {
  caller: Caller;
  prefs: AgentPrefs;
  signal: AbortSignal;
  /** The call came through Crackio's MCP program, which uploads local files; over plain HTTP nothing can. */
  viaProgram: boolean;
};

/**
 * A part of a picture or frame, the same way in every tool: fractions of its width and height (0 to 1) from the
 * top-left corner.
 */
export const region = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().min(0.01).max(1), h: z.number().min(0.01).max(1) });
export type Region = z.infer<typeof region>;
/** A region as Crackio's own boxes are: x0, y0, x1, y1 in 0–1000. */
export const boxOf = (r: Region): [number, number, number, number] => [Math.round(r.x * 1000), Math.round(r.y * 1000), Math.round(Math.min(1, r.x + r.w) * 1000), Math.round(Math.min(1, r.y + r.h) * 1000)];
export type ToolOutput = { data: unknown; images?: Shown[] };

export type AgentTool = {
  name: string;
  title: string;
  description: string;
  input: z.ZodObject;
  /** Arguments that hold files, as dotted paths ("*" for each item of a list): the stdio program uploads local paths there. */
  files?: string[];
  /** It changes nothing. */
  readOnly?: boolean;
  /** It can delete or overwrite. */
  destructive?: boolean;
  run: (args: never, ctx: ToolContext) => Promise<ToolOutput>;
};

export const tool = <S extends z.ZodObject>(def: Omit<AgentTool, "input" | "run"> & { input: S; run: (args: z.infer<S>, ctx: ToolContext) => Promise<ToolOutput> }): AgentTool => def as unknown as AgentTool;

/* ------------------------------------------------------------------ arguments many tools share */

export const aspectIds = ASPECTS.map((a) => a.id) as [AspectId, ...AspectId[]];
export const SIZES = ["draft", "720p", "1k", "2k", "4k"] as const satisfies readonly ResolutionId[];

export const dryRun = z.boolean().optional();
export const confirm = z.string().max(40).optional();
export const waitArg = z.number().min(0).max(50).optional();
export const showArg = z.boolean().optional();
export const machineArg = z.string().max(80).optional();
export const fileArg = (what: string) => z.string().max(600).describe(what);

/** The shape among Crackio's seven that's closest to a picture's (width / height). */
export function aspectNear(ratio: number): AspectId {
  let best: AspectId = "3:2";
  let off = Infinity;
  for (const a of ASPECTS) {
    const d = Math.abs(Math.log(a.w / a.h / ratio));
    if (d < off) {
      off = d;
      best = a.id;
    }
  }
  return best;
}

/* ------------------------------------------------------------------ files */

/** A file argument as Crackio keeps it: one of its own media addresses. The stdio program turns local paths into these. */
export function fileOf(value: string, field: string, viaProgram = true): { url: string; path: string } {
  let url = value.trim();
  // A full address of this Crackio's own media is the same file; another site's address never is.
  if (/^https?:\/\//i.test(url)) {
    try {
      const u = new URL(url);
      if (ourHost(u.host) && u.pathname.startsWith("/api/media/")) url = u.pathname;
    } catch {
      // Not an address at all: refused below.
    }
  }
  const path = url.startsWith("/api/media/") || url.startsWith("/assets/") ? urlToPath(url) : null;
  if (!path) {
    throw fail("file_not_found", {
      field,
      what: `Crackio has no file "${value.slice(0, 120)}".`,
      do: /^(\/api\/|https?:)/i.test(value)
        ? "Use a file a Crackio tool returned."
        : viaProgram
          ? "Check the path: the file has to exist on the computer the agent runs on."
          : "This connection (an address, not the Crackio MCP program) can't send files from a computer. Connect through the program (Crackio → Settings → Agents), or use files Crackio already has.",
    });
  }
  return { url, path };
}

/** A file argument that's really there, with what it is (picture, clip or sound; size; a clip's length). */
export async function existing(value: string, field: string, viaProgram = true) {
  const f = fileOf(value, field, viaProgram);
  const info = await probe(f.path).catch(() => null);
  if (!info) throw fail("file_not_found", { field, what: `Crackio has no file "${value.slice(0, 120)}" (any more).`, do: "Pass the original file's path again." });
  return { ...f, info };
}

/** A file argument that has to be a picture (or a clip, or sound). */
export async function existingKind(value: string, field: string, kind: "image" | "video" | "audio") {
  const f = await existing(value, field);
  if (f.info.kind !== kind) {
    const word = { image: "a picture", video: "a clip", audio: "a sound file" };
    throw fail("file_wrong_type", { field, what: `"${field}" has to be ${word[kind]}; this is ${word[f.info.kind as "image" | "video" | "audio"] ?? "another kind of file"}.`, do: `Pass ${word[kind]}.` });
  }
  return f;
}

/* ------------------------------------------------------------------ answers */

export const planView = (p: Plan) => ({
  model: p.model.id,
  model_name: p.model.name,
  ...(p.machine ? { machine: p.machine.id, machine_name: p.machine.gpu && !p.machine.name.includes(p.machine.gpu) ? `${p.machine.name} · ${p.machine.gpu}` : p.machine.name } : {}),
  ...(p.seconds != null ? { seconds: p.seconds } : {}),
  ...(p.range ? { seconds_range: p.range } : {}),
  ...(p.basis ? { time_from: p.basis } : {}),
  jobs_ahead: p.ahead,
  cost: p.cost.free ? "free" : p.cost.text,
  ...(p.size ? { size: p.size } : {}),
  ...(p.notes?.length ? { notes: p.notes } : {}),
});

/** A dry run's answer: the plan, and what a paid one still needs. */
export const dryAnswer = (p: Plan, extra: Record<string, unknown> = {}): ToolOutput => ({
  data: { dry_run: true, ...planView(p), ...extra, ...(p.cost.free || spendNow() === "all" ? {} : { needs: "the user's yes to this price; then call again without dry_run to get the confirm value" }) },
});

/** What a make or edit tool says it started. */
export const startedView = (job: string, p: Plan) => ({
  job,
  model: p.model.id,
  ...(p.machine ? { machine: p.machine.name } : {}),
  ...(p.seconds != null ? { expect_seconds: p.seconds } : {}),
  cost: p.cost.free ? "free" : p.cost.text,
  // The size it comes out at, and whether it's drawn at that size or enlarged to it (a true 4K picture or an enlarged one).
  ...(p.size ? { size: p.size } : {}),
});

/** A started job, waited on for a moment, as the make and edit tools answer: the job as it stands, and a preview when it's done. */
export async function answerJob(ids: string[], wait: number, show: boolean, ctx: ToolContext, extra: Record<string, unknown> = {}): Promise<ToolOutput> {
  const gens = await waitFor(ids, wait, ctx.signal);
  const views = gens.map((g) => jobView(g));
  const open = views.filter((v) => v.status === "queued" || v.status === "running");
  const shown = show && ctx.prefs.seePictures ? await showResults(views, gens) : { images: [], notes: [] };
  const { notes: given, ...rest } = extra as { notes?: string[] } & Record<string, unknown>;
  const notes = [...(given ?? []), ...shown.notes];
  if (open.length) notes.push(`Still working: call wait with ${open.length === 1 ? `job "${open[0].job}"` : "those job ids"}.`);
  if (!ctx.prefs.seePictures && views.some((v) => v.status === "done")) notes.push("The user keeps pictures from agents: you get file paths only. Give them to the user.");
  return { data: { ...rest, jobs: views, ...(notes.length ? { notes } : {}) }, images: shown.images };
}
