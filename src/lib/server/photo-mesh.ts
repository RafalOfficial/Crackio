import "server-only";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { UPLOADS_DIR } from "./paths";
import { urlToPath } from "./media";
import { localModelReady, pickTarget } from "./local-models";
import { EngineError } from "@/lib/engines/types";

const WORLD_MODEL = "local:director-world";

/**
 * The place photo's 3D shape exactly as the challenge winner's 3D World builds it, for the Director's stage: MoGe-3
 * ViT-G (their settings: resolution level 9, batch 4, points on their rays, sky masked, 3 refine steps; the field of
 * view the set has for the photo) and the core MoGePointMapToMesh at their 0.04 edge threshold (their Panorama Studio's
 * `moge_grid_mesh` is that), every 4th point, as a GLB in the photo camera's frame (glTF: +X right, +Y up, looking down
 * -Z) and MoGe's meters. The shot's render (engines/comfy-local-recipes `studioWorld`) measures the same way, so what
 * the Camera frames on the stage is what their render shoots. Runs on a GPU machine the Director's set-up gave its 3D
 * World (local/catalog `director-world`: MoGe-3 there, and the moved-camera shot that measures the same way); kept by
 * photo and field of view. With no such machine it says so at once, and the stage keeps MoGe-2's relief (Stage3D
 * PhotoSet): a shot from a moved Camera then edits that view (server/director-real).
 */
export async function photoMesh(photoUrl: string, hfov: number, signal: AbortSignal) {
  const file = urlToPath(photoUrl);
  if (!file) throw new EngineError("Crackio can't find the place's photo.");
  const stat = await fs.stat(/*turbopackIgnore: true*/ file);
  const fov = Math.round(hfov * 10) / 10;
  const name = `mesh-${createHash("sha1").update(`${file}|${stat.size}|${stat.mtimeMs}|${fov}|v1`).digest("hex").slice(0, 16)}.glb`;
  const out = path.join(/*turbopackIgnore: true*/ UPLOADS_DIR, name);
  if (await fs.access(/*turbopackIgnore: true*/ out).then(() => true, () => false)) return { url: `/api/media/uploads/${name}`, hfov: fov };

  // Asked of every machine's file list (kept 20 s): pickTarget alone waits about half a minute for a machine with the
  // model before it gives up, and the stage would wait that out for every new place on a GPU without the 3D World.
  if (!(await localModelReady(WORLD_MODEL))) throw new EngineError("No GPU machine has the Director's 3D World set up.", "Set up the Director in Settings.");
  const target = await pickTarget(WORLD_MODEL.slice("local:".length));
  const headers: Record<string, string> = target.token ? { Authorization: `Bearer ${target.token}` } : {};
  const call = (route: string, init: RequestInit = {}) => fetch(`${target.url}${route}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) }, signal });

  const form = new FormData();
  const png = await sharp(file).rotate().removeAlpha().png().toBuffer();
  form.append("image", new Blob([new Uint8Array(png)], { type: "image/png" }), `crackio-mesh-${name.slice(5, 21)}.png`);
  form.append("overwrite", "true");
  const up = (await (await call("/upload/image", { method: "POST", body: form })).json()) as { name?: string };
  if (!up.name) throw new EngineError("The GPU machine didn't take the photo.");

  const graph = {
    "1": { class_type: "LoadImage", inputs: { image: up.name } },
    "2": { class_type: "LoadMoGeModel", inputs: { model_name: "moge_3_vitg_fp16.safetensors" } },
    "3": {
      class_type: "MoGeInference",
      inputs: { moge_model: ["2", 0], image: ["1", 0], resolution_level: 9, fov_x_degrees: fov, batch_size: 4, force_projection: true, apply_mask: true, refine_steps: 3 },
    },
    "4": { class_type: "MoGePointMapToMesh", inputs: { moge_geometry: ["3", 0], batch_index: 0, decimation: 4, discontinuity_threshold: 0.04, texture: false } },
    "5": { class_type: "SaveGLB", inputs: { mesh: ["4", 0], filename_prefix: "crackio/photo-mesh" } },
  };
  const queued = (await (await call("/prompt", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: graph }) })).json()) as {
    prompt_id?: string;
    error?: { message?: string };
    node_errors?: unknown;
  };
  if (!queued.prompt_id) throw new EngineError(`The GPU machine can't measure the photo in 3D: ${queued.error?.message ?? "the workflow was refused"}.`);
  const until = Date.now() + 5 * 60_000;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 1500));
    const history = (await (await call(`/history/${queued.prompt_id}`)).json()) as Record<string, { status?: { status_str?: string }; outputs?: Record<string, Record<string, { filename: string; subfolder?: string; type?: string }[]>> }>;
    const entry = history[queued.prompt_id];
    if (!entry) continue;
    if (entry.status?.status_str === "error") throw new EngineError("Measuring the photo in 3D failed on the GPU machine.");
    const saved = Object.values(entry.outputs ?? {})
      .flatMap((o) => Object.values(o).flat())
      .find((f) => typeof f?.filename === "string" && f.filename.toLowerCase().endsWith(".glb"));
    if (!saved) continue;
    const q = new URLSearchParams({ filename: saved.filename, subfolder: saved.subfolder ?? "", type: saved.type ?? "output" });
    const glb = Buffer.from(await (await call(`/view?${q}`)).arrayBuffer());
    await fs.mkdir(/*turbopackIgnore: true*/ UPLOADS_DIR, { recursive: true });
    await fs.writeFile(/*turbopackIgnore: true*/ out, glb);
    return { url: `/api/media/uploads/${name}`, hfov: fov };
  }
  throw new EngineError("Measuring the photo in 3D took too long.");
}
