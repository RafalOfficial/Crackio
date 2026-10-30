import { z } from "zod";
import { listModels } from "@/lib/models/resolve";
import { customModel, isCustomId } from "@/lib/models/custom";
import { MODEL_KINDS, type ModelKind } from "@/lib/models/catalog";
import { getSettings, updateSettings } from "@/lib/server/settings";

export async function GET() {
  const [models, settings] = await Promise.all([listModels(), getSettings()]);
  return Response.json({ models, defaults: settings.models }, { headers: { "Cache-Control": "no-store" } });
}

const Patch = z.object({
  kind: z.enum(MODEL_KINDS as [ModelKind, ...ModelKind[]]),
  /** Catalog id, or "auto" to clear the default. */
  model: z.string().max(300),
});

export async function PATCH(request: Request) {
  const parsed = Patch.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid request" }, { status: 400 });
  const { kind, model } = parsed.data;
  // Plans list their own models, so check against the live list, not just the built-in catalog.
  // Custom-tab models are checked against their provider's catalog instead.
  const custom = model !== "auto" && isCustomId(model) ? await customModel(kind, model).catch(() => null) : null;
  if (model !== "auto" && !custom?.available && !(await listModels()).some((m) => m.id === model && m.kind === kind)) {
    return Response.json({ error: custom?.reason ?? "Unknown model for this kind" }, { status: 400 });
  }
  const next = await updateSettings((s) => {
    const models = { ...s.models };
    if (model === "auto") delete models[kind];
    else models[kind] = model;
    return { ...s, models };
  });
  return Response.json({ defaults: next.models });
}
