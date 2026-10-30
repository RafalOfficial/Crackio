import { getGeneration } from "@/lib/server/db";
import { urlToPath } from "@/lib/server/media";
import { writeScript } from "@/lib/server/product-film";
import { FILM_CAMERAS, FILM_HOOKS, FILM_MOODS, FILM_STORIES, LANGUAGES, type FilmSpec } from "@/lib/product/film";
import type { ProductRead } from "@/lib/product/vocab";

const pick = <T extends { id: string }>(list: readonly T[], v: unknown) => (list.find((o) => o.id === v) ?? list[0]).id;

/**
 * `{ picture, from?, productUrl?, camera, hook, mood, story, language, seconds, notes }`: a first draft of
 * what the creator says in a Video take, fitted to the picture, the product and the picks, to edit before filming.
 */
export async function POST(request: Request) {
  const b = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!b) return Response.json({ error: "Send the picks." }, { status: 400 });
  const take = typeof b.from === "string" ? getGeneration(b.from) : null;
  const productUrl = typeof b.productUrl === "string" ? b.productUrl : take?.references.find((r) => r.role === "product")?.url;
  const spec: Pick<FilmSpec, "style" | "camera" | "hook" | "mood" | "story" | "language" | "seconds"> = {
    style: "creator",
    camera: pick(FILM_CAMERAS, b.camera) as FilmSpec["camera"],
    hook: pick(FILM_HOOKS, b.hook) as FilmSpec["hook"],
    mood: pick(FILM_MOODS, b.mood) as FilmSpec["mood"],
    story: pick(FILM_STORIES, b.story) as FilmSpec["story"],
    language: pick(LANGUAGES, b.language) as FilmSpec["language"],
    seconds: Math.min(60, Math.max(3, Number(b.seconds) || 10)),
  };
  const script = await writeScript({
    spec,
    picture: typeof b.picture === "string" ? urlToPath(b.picture) : null,
    product: productUrl ? urlToPath(productUrl) : null,
    read: ((take?.params?.studio as { read?: ProductRead | null } | undefined)?.read ?? null) as ProductRead | null,
    notes: typeof b.notes === "string" ? b.notes.slice(0, 1000) : "",
  });
  if (!script) return Response.json({ error: "No text model answered. Add a Comfy key in Connections, or sign in to ChatGPT or Grok, or write the lines yourself." }, { status: 503 });
  return Response.json({ script }, { headers: { "Cache-Control": "no-store" } });
}
