import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { recipeFor } from "@/lib/engines/comfy-local-recipes";
import { allLocalModels } from "@/lib/server/local-templates";
import type { EngineJob } from "@/lib/engines/types";

/**
 * The exact ComfyUI workflow (API format) Crackio runs for a Local model, built for a sample job: the inputs it
 * would upload are named, not sent. Open it in ComfyUI (Workflow › Open) to run or change it there.
 */
export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get("model") ?? "";
  const model = allLocalModels().find((m) => m.id === id);
  const recipe = model?.crackio ? recipeFor(model.crackio.replace(/^local:/, "")) : null;
  if (!model || !recipe) return Response.json({ error: "Unknown model." }, { status: 404 });
  const video = recipe.output === "video";
  // Upscalers size their graph from the picture, editors and image-to-video models need one: a stand-in 1 MP one.
  const sample = path.join(os.tmpdir(), "crackio-workflow-sample.png");
  await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#808080" } }).png().toFile(sample);
  const job: EngineJob = {
    kind: model.tasks.includes("upscale") ? "upscale" : video ? "video" : "image",
    model: recipe.id,
    family: "comfy-local",
    mode: video ? "video" : "image",
    prompt: "Describe the shot here.",
    userPrompt: "Describe the shot here.",
    refine: false,
    aspect: "16:9",
    width: 1344,
    height: 768,
    count: 1,
    references: model.tasks.includes("upscale") ? [{ path: sample, label: "the picture" }] : [],
    options: { duration: 5, scale: 2 },
  };
  const named: string[] = [];
  const tools = {
    upload: async (_file: string, tag?: string) => ({ name: `crackio/${tag ?? "input"}.mp4` }),
    uploadData: async (_data: Buffer, name: string) => {
      named.push(name);
      return { name: `crackio/${name}` };
    },
    signal: new AbortController().signal,
  };
  try {
    // Text first; a model that only works from a picture gets the stand-in.
    const graph = await recipe.build(job, tools).catch(() =>
      recipe.build({ ...job, references: [{ path: sample, label: "the picture" }], ...(video ? { start: { path: sample, label: "the first frame" } } : {}) }, tools),
    );
    return new Response(JSON.stringify(graph, null, 2), {
      headers: { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="crackio-${model.id}.api.json"`, "Cache-Control": "no-store" },
    });
  } catch (err) {
    // Swaps and upscales need real inputs to lay out their graph (a clip's length, a picture's size).
    return Response.json({ error: `${model.name}'s workflow is built from your inputs: ${(err as Error).message}` }, { status: 422 });
  }
}
