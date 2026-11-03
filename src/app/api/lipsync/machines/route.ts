import { lipsyncMachines } from "@/lib/server/lipsync/machines";

/** Where Lip Sync can run, and how far each machine is set up for it. */
export async function GET(request: Request) {
  const fresh = new URL(request.url).searchParams.get("fresh") === "1";
  return Response.json({ machines: await lipsyncMachines(fresh) });
}
