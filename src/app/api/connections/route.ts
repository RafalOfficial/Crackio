import { detectConnections } from "@/lib/providers/detect";
import { implementedEngines } from "@/lib/engines";

export async function GET() {
  const implemented = new Set(implementedEngines());
  const providers = (await detectConnections()).map((p) => ({ ...p, ready: implemented.has(p.id) }));
  return Response.json({ providers }, { headers: { "Cache-Control": "no-store" } });
}
