import { connection } from "next/server";
import { z } from "zod";
import { demoOn } from "@/lib/demo/config";
import { capKeyFor, cleanComfy, cleanParts, clearCache, planInstall, removeFiles, setCap, setDownloadRoot, StorageError, storageReport } from "@/lib/server/storage";
import { REBUILDABLE_CACHE, type StorageReport } from "@/lib/storage/types";
import { recentTakes } from "@/lib/server/setup/takes";
import { allLocalModels } from "@/lib/server/local-templates";

/**
 * Settings → Storage. GET `?machine=<target id>` (default: this computer's ComfyUI; `fresh=1` measures again): one
 * machine's StorageReport (lib/storage/types); with `need=<bytes>`, an InstallPlan instead (would that much more fit
 * there). POST a StorageAction: set-root (where downloads go there), set-cap
 * (Crackio's limit on it, in GB), clear-cache (this computer's rebuildable cache), clean-parts (unfinished downloads),
 * clean-comfy (Crackio's copies in that ComfyUI's input and output), remove-files (model files off it). Not in the live
 * demo.
 */

/**
 * When each model on the machine was last used there: the newest take whose recipe ran on it (by the machine's name, as
 * recipes keep it) and either is that model's or has a step by its name (FLUX 3 Klein inside a swap). Smart cleanup
 * offers what hasn't been used for two weeks.
 */
async function withLastUse(report: StorageReport): Promise<StorageReport> {
  const takes = await recentTakes().catch(() => []);
  const here = takes.filter((t) => t.label === report.machine.label || (report.machine.onThisComputer && /this computer/i.test(t.label ?? "")));
  const catalog = allLocalModels();
  const models = report.models.map((m) => {
    const [kind, ...rest] = m.id.split(":");
    const ref = rest.join(":");
    const local = kind === "catalog" ? catalog.find((c) => c.id === ref) : undefined;
    // A voice model by its id without the version ("local:voice:voxcpm2:q8"); Voice's engine and speech to text by any voice take.
    const crackio =
      kind === "catalog"
        ? (local?.crackio ?? `local:${ref}`)
        : kind === "voice"
          ? ref.startsWith("local:voice:")
            ? ref.split(":").slice(0, 3).join(":")
            : "local:voice:*"
          : kind === "engine"
            ? "local:voice:*"
            : kind === "lipsync"
              ? "local:lipsync:latentsync"
              : null;
    if (!crackio) return m;
    const name = local?.name ?? m.name;
    const its = (model: string) => (crackio.endsWith("*") ? model.startsWith(crackio.slice(0, -1)) : model === crackio);
    let last: number | null = null;
    for (const t of here) if ((its(t.model) || t.steps.some((s) => s === name || s.startsWith(`${name} `))) && (last === null || t.at > last)) last = t.at;
    return { ...m, lastUsed: last };
  });
  return { ...report, models, usedSince: takes.length ? Math.min(...takes.map((t) => t.at)) : null, now: Date.now() };
}

const fail = (err: unknown) =>
  err instanceof StorageError ? Response.json({ error: err.message }, { status: err.status }) : Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });

export async function GET(request: Request) {
  await connection();
  if (demoOn()) return Response.json({ error: "Not found." }, { status: 404 });
  const url = new URL(request.url);
  try {
    // `need=<bytes>` (`folder=<model folder>`, else where a diffusion model goes): whether that much more fits there (an
    // InstallPlan), as installs check before they start.
    const need = url.searchParams.get("need");
    if (need !== null) {
      const bytes = Number(need);
      const folder = url.searchParams.get("folder");
      if (!Number.isFinite(bytes) || bytes < 0) return Response.json({ error: "need is a number of bytes." }, { status: 400 });
      const plan = await planInstall(url.searchParams.get("machine") ?? "", folder ? [{ folder, bytes }] : bytes);
      return Response.json(plan, { headers: { "Cache-Control": "no-store" } });
    }
    const report = await storageReport(url.searchParams.get("machine"), { fresh: url.searchParams.get("fresh") === "1" });
    return Response.json(await withLastUse(report), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return fail(err);
  }
}

const machine = z.string().min(1).max(80);
const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("set-root"), machine, path: z.string().trim().min(1).max(400).nullable() }),
  z.object({ action: z.literal("set-cap"), machine, gb: z.number().min(1).max(1_000_000).nullable() }),
  z.object({ action: z.literal("clear-cache"), kind: z.enum(["all", ...REBUILDABLE_CACHE]) }),
  z.object({ action: z.literal("clean-parts"), machine }),
  z.object({ action: z.literal("clean-comfy"), machine, olderThanHours: z.number().min(1).max(87_600).optional() }),
  z.object({
    action: z.literal("remove-files"),
    machine,
    files: z.array(z.object({ folder: z.string().min(1).max(60), file: z.string().min(1).max(200) })).min(1).max(20),
  }),
]);

export async function POST(request: Request) {
  if (demoOn()) return Response.json({ error: "Not found." }, { status: 404 });
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Invalid request" }, { status: 400 });
  const body = parsed.data;
  try {
    switch (body.action) {
      case "set-root":
        return Response.json(await setDownloadRoot(body.machine, body.path));
      case "set-cap": {
        // Kept under the machine's own id when its bridge has one, and never under two keys at once.
        const key = await capKeyFor(body.machine);
        return Response.json(await setCap(key, body.gb, { replaces: [body.machine] }));
      }
      case "clear-cache":
        return Response.json(await clearCache(body.kind));
      case "clean-parts":
        return Response.json(await cleanParts(body.machine));
      case "clean-comfy":
        return Response.json(await cleanComfy(body.machine, body.olderThanHours));
      case "remove-files":
        return Response.json(await removeFiles(body.machine, body.files));
    }
  } catch (err) {
    return fail(err);
  }
}
