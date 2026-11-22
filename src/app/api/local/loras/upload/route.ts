/**
 * Your own LoRA files (server/lora-home). POST takes one piece of a .safetensors file being uploaded from your computer
 * (`?id=&name=&total=&offset=&model=`, the bytes as the body; pieces in order, each answered with how much is here, the
 * last with the file's record). DELETE gives an upload up. GET lists the LoRA files on their way to machines right now.
 */
export async function GET() {
  const { loraSends } = await import("@/lib/server/lora-home");
  return Response.json({ sends: loraSends() }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const q = new URL(request.url).searchParams;
  const { receivePiece, LoraRefused } = await import("@/lib/server/lora-home");
  try {
    const bytes = new Uint8Array(await request.arrayBuffer());
    const out = await receivePiece({ id: q.get("id") ?? "", name: (q.get("name") ?? "").slice(0, 300), total: Number(q.get("total")), offset: Number(q.get("offset")), model: q.get("model") ?? "" }, bytes);
    return Response.json(out);
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: err instanceof LoraRefused ? err.status : 500 });
  }
}

export async function DELETE(request: Request) {
  const { dropUpload } = await import("@/lib/server/lora-home");
  await dropUpload(new URL(request.url).searchParams.get("id") ?? "");
  return Response.json({ ok: true });
}
