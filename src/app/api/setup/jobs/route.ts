import { z } from "zod";
import { setupSnapshot } from "@/lib/server/setup/status";
import { SetupError, setupJobs, startSetup, stopSetup } from "@/lib/server/setup/jobs";
import { isKitId } from "@/lib/setup/kits";

/** Set-ups in progress and lately finished, newest first. */
export async function GET() {
  return Response.json({ jobs: setupJobs() }, { headers: { "Cache-Control": "no-store" } });
}

const Start = z.object({
  machine: z.string().min(1).max(80),
  kits: z.array(z.string().max(40)).min(1).max(20),
  /** Optional requirements to get too ("voice.talk"). */
  include: z.array(z.string().max(60)).max(20).optional(),
  /** Models picked in Settings, by requirement ("video.model": LTX-2.5, INT8), instead of Crackio's picks. */
  choices: z.record(z.string().max(60), z.object({ model: z.string().min(1).max(80), variant: z.string().min(1).max(60) })).optional(),
});

/** Sets tools up on a machine: everything they need that isn't there, picked for its hardware or by you (`choices`). */
export async function POST(request: Request) {
  const parsed = Start.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid request" }, { status: 400 });
  const kits = parsed.data.kits.filter(isKitId);
  try {
    const job = await startSetup(await setupSnapshot(true), { machine: parsed.data.machine, kits, include: parsed.data.include, choices: parsed.data.choices });
    return Response.json({ job });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: err instanceof SetupError ? err.status : 500 });
  }
}

/** Stops a set-up: ?id= */
export async function DELETE(request: Request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return Response.json({ error: "Which set-up?" }, { status: 400 });
  try {
    return Response.json({ job: await stopSetup(id) });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: err instanceof SetupError ? err.status : 500 });
  }
}
