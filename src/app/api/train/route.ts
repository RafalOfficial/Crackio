import { z } from "zod";

/**
 * Train: GET lists every LoRA you've trained or are putting together (and picks running ones up again after a restart of
 * Crackio); POST starts a new one, empty.
 */
export async function GET() {
  try {
    const [{ allJobs, summaryOf }, { reattach }] = await Promise.all([import("@/lib/server/train/store"), import("@/lib/server/train/run")]);
    await reattach();
    return Response.json({ jobs: (await allJobs()).map(summaryOf) }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}

const Body = z.object({ name: z.string().max(60).optional(), goal: z.enum(["person", "character", "object", "style", "edit"]).optional() });

export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return Response.json({ error: "Invalid request" }, { status: 400 });
  const { createJob } = await import("@/lib/server/train/store");
  const { suggestTrigger } = await import("@/lib/train/plan");
  const given = parsed.data.name?.trim();
  const job = await createJob({ name: given || "New LoRA", goal: parsed.data.goal ?? "person", trigger: given ? suggestTrigger(given) : "" });
  return Response.json({ job }, { status: 201 });
}
