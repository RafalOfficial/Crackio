import { connection } from "next/server";
import { urlToPath } from "@/lib/server/media";
import { cutout, estimateDepth, subjectMask, visionStatus } from "@/lib/server/vision";
import { readSubject } from "@/lib/server/director";
import { demoMediaDenied, demoOwnCopy } from "@/lib/demo/media";
import { demoOwner } from "@/lib/demo/owner";

/** Where the 3D tools are: downloading, loading or ready. Director polls this while it waits. */
export async function GET() {
  await connection();
  return Response.json({ models: visionStatus() }, { headers: { "Cache-Control": "no-store" } });
}

/**
 * `{ task: "depth" | "cutout" | "mask" | "read", url }` for an image Crackio stores (an upload, a result or a bundled
 * asset). "read" asks a vision model what a cast picture shows (null without one).
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { task?: string; url?: string } | null;
  const file = typeof body?.url === "string" ? urlToPath(body.url) : null;
  if (!file) return Response.json({ error: "Send the URL of an image Crackio stores." }, { status: 400 });
  // The live demo works only on files the visitor may see (lib/demo).
  const media = decodeURIComponent(body!.url!.split("?")[0]).match(/^\/api\/media\/(.+)$/)?.[1];
  if (media && (await demoMediaDenied(request, media.split("/")))) return Response.json({ error: "Send the URL of an image Crackio stores." }, { status: 404 });
  try {
    if (body!.task === "depth") return Response.json(await estimateDepth(file));
    if (body!.task === "cutout") {
      const cut = await cutout(file, body!.url!);
      // On the live demo, the code that asked gets a copy of its own (a cut-out's name is shared by its photo).
      const viewer = await demoOwner(request);
      return Response.json(viewer ? { ...cut, url: await demoOwnCopy(viewer, cut.url) } : cut);
    }
    if (body!.task === "mask") return Response.json(await subjectMask(file));
    if (body!.task === "read") return Response.json({ read: await readSubject(file) });
    return Response.json({ error: "Unknown task." }, { status: 400 });
  } catch (err) {
    return Response.json({ error: (err as Error).message || "The 3D tools failed." }, { status: 500 });
  }
}
