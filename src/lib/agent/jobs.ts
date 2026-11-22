import "server-only";
import { POST as startRoute } from "@/app/api/generations/route";
import type { Generation, MediaRef } from "@/lib/generations/types";
import { getGeneration, listGenerations } from "@/lib/server/db";
import { urlToPath } from "@/lib/server/media";
import { runner } from "@/lib/server/runner";
import { AgentError, fail, failure, jobFailure, trimRaw, type AgentFailure } from "./errors";
import { frameSheet, sheet, small, tokensOf, type Shown } from "./pictures";
import { crackioQueue } from "./plan";

/** Who is calling: the agent program's name ("claude-code", "codex"), kept on every take it makes. */
export type Caller = { client: string; seePictures: boolean; /** The user keeps agents to free paths: its jobs carry that, so nothing inside them spends credits. */ free: boolean };

/** The mark every agent-made take carries. */
export const agentMark = (caller: Caller) => ({ client: caller.client, ...(caller.free ? { free: true } : {}) });

export const madeByAgent = (g: Generation | null | undefined): g is Generation => Boolean(g && typeof g.params?.agent === "object" && g.params.agent !== null);

type StartBody = {
  tool: string;
  prompt: string;
  /** The words sent to the model when they aren't the take's title (an edit tool's fixed instruction). */
  compiledPrompt?: string;
  aspect: string;
  count: number;
  model: string;
  references?: { url: string; label?: string; role?: "subject" | "product" | "place" | "style" | "edit-target" }[];
  params: Record<string, unknown>;
};

/**
 * Starts a job the way the screens do (the same route, so Cast mentions and the queue behave the same), with two
 * differences that hold for every agent job: the prompt enhancer is never on (`refine: false`: the agent wrote the
 * prompt), and the take is marked with the agent that made it.
 */
export async function startJob(body: StartBody, caller: Caller): Promise<Generation> {
  const res = await startRoute(
    new Request("http://crackio.internal/api/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, refine: false, references: body.references ?? [], params: { ...body.params, agent: agentMark(caller) } }),
    }),
  );
  const answer = (await res.json().catch(() => null)) as { item?: Generation; error?: string; issues?: { path: (string | number)[]; message: string }[] } | null;
  if (res.ok && answer?.item) return answer.item;
  const issue = answer?.issues?.[0];
  if (issue) throw fail("invalid_input", { field: issue.path.join("."), why: issue.message });
  throw fail("invalid_input", { why: answer?.error ?? `Crackio refused the job (${res.status}).` });
}

export type JobView = {
  job: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  tool: string;
  model?: string;
  progress?: number;
  stage?: string;
  /** Jobs ahead of it in Crackio's queue, while it waits. */
  ahead?: number;
  /** Seconds it ran (done), or has run so far (running). */
  took_s?: number;
  running_s?: number;
  /** The words really sent to the model. */
  prompt_sent?: string;
  results?: { n?: number; file: string; kind: MediaRef["kind"]; width?: number; height?: number; seconds?: number; fps?: number; mb?: number }[];
  /** The seed it ran with: the same seed, prompt, size and count give the same pictures again. */
  seed?: number;
  /** A link that opens it in the user's Crackio. */
  open?: string;
  /** A Voice take: what speech to text heard, and the share of the script's words it missed (0 to 1). */
  heard?: string;
  words_missed?: number;
  error?: AgentFailure;
};

const mb = (bytes?: number) => (bytes ? Math.round((bytes / 1e6) * 10) / 10 : undefined);

export function jobView(g: Generation, { detail = false }: { detail?: boolean } = {}): JobView {
  const cancelled = g.status === "error" && /^cancelled\.?$/i.test(g.error ?? "");
  const status: JobView["status"] = g.status === "error" ? (cancelled ? "cancelled" : "failed") : g.status;
  const view: JobView = { job: g.id, status, tool: g.tool };
  if (g.modelName) view.model = g.modelName;
  if (status === "queued") {
    const at = crackioQueue().ids.indexOf(g.id);
    if (at >= 0) view.ahead = at;
  }
  if (status === "running") {
    view.progress = Math.round((g.progress ?? 0) * 100) / 100;
    if (g.stage) view.stage = g.stage;
    if (g.startedAt) view.running_s = Math.round((Date.now() - g.startedAt) / 1000);
  }
  if (status === "done") {
    if (g.startedAt && g.finishedAt) view.took_s = Math.round((g.finishedAt - g.startedAt) / 100) / 10;
    // What was sent, when it isn't word for word what the agent wrote (Cast lines, trigger words), or when asked.
    if (g.compiledPrompt && (detail || g.compiledPrompt.trim() !== g.prompt.trim())) view.prompt_sent = g.compiledPrompt;
    view.results = g.outputs.map((o) => ({
      file: o.url,
      kind: o.kind,
      ...(o.width && o.height ? { width: o.width, height: o.height } : {}),
      ...(o.duration ? { seconds: Math.round(o.duration * 100) / 100 } : {}),
      ...(o.fps ? { fps: Math.round(o.fps * 100) / 100 } : {}),
      ...(detail && o.bytes ? { mb: mb(o.bytes) } : {}),
    }));
    const heard = g.params?.heard as { heard?: unknown; missed?: unknown } | undefined;
    if (typeof heard?.heard === "string") view.heard = heard.heard.slice(0, 1500);
    if (typeof heard?.missed === "number") view.words_missed = Math.round(heard.missed * 100) / 100;
    const seed = (g.params?.options as { seed?: unknown } | undefined)?.seed;
    if (typeof seed === "number") view.seed = seed;
    // The stdio program (or the HTTP door) puts Crackio's own address in place of {{crackio}}.
    if (g.outputs.length) view.open = `{{crackio}}/library?view=${g.id}:0`;
  }
  if (status === "failed") view.error = jobFailure(g.error, g.stage);
  if (status === "cancelled") view.error = failure("job_cancelled");
  return view;
}

