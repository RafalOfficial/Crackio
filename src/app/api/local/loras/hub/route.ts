/**
 * Hugging Face, for the LoRA library:
 * - `?model=<id>&q=<words>&sort=downloads|likes|new`: every LoRA made for that model that the library shows, most popular
 *   first (adult, real-people and other people's IP filtered out), and the picks' numbers as they are today;
 * - `?repo=<owner/name>&model=<id>`: one repo's LoRA files, the one (or the pair) Crackio would get for that model, and
 *   what its card says it does.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const { browseHub, loraAccess, repoFiles, repoAbout, searchEverywhere, wordsFor } = await import("@/lib/server/loras");
  const { LocalError } = await import("@/lib/server/local-models");
  try {
    const repo = url.searchParams.get("repo");
    const model = url.searchParams.get("model") ?? "";
    if (repo) {
      const [files, about] = await Promise.all([repoFiles(repo), repoAbout(repo).catch(() => ({ about: null, trigger: undefined }))]);
      const { pickFiles } = await import("@/lib/local/loras");
      const pick = model ? pickFiles({ id: model }, files.files, repo).map((f) => f.path) : [];
      // The trigger words written by hand for it (none, when "") come before its card's.
      const mine = wordsFor(repo);
      const trigger = mine && "trigger" in mine ? mine.trigger || undefined : (files.trigger ?? about.trigger);
      return Response.json({ ...files, trigger, about: about.about, pick }, { headers: { "Cache-Control": "no-store" } });
    }
    // `access=<repo>` (with `rev` and `path` for a pick): whether your Hugging Face account may download a LoRA whose
    // makers ask you to accept their terms first.
    const access = url.searchParams.get("access");
    if (access) {
      return Response.json({ access: await loraAccess(access, url.searchParams.get("rev") ?? undefined, url.searchParams.get("path") ?? undefined) }, { headers: { "Cache-Control": "no-store" } });
    }
    // `everywhere=1`: the listed LoRAs of every model that match the words (`except`: but one model's).
    if (url.searchParams.get("everywhere") === "1") {
      return Response.json({ entries: searchEverywhere(url.searchParams.get("q") ?? "", url.searchParams.get("except") ?? undefined) }, { headers: { "Cache-Control": "no-store" } });
    }
    const sort = url.searchParams.get("sort");
    // `all=1`: also the ones nobody here looked at, with their makers' own examples (the page's "Show everything").
    // `review=1`: everything that passes the filters, without those examples (the gallery's review script reads it).
    const scope = url.searchParams.get("review") === "1" ? "review" : url.searchParams.get("all") === "1" ? "all" : "checked";
    const out = await browseHub(model, url.searchParams.get("q") ?? "", sort === "likes" || sort === "new" ? sort : "downloads", scope);
    return Response.json(out, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: err instanceof LocalError ? err.status : 500 });
  }
}
