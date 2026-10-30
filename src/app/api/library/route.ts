import { connection } from "next/server";
import { libraryGenerations, listPlacements, listProjects } from "@/lib/server/library";
import { mediaFiles } from "@/lib/server/media";
import { warmPreviews } from "@/lib/server/previews";
import { demoOwner, maysee } from "@/lib/demo/owner";

/** Light copies are got ready ahead for about the first two pages of cards; the rest as you scroll. */
const WARM_AHEAD = 80;

/** Everything the Library shows: your projects, which takes are filed where, and every generation. */
export async function GET(request: Request) {
  // The database answers synchronously, so without this the response would be baked in at build time.
  await connection();
  // The live demo shows only the signed-in code's own takes, without projects (lib/demo).
  const viewer = await demoOwner(request);
  const items = (await libraryGenerations()).filter((g) => maysee(viewer, g.owner));
  warmPreviews(mediaFiles(items.flatMap((g) => g.outputs.map((o) => o.url)).slice(0, WARM_AHEAD)));
  const filed = viewer === undefined ? { projects: listProjects(), placements: listPlacements() } : { projects: [], placements: [] };
  return Response.json({ ...filed, items }, { headers: { "Cache-Control": "no-store" } });
}