export function jobById(id: string): Generation {
  const g = getGeneration(id);
  if (!g) throw fail("job_not_found", { what: `There's no job with the id "${trimRaw(id, 40)}".` });
  return g;
}

const settled = (g: Generation) => g.status === "done" || g.status === "error";

/** Waits until every job has ended or `seconds` have passed, and gives each job as it stands then. Never throws for a slow job. */
export async function waitFor(ids: string[], seconds: number, signal?: AbortSignal): Promise<Generation[]> {
  const until = Date.now() + Math.max(0, seconds) * 1000;
  for (;;) {
    const now = ids.map(jobById);
    if (now.every(settled) || Date.now() >= until || signal?.aborted) return now;
    await new Promise((r) => setTimeout(r, 400));
  }
}

/** Cancels a job an agent started. A job the user (or anything else) started is left alone. */
export function cancelJob(id: string): JobView {
  const g = jobById(id);
  if (!madeByAgent(g)) throw fail("not_yours", { what: "That job was started in Crackio by the user, not by an agent: agents never cancel those." });
  if (!settled(g)) runner().cancel(id);
  return jobView(jobById(id));
}

/** The agent-made jobs, newest first: what's waiting and running, and the latest that ended. */
export function recentJobs(limit = 20, onlyOpen = false): Generation[] {
  return listGenerations({ limit: 200 })
    .filter((g) => madeByAgent(g) && (!onlyOpen || !settled(g)))
    .slice(0, limit);
}

/**
 * What a model looks at for finished jobs: one small picture, or one numbered sheet of several (each result's `n` is its
 * number on the sheet). A clip comes as a sheet of its frames. Sound has nothing to show. Upscales are never shown:
 * a small copy says nothing about them, so the agent hands the file to the user instead.
 */
export async function showResults(views: JobView[], gens: Generation[], { edge = 768 }: { edge?: number } = {}): Promise<{ images: Shown[]; notes: string[] }> {
  const images: Shown[] = [];
  const notes: string[] = [];
  const stills: { file: string; label: string }[] = [];
  let n = 0;
  for (const view of views) {
    const gen = gens.find((g) => g.id === view.job);
    if (view.status !== "done" || !view.results?.length) continue;
    if (gen?.params?.kind === "upscale") {
      notes.push(`Job ${view.job} is an upscale: it isn't shown to you. Hand the user the file itself (attach it if you can, else its path).`);
      continue;
    }
    for (const r of view.results) {
      const file = urlToPath(r.file);
      if (!file) continue;
      if (r.kind === "image") {
        r.n = ++n;
        stills.push({ file, label: String(n) });
      } else if (r.kind === "video") {
        try {
          const s = await frameSheet(file, { rate: 1 });
          images.push({ ...s, label: `Job ${view.job}: its frames at ${s.rate} a second (${s.duration} s long), the time on each.` });
        } catch (err) {
          notes.push(`Couldn't read frames from job ${view.job}'s clip: ${trimRaw((err as Error).message, 120)}`);
        }
      }
    }
  }
  try {
    if (stills.length === 1) images.unshift({ ...(await small(stills[0].file, edge)), label: "Result 1." });
    else if (stills.length > 1) images.unshift({ ...(await sheet(stills, { edge: 1280 })), label: `Results 1–${stills.length}, numbered as in "n".` });
  } catch (err) {
    notes.push(`Couldn't make a preview: ${trimRaw((err as Error).message, 120)}`);
  }
  return { images, notes };
}

export { AgentError, tokensOf };
