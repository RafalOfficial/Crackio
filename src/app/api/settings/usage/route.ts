import { demoOn } from "@/lib/demo/config";
import { usageSummary } from "@/lib/server/usage";
import type { UsageDays } from "@/lib/usage/types";

const DAYS = new Map<string, UsageDays>([
  ["7", 7],
  ["30", 30],
  ["90", 90],
  ["all", null],
]);

/**
 * Settings → Usage (server/usage): what Crackio made, how it went, where it ran. `?days=7|30|90|all` (30 when left out),
 * `&machine=` a GPU ("RTX 5090") for that machine's takes only.
 */
export async function GET(request: Request) {
  // The live demo adds up no one's work: every visitor's is their own (lib/demo).
  if (demoOn()) return Response.json({ error: "Not found" }, { status: 404 });
  const q = new URL(request.url).searchParams;
  const days = DAYS.get(q.get("days") ?? "30");
  if (days === undefined) return Response.json({ error: "days is 7, 30, 90 or all" }, { status: 400 });
  const machine = q.get("machine")?.trim().slice(0, 80) || undefined;
  try {
    return Response.json(await usageSummary({ days, machine }), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
