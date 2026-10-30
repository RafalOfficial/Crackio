import fs from "node:fs/promises";
import { deleteGeneration, getGeneration } from "@/lib/server/db";
import { forgetGeneration } from "@/lib/server/library";
import { urlToPath } from "@/lib/server/media";
import { forgetPreviews } from "@/lib/server/previews";
import { dropRecipe } from "@/lib/server/recipes";
import { runner } from "@/lib/server/runner";
import { demoOwner, maysee } from "@/lib/demo/owner";

export async function GET(req: Request, ctx: RouteContext<"/api/generations/[id]">) {
  const { id } = await ctx.params;
  const item = getGeneration(id);
  if (!item || !maysee(await demoOwner(req), item.owner)) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ item });
}

export async function DELETE(req: Request, ctx: RouteContext<"/api/generations/[id]">) {
  const { id } = await ctx.params;
  const item = getGeneration(id);
  if (!item || !maysee(await demoOwner(req), item.owner)) return Response.json({ error: "Not found" }, { status: 404 });
  runner().cancel(id);
  await Promise.all(
    item.outputs.map(async (o) => {
      const p = urlToPath(o.url);
      if (p) await Promise.all([fs.rm(p, { force: true }), forgetPreviews(p)]);
    }),
  );
  deleteGeneration(id);
  forgetGeneration(id);
  await dropRecipe(id);
  return Response.json({ ok: true });
}
