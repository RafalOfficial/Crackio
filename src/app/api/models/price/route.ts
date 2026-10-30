import { listModels } from "@/lib/models/resolve";
import { isCustomId } from "@/lib/models/custom";
import { comfyKey } from "@/lib/providers/comfy-models";
import type { Pricing } from "@/lib/models/pricing";

const json = (p: Pricing) => Response.json({ pricing: p }, { headers: { "Cache-Control": "no-store" } });

/** How a model is priced, for the estimate above each tool's button. */
export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (!id || id.length > 300) return Response.json({ error: "Missing model id" }, { status: 400 });
  const models = await listModels();
  const m = models.find((x) => x.id === id);
  if (!m && isCustomId(id)) {
    if (id.startsWith("comfy:")) return json((await comfyKey()) ? { kind: "quote", provider: "Comfy" } : { kind: "none" });
  }
  if (!m) return json({ kind: "none" });
  switch (m.via) {
    case "comfy-cloud":
      return json({ kind: "quote", provider: "Comfy" });
    default:
      return json({ kind: "none" });
  }
}
