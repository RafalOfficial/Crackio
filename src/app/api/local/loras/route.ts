import { comfyTargets, withTarget } from "@/lib/server/comfy-targets";

/**
 * The LoRA files your ComfyUIs can load (each one's models/loras, as its LoraLoaderModelOnly lists them): `{ files:
 * [{ file, machines }] }`. A machine that doesn't answer adds none.
 */
export async function GET() {
  try {
    // Loaded here, as the other routes load engines, and through the registry first: comfy-local loaded on its own
    // reaches the registry through models/resolve before it has finished ("Cannot access 'comfyLocalEngine'").
    await import("@/lib/engines/registry");
    const { loraFiles } = await import("@/lib/engines/comfy-local");
    const targets = await comfyTargets();
    const lists = await Promise.all(
      targets.map(async (t) => {
        try {
          return { machine: t.label, files: await withTarget(t, () => loraFiles()) };
        } catch {
          return { machine: t.label, files: new Set<string>() };
        }
      }),
    );
    const byFile = new Map<string, string[]>();
    for (const { machine, files } of lists) for (const f of files) byFile.set(f, [...(byFile.get(f) ?? []), machine]);
    const files = [...byFile.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([file, machines]) => ({ file, machines }));
    return Response.json({ files }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return Response.json({ files: [], error: (err as Error).message }, { status: 500 });
  }
}
