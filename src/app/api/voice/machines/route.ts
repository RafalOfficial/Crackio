import { voiceMachines } from "@/lib/server/voice/machines";

/** Every machine Voice can run on, with its GPU, audio.cpp and voice models (server/voice/machines). */
export async function GET(request: Request) {
  const fresh = new URL(request.url).searchParams.get("fresh") === "1";
  return Response.json({ machines: await voiceMachines(fresh) });
}
