/**
 * Hugging Face, for the LoRA library: `?model=<id>&q=<words>&sort=downloads|likes|trendingScore` lists LoRAs made for that
 * model (adult, real-people and other people's IP filtered out); `?repo=<owner/name>` lists one repo's LoRA files.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const { searchHub, repoFiles } = await import("@/lib/server/loras");
  const { LocalError } = await import("@/lib/server/local-models");
  try {
    const repo = url.searchParams.get("repo");
    if (repo) return Response.json(await repoFiles(repo), { headers: { "Cache-Control": "no-store" } });
    const model = url.searchParams.get("model") ?? "";
    const sort = url.searchParams.get("sort");
    const entries = await searchHub(model, url.searchParams.get("q") ?? "", sort === "likes" || sort === "trendingScore" ? sort : "downloads");
    return Response.json({ entries }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: err instanceof LocalError ? err.status : 500 });
  }
}
