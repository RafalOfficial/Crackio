/**
 * A demo sign-in is one cookie: the access code's id and an expiry, signed with CRACKIO_DEMO_SECRET (HMAC-SHA256).
 * Web Crypto only, so the request proxy and the routes check it the same way. No secret, no sign-ins: a demo started
 * without one can't spend anything.
 */
export const DEMO_COOKIE = "crk_demo";
/** How long a sign-in lasts (the demo runs about two weeks). */
export const DEMO_SESSION_DAYS = 30;

const enc = new TextEncoder();
let keyFor: { secret: string; key: Promise<CryptoKey> } | null = null;

function hmacKey(): Promise<CryptoKey> | null {
  const secret = process.env.CRACKIO_DEMO_SECRET ?? "";
  if (secret.length < 16) return null;
  if (keyFor?.secret !== secret) {
    keyFor = { secret, key: crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]) };
  }
  return keyFor.key;
}

const b64url = (bytes: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

function fromB64url(s: string): Uint8Array<ArrayBuffer> | null {
  try {
    const bin = atob(s.replaceAll("-", "+").replaceAll("_", "/"));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** The cookie value for a code id, or null when the demo has no secret. */
export async function signSession(codeId: string, now = Date.now()): Promise<string | null> {
  const key = hmacKey();
  if (!key || !/^[A-Za-z0-9_-]{1,64}$/.test(codeId)) return null;
  const body = `${codeId}.${(now + DEMO_SESSION_DAYS * 86_400_000).toString(36)}`;
  return `${body}.${b64url(await crypto.subtle.sign("HMAC", await key, enc.encode(body)))}`;
}

/** The code id a cookie value stands for, when it's genuine and current. */
export async function readSession(value: string | undefined | null, now = Date.now()): Promise<string | null> {
  const key = hmacKey();
  if (!key || !value || value.length > 200) return null;
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  const [id, exp, sig] = parts;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || !(parseInt(exp, 36) > now)) return null;
  const raw = fromB64url(sig);
  if (!raw) return null;
  const ok = await crypto.subtle.verify("HMAC", await key, raw, enc.encode(`${id}.${exp}`));
  return ok ? id : null;
}

/** The signed-in code id behind a request (its cookie), or null. */
export async function sessionOf(request: Request): Promise<string | null> {
  const cookie = request.headers.get("cookie") ?? "";
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${DEMO_COOKIE}=([^;]+)`));
  return readSession(match ? decodeURIComponent(match[1]) : null);
}
