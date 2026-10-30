import "server-only";
import { createHash, createHmac } from "node:crypto";

/**
 * Cloudflare R2 (S3 API, no egress fees) for the files a serverless job needs and makes: Crackio puts a job's inputs there
 * and signs short-lived links, the worker downloads them and uploads its results to links Crackio signed for it, and
 * Crackio fetches them back. The worker never holds a key. Set R2_ENDPOINT (https://<account id>.r2.cloudflarestorage.com),
 * R2_BUCKET, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY; without them, small files travel inside the job instead.
 */
export type R2 = { endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string };

export function r2(): R2 | null {
  const endpoint = process.env.R2_ENDPOINT?.trim().replace(/\/+$/, "");
  const bucket = process.env.R2_BUCKET?.trim();
  const accessKeyId = process.env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY?.trim();
  return endpoint && bucket && accessKeyId && secretAccessKey ? { endpoint, bucket, accessKeyId, secretAccessKey } : null;
}

const hmac = (key: string | Buffer, data: string) => createHmac("sha256", key).update(data).digest();
const sha256 = (data: string) => createHash("sha256").update(data).digest("hex");
// RFC 3986, as SigV4 wants it.
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** A link that lets whoever holds it GET or PUT one object for `seconds` (AWS SigV4, query-signed, region "auto"). */
export function presign(cfg: R2, method: "GET" | "PUT" | "HEAD", key: string, seconds = 3600) {
  const url = new URL(`${cfg.endpoint}/${cfg.bucket}/${key.split("/").map(enc).join("/")}`);
  const stamp = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = stamp.slice(0, 8);
  const scope = `${day}/auto/s3/aws4_request`;
  const query = Object.entries({
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${cfg.accessKeyId}/${scope}`,
    "X-Amz-Date": stamp,
    "X-Amz-Expires": String(seconds),
    "X-Amz-SignedHeaders": "host",
  })
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${enc(k)}=${enc(v)}`)
    .join("&");
  const canonical = [method, url.pathname, query, `host:${url.host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", stamp, scope, sha256(canonical)].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${cfg.secretAccessKey}`, day), "auto"), "s3"), "aws4_request");
  return `${url.origin}${url.pathname}?${query}&X-Amz-Signature=${hmac(signingKey, toSign).toString("hex")}`;
}

export async function putObject(cfg: R2, key: string, data: Buffer, mime: string) {
  const res = await fetch(presign(cfg, "PUT", key, 600), { method: "PUT", body: new Uint8Array(data), headers: { "Content-Type": mime } });
  if (!res.ok) throw new Error(`R2 refused the upload (${res.status}): ${(await res.text()).slice(0, 200)}`);
}

/** Whether an object is there already (inputs are kept by their hash, so the same picture goes up once). */
export async function hasObject(cfg: R2, key: string) {
  return (await fetch(presign(cfg, "HEAD", key, 300), { method: "HEAD" }).catch(() => null))?.ok ?? false;
}
