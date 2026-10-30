import { listCharacters, sheetFrontView, viewsOf } from "@/lib/server/cast";
import { castSheetDrawings } from "@/lib/server/director";
import { saveUpload, urlToPath } from "@/lib/server/media";

/**
 * Director's cast from Cast. GET: every ready Cast member (who can be put on set). POST `{ id }`: the front view of
 * their reference sheet as a picture for the stage (cut out by the page), and what the shot needs to know of them.
 */
type Known = Awaited<ReturnType<typeof listCharacters>>[number] & { noun?: string; traits?: string; height?: number };

export async function GET() {
  // What Cast has read of each (noun, traits, height) when it has.
  const items = (await listCharacters()).filter((c) => c.status === "ready" && (c.sheet || c.portrait)) as Known[];
  return Response.json({
    items: items.map((c) => ({ id: c.id, name: c.name, handle: c.handle, kind: c.kind, portrait: c.portrait, sheet: c.sheet, noun: c.noun, traits: c.traits, height: c.height })),
  });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { id?: string; viewsOnly?: boolean } | null;
  const c = body?.id ? ((await listCharacters()) as Known[]).find((x) => x.id === body.id) : null;
  if (!c) return Response.json({ error: "No such Cast member." }, { status: 404 });
  const sheet = c.sheet ? urlToPath(c.sheet) : null;
  const portrait = c.portrait ? urlToPath(c.portrait) : null;
  if (!sheet && !portrait) return Response.json({ error: "This Cast member isn't ready yet." }, { status: 409 });
  try {
    // Its sheet's views, cut out, so the camera view shows the side it sees.
    const views = c.sheet ? await castSheetDrawings(c.sheet, viewsOf(c)).catch(() => []) : [];
    if (body?.viewsOnly) return Response.json({ views });
    // The sheet's front view stands on set (whole, head to feet); without a sheet, the portrait.
    const front = sheet ? await sheetFrontView(sheet) : null;
    const stage = front ? await saveUpload(front) : { url: c.portrait!, width: 0, height: 0 };
    return Response.json({
      stage: stage.url,
      cast: { id: c.id, handle: c.handle, sheet: c.sheet, portrait: c.portrait },
      name: c.name,
      kind: c.kind,
      noun: c.noun,
      traits: c.traits,
      height: c.height,
      views,
    });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}
