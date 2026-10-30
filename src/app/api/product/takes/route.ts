import { listDoneByTool } from "@/lib/server/db";
import type { StudioPicture } from "@/lib/product/film";
import type { ShotPlan, StudioSpec } from "@/lib/product/vocab";
import { sampleFor } from "@/lib/product/previews";

const WHO: Record<string, StudioPicture["people"]> = { still: "none", ingredients: "none", motion: "none", hand: "hands", use: "person", together: "person", creator: "person" };

/**
 * `?limit=10`: the newest pictures made in Product Studio's Image mode, one per output, so Video mode
 * can offer them as first frames (with the product photo and reading they were made from).
 */
export async function GET(request: Request) {
  const limit = Math.min(Math.max(Number(new URL(request.url).searchParams.get("limit") ?? 10), 1), 40);
  const pictures: StudioPicture[] = [];
  for (const g of listDoneByTool("product", 60)) {
    if (g.params?.kind !== "image") continue;
    const studio = g.params?.studio as StudioSpec | undefined;
    const shots = Array.isArray(g.params?.shots) ? (g.params.shots as ShotPlan[]) : [];
    const product = g.references.find((r) => r.role === "product") ?? g.references[0];
    g.outputs.forEach((o, i) => {
      if (o.kind !== "image" || pictures.length >= limit) return;
      pictures.push({
        url: o.url,
        width: o.width ?? 1024,
        height: o.height ?? 1280,
        from: g.id,
        idea: shots[i]?.idea || g.prompt.slice(0, 80),
        people: studio ? (WHO[studio.moment] ?? null) : null,
        productUrl: product?.url,
        like: sampleFor(studio?.read?.category),
        createdAt: g.createdAt,
      });
    });
    if (pictures.length >= limit) break;
  }
  return Response.json({ pictures }, { headers: { "Cache-Control": "no-store" } });
}
