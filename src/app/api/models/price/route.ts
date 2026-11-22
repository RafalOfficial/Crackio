import { modelById } from "@/lib/models/catalog";
import { isCustomId } from "@/lib/models/custom";
import { detectConnections } from "@/lib/providers/detect";
import { implementedEngines } from "@/lib/engines/registry";
import { comfyKey } from "@/lib/providers/comfy-models";
import type { Pricing } from "@/lib/models/pricing";

const json = (p: Pricing) => Response.json({ pricing: p }, { headers: { "Cache-Control": "no-store" } });

/** How a model is priced, for the estimate above each tool's button. */
export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (!id || id.length > 300) return Response.json({ error: "Missing model id" }, { status: 400 });
  // Only the catalog and which connections answer are needed, not the live model list (it reads every machine). Local
  // models (template ones included) cost nothing; a catalog model priced by Comfy is quoted when Comfy is what runs it.
  const m = modelById(id);
  if (!m && isCustomId(id)) {
    if (id.startsWith("comfy:")) return json((await comfyKey()) ? { kind: "quote", provider: "Comfy" } : { kind: "none" });
  }
  if (!m) return json({ kind: "none" });
  const implemented = new Set(implementedEngines());
  const connected = new Set((await detectConnections()).filter((c) => c.state === "connected").map((c) => c.id));
  const via = m.providers.find((p) => connected.has(p) && implemented.has(p));
  return json(via === "comfy-cloud" ? { kind: "quote", provider: "Comfy" } : { kind: "none" });
}
