import { connection } from "next/server";
import { db } from "@/lib/server/db";
import { libraryGenerations, listPlacements, listProjects } from "@/lib/server/library";
import { mediaFiles } from "@/lib/server/media";
import { warmPreviews } from "@/lib/server/previews";
import { demoOwner, maysee } from "@/lib/demo/owner";

/** Light copies are got ready ahead for about the first two pages of cards; the rest as you scroll. */
const WARM_AHEAD = 80;

/**
 * The whole listing is a few MB of JSON (2,000 takes ≈ 3 MB) that every page fetches once, so it is
 * built once per change of the database and kept. Kept across hot reloads, like the database connection.
 *
 * It goes out as plain JSON and Next compresses it on the way. It used to carry its own gzipped copy (the dev
 * server didn't compress then), until Next 16.4.6 began compressing in dev too and compressed that copy a second
 * time: the page got gzip where it expected JSON, the listing failed without a word, and the Library showed only
 * the sixty newest takes and no projects. Don't set Content-Encoding here again.
 */
type Built = { tag: string; json: string };
const kept = globalThis as unknown as { __crackioLibraryList?: { boot: string; built?: Built; building?: { tag: string; done: Promise<Built> } } };
const memo = (kept.__crackioLibraryList ??= { boot: Date.now().toString(36) });

/**
 * Changes with every write to the database: total_changes() counts this server's own (one
 * connection per process), data_version moves when anything else writes to the file.
 */
function tagNow() {
  const d = db();
  const { n } = d.prepare("SELECT total_changes() AS n").get() as { n: number };
  const { data_version: v } = d.prepare("PRAGMA data_version").get() as { data_version: number };
  return `W/"lib-${memo.boot}-${n}-${v}"`;
}

const warm = (items: { outputs: { url: string }[] }[]) => warmPreviews(mediaFiles(items.flatMap((gen) => gen.outputs.map((o) => o.url)).slice(0, WARM_AHEAD)));

async function build(tag: string): Promise<Built> {
  const items = await libraryGenerations();
  warm(items);
  return { tag, json: JSON.stringify({ projects: listProjects(), placements: listPlacements(), items }) };
}

/** The listing for the database as it is now; one build at a time however many ask at once. */
function current(): Promise<Built> {
  const tag = tagNow();
  if (memo.built?.tag === tag) return Promise.resolve(memo.built);
  if (memo.building?.tag !== tag) {
    const done = build(tag);
    memo.building = { tag, done };
    done.then(
      (built) => {
        if (memo.building?.done !== done) return;
        memo.built = built;
        memo.building = undefined;
      },
      () => {
        if (memo.building?.done === done) memo.building = undefined;
      },
    );
  }
  return memo.building.done;
}

/** Everything the Library shows: your projects, which takes are filed where, and every generation. */
export async function GET(request: Request) {
  // The database answers synchronously, so without this the response would be baked in at build time.
  await connection();
  try {
    // The live demo shows only the signed-in code's own takes, without projects (lib/demo); never kept.
    const viewer = await demoOwner(request);
    if (viewer !== undefined) {
      const items = (await libraryGenerations()).filter((gen) => maysee(viewer, gen.owner));
      warm(items);
      return Response.json({ projects: [], placements: [], items }, { headers: { "Cache-Control": "no-store" } });
    }
    const built = await current();
    const headers: Record<string, string> = { "Content-Type": "application/json", ETag: built.tag, "Cache-Control": "no-cache" };
    if ((request.headers.get("if-none-match") ?? "").split(/\s*,\s*/).includes(built.tag)) return new Response(null, { status: 304, headers });
    return new Response(built.json, { headers });
  } catch (err) {
    console.warn(`[library] listing failed: ${(err as Error).message}`);
    return Response.json({ error: "Couldn't read the Library. Try again." }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
