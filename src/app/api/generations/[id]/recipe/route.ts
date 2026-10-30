import { readRecipe, withMachineIds } from "@/lib/server/recipes";
import { workflowFileName } from "@/lib/recipes/recipe";
import { getGeneration } from "@/lib/server/db";
import { demoOwner, maysee } from "@/lib/demo/owner";

/**
 * A Library item's recipe (server/recipes): `{ recipe }`, 404 for one made before recipes were kept. `?step=N&download=1`
 * sends that step's ComfyUI graph in API format (a Router step's request) as a file; `?download=all`, the whole recipe.
 */
export async function GET(request: Request, ctx: RouteContext<"/api/generations/[id]/recipe">) {
  const { id } = await ctx.params;
  // In the live demo, only the code that made the take reads its recipe (lib/demo).
  const viewer = await demoOwner(request);
  if (viewer !== undefined && !maysee(viewer, getGeneration(id)?.owner)) return Response.json({ error: "No recipe kept for this take." }, { status: 404 });
  const recipe = await readRecipe(id);
  if (!recipe) return Response.json({ error: "No recipe kept for this take." }, { status: 404 });
  const q = new URL(request.url).searchParams;
  const download = q.get("download");
  if (!download) return Response.json({ recipe: await withMachineIds(recipe) }, { headers: { "Cache-Control": "no-store" } });
  if (download === "all") return file(`crackio-recipe-${recipe.id}.json`, recipe);
  const index = q.has("step") ? Number(q.get("step")) : recipe.main;
  const step = recipe.steps[index];
  if (!step) return Response.json({ error: "No such step." }, { status: 404 });
  const name = workflowFileName(recipe, step, index, recipe.steps.length);
  if (step.kind === "outside") return Response.json({ error: "That step ran outside ComfyUI: there's no graph to download." }, { status: 404 });
  return file(name, step.kind === "router" ? { endpoint: step.endpoint, request: step.request } : step.graph);
}

const file = (name: string, body: unknown) =>
  new Response(JSON.stringify(body, null, 2), {
    headers: { "Content-Type": "application/json; charset=utf-8", "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "no-store" },
  });
