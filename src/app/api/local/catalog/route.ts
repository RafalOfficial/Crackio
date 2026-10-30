import { allLocalModels } from "@/lib/server/local-templates";
import { withMeasured5090 } from "@/lib/server/local-models";

/**
 * Every model the Local page offers: Crackio's hand-tuned ones and every open model in ComfyUI's official templates, with
 * the RTX 5090 times measured here in place of estimates (each version that ran; the first one when it isn't known).
 */
export async function GET() {
  const models = await withMeasured5090(allLocalModels());
  return Response.json({ models }, { headers: { "Cache-Control": "no-store" } });
}
