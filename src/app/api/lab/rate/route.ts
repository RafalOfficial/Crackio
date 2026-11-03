import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR, MEDIA_DIR } from "@/lib/server/paths";

/**
 * A/B rating for training Crackio's own models from your taste: pairs of results (two swap takes of the same frame, two
 * sets of boxes, two pictures from two prompts), and your pick for each. The queue is
 * data/media/feedback/<task>/pairs.json (its pictures beside it in img/); picks go to data/feedback/<task>/choices.jsonl,
 * one line each, so an undo is just a later line. "custom" is neither: your own answer in your words (`text`), as a
 * chat reply you'd rather hear.
 */

const TASKS = ["swap", "retouch", "prompt", "chat"] as const;
type Task = (typeof TASKS)[number];
const CHOICES = ["a", "b", "both_bad", "both_good", "skip", "custom", "undo"] as const;
/** How many of your latest picks the page can step back through (Undo), after a reload too. */
const BACK = 60;

type Pair = { id: string; meta?: unknown; [key: string]: unknown };
type Picked = { choice: string; text?: string };

const queueFile = (task: Task) => path.join(MEDIA_DIR, "feedback", task, "pairs.json");
const picksFile = (task: Task) => path.join(DATA_DIR, "feedback", task, "choices.jsonl");

/** Each pair's latest pick (an undo clears it), the most recent last. */
async function picks(task: Task) {
  const out = new Map<string, Picked>();
  const text = await fs.readFile(picksFile(task), "utf8").catch(() => "");
  for (const line of text.split("\n")) {
    try {
      const { id, choice, text } = JSON.parse(line) as { id: string; choice: string; text?: string };
      out.delete(id);
      if (choice !== "undo") out.set(id, text ? { choice, text } : { choice });
    } catch {
      /* a blank or torn line */
    }
  }
  return out;
}

export async function GET(request: Request) {
  const task = new URL(request.url).searchParams.get("task") as Task;
  if (!TASKS.includes(task)) return Response.json({ error: "Unknown task." }, { status: 400 });
  const pairs = JSON.parse(await fs.readFile(queueFile(task), "utf8").catch(() => "[]")) as Pair[];
  const done = await picks(task);
  // What the models and measurements said stays out of the page: your eye only.
  const plain = ({ meta: _meta, ...p }: Pair) => p;
  const open = pairs.filter((p) => !done.has(p.id)).map(plain);
  // Your latest picks with what you picked, oldest first, for Undo to step back through.
  const byId = new Map(pairs.map((p) => [p.id, p]));
  const back = [...done]
    .slice(-BACK)
    .flatMap(([id, picked]) => (byId.has(id) ? [{ ...plain(byId.get(id)!), picked }] : []));
  // A "live" file beside the queue: a round is still being made, and more pairs will join it.
  const live = await fs.stat(path.join(path.dirname(queueFile(task)), "live")).then(
    () => true,
    () => false,
  );
  return Response.json({ pairs: open, back, done: done.size, total: pairs.length, live }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { task?: Task; id?: string; choice?: string; ms?: number; text?: unknown } | null;
  if (!body?.task || !TASKS.includes(body.task) || !body.id || !CHOICES.includes(body.choice as (typeof CHOICES)[number])) {
    return Response.json({ error: "Send a task, a pair id and a choice." }, { status: 400 });
  }
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (body.choice === "custom" && (!text || text.length > 2000)) {
    return Response.json({ error: "Your own answer needs some words (up to 2000 characters)." }, { status: 400 });
  }
  const file = picksFile(body.task);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(
    file,
    JSON.stringify({ id: body.id, choice: body.choice, ...(body.choice === "custom" ? { text } : {}), ms: body.ms ?? null, at: Date.now() }) + "\n",
  );
  return Response.json({ ok: true });
}
