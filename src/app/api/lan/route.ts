import { lanAllowed, lanHttps, lanHttpsPort, lanWanted, startLanHttps } from "@/lib/server/lan-https";

/** Crackio's secure address for other devices on the network (lib/server/lan-https): whether it may, was asked to, and is up. */
export async function GET() {
  const now = lanHttps();
  return Response.json({ allowed: lanAllowed(), wanted: await lanWanted(), port: now?.port ?? lanHttpsPort(), running: Boolean(now?.running), error: now?.error ?? null });
}

/** Turn it on (and keep it on from now on): Clone asks for it when a Mac or phone can't record over plain http. */
export async function POST() {
  if (!lanAllowed()) return Response.json({ error: "The secure address is turned off on this Crackio." }, { status: 403 });
  const now = await startLanHttps({ turnOn: true });
  if (!now?.running) return Response.json({ error: now?.error ?? "Couldn't open the secure address.", port: now?.port ?? lanHttpsPort() }, { status: 500 });
  return Response.json({ allowed: true, wanted: true, port: now.port, running: true, error: null });
}
