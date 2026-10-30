import { z } from "zod";
import { CloudError, connectJob, readPasted, startConnect } from "@/lib/server/cloud-gpu";
import { addKeyToAccount, connectBox, lookAtRentedBoxes } from "@/lib/server/cloud-accounts";
import { updateSettings } from "@/lib/server/settings";
import { publicKey, SshError } from "@/lib/server/ssh";
import { demoOn } from "@/lib/demo/config";

/**
 * Local → Connect a cloud GPU. GET: a connect job's steps (`?job=`), or the SSH key Crackio logs in with and the boxes
 * running on your cloud accounts (new ones start connecting by themselves, unless that's turned off). POST: connect a
 * box (pasted text, or one of those boxes), put the key on an account, or turn connecting by themselves on or off.
 */
export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get("job");
  if (id) {
    const job = connectJob(id);
    return job ? Response.json(job, { headers: { "Cache-Control": "no-store" } }) : Response.json({ error: "No such job." }, { status: 404 });
  }
  const [key, boxes] = await Promise.all([
    // A live demo never says where its key file is.
    publicKey().then(({ key, file, own }) => (demoOn() ? { key, own } : { key, file, own }), (err: Error) => ({ error: err.message })),
    lookAtRentedBoxes(),
  ]);
  return Response.json({ key, ...boxes }, { headers: { "Cache-Control": "no-store" } });
}

const Provider = z.enum(["vast", "runpod"]);
const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("connect"), text: z.string().min(3).max(4000) }),
  z.object({ action: z.literal("connect-box"), provider: Provider, id: z.string().min(1).max(80) }),
  z.object({ action: z.literal("add-key"), provider: Provider }),
  z.object({ action: z.literal("auto-connect"), on: z.boolean() }),
]);

export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid request" }, { status: 400 });
  const body = parsed.data;
  try {
    if (body.action === "connect") {
      const pasted = readPasted(body.text);
      if (!pasted.url && !pasted.ssh) throw new CloudError("That doesn't look like a ComfyUI link or an SSH command.");
      return Response.json(startConnect(pasted));
    }
    if (body.action === "connect-box") return Response.json(await connectBox(body.provider, body.id, true));
    if (body.action === "auto-connect") {
      const on = body.on;
      await updateSettings((s) => ({ ...s, cloudAutoConnect: on }));
      return Response.json({ autoConnect: on });
    }
    return Response.json(await addKeyToAccount(body.provider));
  } catch (err) {
    const known = err instanceof CloudError || err instanceof SshError;
    return Response.json({ error: (err as Error).message }, { status: known ? 400 : 500 });
  }
}
