import { z } from "zod";
import { demoFull } from "@/lib/demo/config";
import { getSettings, updateSettings } from "@/lib/server/settings";
import { forgetVerdicts } from "@/lib/providers/verify";

const KeyName = z.enum(["comfy", "hf", "vast", "runpod"]);

/** Never send stored keys back to the browser: report only whether each one is set. */
async function publicSettings() {
  const s = await getSettings();
  return {
    keys: Object.fromEntries(
      (["comfy", "hf", "vast", "runpod"] as const).map((k) => [k, { saved: Boolean(s.keys[k]), last4: s.keys[k]?.slice(-4) ?? null }]),
    ),
    defaultEngine: s.defaultEngine,
    textEffort: s.textEffort ?? "xhigh",
    localVision: s.localVision ?? "4b",
  };
}

export async function GET() {
  return Response.json(await publicSettings(), { headers: { "Cache-Control": "no-store" } });
}

const Patch = z.object({
  key: z.object({ name: KeyName, value: z.string().max(400).nullable() }).optional(),
  defaultEngine: z.string().max(40).optional(),
  textEffort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  localVision: z.enum(["4b", "8b"]).optional(),
});

export async function PATCH(request: Request) {
  const parsed = Patch.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid settings" }, { status: 400 });
  const { key, defaultEngine, textEffort, localVision } = parsed.data;
  // The full demo takes only the keys for the visitor's own Comfy account and GPU clouds.
  if (key && demoFull() && !["comfy", "runpod", "vast"].includes(key.name)) return Response.json({ error: "That key isn't part of the live demo." }, { status: 403 });
  await updateSettings((s) => {
    const next = { ...s, keys: { ...s.keys } };
    if (key) {
      const value = key.value?.trim();
      if (value) next.keys[key.name] = value;
      else delete next.keys[key.name];
    }
    if (defaultEngine) next.defaultEngine = defaultEngine;
    if (textEffort) next.textEffort = textEffort;
    if (localVision) next.localVision = localVision;
    return next;
  });
  forgetVerdicts();
  return Response.json(await publicSettings());
}
