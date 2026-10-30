import { z } from "zod";
import { demoFull, demoOn } from "@/lib/demo/config";
import { serverlessEndpoints } from "@/lib/server/serverless/endpoints";
import { fetchModels, serverlessInfo } from "@/lib/server/serverless/shim";
import { allLocalModels } from "@/lib/server/local-templates";

/**
 * RunPod Serverless endpoints (server/serverless). GET, from any device on the network: each one's state and what its worker
 * holds (read-only, no keys), plus whether this request comes from the computer Crackio runs on (`here`) and whether the
 * server has a RunPod key of its own (`serverKey`, RUNPOD_API_KEY). POST, from this computer only (each costs a little GPU
 * time): `list` asks the worker again; `fetch` downloads model files, named as ComfyUI graphs name them, into the endpoint's
 * network volume, from where Crackio's catalog says they come. The live demo has none of this (src/proxy.ts).
 */
/** A file outside Crackio's catalog (a LoRA a recipe uses by name), from Hugging Face only. */
const Extra = z.object({ url: z.string().regex(/^https:\/\/huggingface\.co\/[\w.-]+\/[\w.-]+\/resolve\//), folder: z.string().regex(/^[a-z_]+$/), name: z.string().regex(/^[\w.+-]+$/), bytes: z.number().int().positive().optional() });
const Body = z.object({
  endpointId: z.string().min(4).max(64),
  action: z.enum(["list", "fetch"]),
  names: z.array(z.string().min(1).max(200)).max(64).optional(),
  extra: z.array(Extra).max(16).optional(),
  dryRun: z.boolean().optional(),
});

const fromHere = (request: Request) => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(request.headers.get("host") ?? "");

export async function GET(request: Request) {
  // Seen from a laptop on the same network, Connections shows the same endpoints; only adding and removing them stays here.
  // A live demo lists only the visitor's own endpoints, never the one the server runs on.
  const endpoints = (await serverlessEndpoints()).filter((ep) => !(demoOn() && ep.fromEnv));
  const list = await Promise.all(
    endpoints.map(async (ep) => {
      const info = await serverlessInfo(ep).catch((err: Error) => ({ ok: false, manifest: null, jobs: 0, error: err.message }));
      const m = info.manifest;
      return { endpointId: ep.endpointId, label: ep.label, removable: !ep.fromEnv, ok: info.ok, jobs: info.jobs, gpu: m?.gpu?.name ?? null, comfyui: m?.comfyui ?? null, files: m?.files ?? [] };
    }),
  );
  return Response.json({ endpoints: list, here: fromHere(request), serverKey: !demoOn() && Boolean(process.env.RUNPOD_API_KEY?.trim()) }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  // The full demo's visitor may fill and list their own endpoints (their RunPod money), never the demo's.
  const own = demoFull() ? (await request.clone().json().catch(() => ({}))) as { endpointId?: string } : null;
  const visitorsOwn = own?.endpointId ? !(await serverlessEndpoints()).find((e) => e.endpointId === own.endpointId)?.fromEnv : false;
  if (!fromHere(request) && !visitorsOwn) return Response.json({ error: "Only from this computer." }, { status: 403 });
  const body = Body.parse(await request.json());
  const ep = (await serverlessEndpoints()).find((e) => e.endpointId === body.endpointId);
  if (!ep) return Response.json({ error: "No such endpoint." }, { status: 404 });
  if (body.action === "list") return Response.json(await serverlessInfo(ep, true));
  const catalog = allLocalModels().flatMap((m) => m.variants.flatMap((v) => v.files));
  const files = [...(body.names ?? []).map((name) => catalog.find((f) => f.name === name)), ...(body.extra ?? []).map((f) => ({ ...f, bytes: f.bytes ?? 0, sizeEstimated: !f.bytes }))];
  const missing = (body.names ?? []).filter((_, i) => !files[i]);
  if (missing.length) return Response.json({ error: `Not in Crackio's catalog: ${missing.join(", ")}` }, { status: 400 });
  // `dryRun`: what would be fetched, and how big it is, without starting a job.
  if (body.dryRun) return Response.json({ files: files.map((f) => ({ folder: f!.folder, name: f!.name, bytes: f!.bytes, url: f!.url })), gb: Math.round(files.reduce((n, f) => n + (f?.bytes ?? 0), 0) / 1e8) / 10 });
  const done = await fetchModels(
    ep,
    files.map((f) => ({ url: f!.url, folder: f!.folder, name: f!.name, ...(f!.sizeEstimated ? {} : { bytes: f!.bytes }) })),
  );
  return Response.json({ status: done.status, executionTime: done.executionTime, delayTime: done.delayTime, output: done.output });
}
