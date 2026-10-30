import { z } from "zod";
import { demoOn } from "@/lib/demo/config";
import { codeById, findCode } from "@/lib/demo/codes";
import { DEMO_COOKIE, DEMO_SESSION_DAYS, sessionOf, signSession } from "@/lib/demo/session";
import { clientIp } from "@/lib/demo/ip";
import { listGenerations } from "@/lib/server/db";

/**
 * Signing in to the live demo with an access code. GET says who's signed in and their credits; POST takes a code;
 * DELETE signs out. Outside a demo this route doesn't exist.
 */

const notFound = () => Response.json({ error: "Not found" }, { status: 404 });

export async function GET(request: Request) {
  if (!demoOn()) return notFound();
  const id = await sessionOf(request);
  const code = id ? await codeById(id) : null;
  return Response.json(
    {
      demo: true,
      signedIn: Boolean(code),
      credits: code?.left ?? 0,
      label: code?.label ?? null,
      running: id ? listGenerations({ limit: 20, owner: id }).some((g) => g.status === "queued" || g.status === "running") : false,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/** Ten tries an hour per address keeps codes from being guessed. */
const TRIES = 10;
const tries = (globalThis as unknown as { __crackioDemoTries?: Map<string, number[]> }).__crackioDemoTries ?? new Map<string, number[]>();
(globalThis as unknown as { __crackioDemoTries?: Map<string, number[]> }).__crackioDemoTries = tries;

const Body = z.object({ code: z.string().min(4).max(64) });

export async function POST(request: Request) {
  if (!demoOn()) return notFound();
  const ip = clientIp(request);
  const now = Date.now();
  const recent = (tries.get(ip) ?? []).filter((t) => now - t < 3_600_000);
  if (recent.length >= TRIES) {
    return Response.json({ error: "Too many tries. Wait an hour and try again." }, { status: 429 });
  }
  recent.push(now);
  tries.set(ip, recent);

  const parsed = Body.safeParse(await request.json().catch(() => null));
  const code = parsed.success ? await findCode(parsed.data.code) : null;
  if (!code) return Response.json({ error: "That code doesn't work. Check it and try again." }, { status: 401 });
  const value = await signSession(code.id);
  if (!value) return Response.json({ error: "Sign-in is switched off on this demo." }, { status: 503 });

  // A good code clears the address's tries.
  tries.delete(ip);
  const secure = new URL(request.url).protocol === "https:" || request.headers.get("x-forwarded-proto") === "https" || Boolean(request.headers.get("cf-ray"));
  const cookie = [
    `${DEMO_COOKIE}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${DEMO_SESSION_DAYS * 86_400}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
  const left = Math.max(0, code.credits - code.spent);
  return Response.json({ demo: true, signedIn: true, credits: left, label: code.label }, { headers: { "Set-Cookie": cookie } });
}

export async function DELETE() {
  if (!demoOn()) return notFound();
  return Response.json({ ok: true }, { headers: { "Set-Cookie": `${DEMO_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` } });
}
