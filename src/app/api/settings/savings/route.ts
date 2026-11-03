import { savingsSummary } from "@/lib/server/setup/savings";

/** What your takes would have cost on the models' official APIs, next to what their GPU time cost here. ?days=30|all */
export async function GET(request: Request) {
  const raw = new URL(request.url).searchParams.get("days");
  const days = raw === "all" ? null : Math.max(1, Math.min(365, Number(raw) || 30));
  return Response.json(await savingsSummary(days), { headers: { "Cache-Control": "no-store" } });
}
