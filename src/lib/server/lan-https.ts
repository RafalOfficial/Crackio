import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DATA_DIR } from "@/lib/server/paths";

/**
 * Crackio's secure address for the other devices on your network. Browsers only let a page use the microphone (and a
 * few other things) on https or on the computer itself, so a Mac or a phone opening http://192.168.x.x:3210 can't
 * record a voice to clone. Next to the plain address Crackio also answers https on PORT + 1000 (4210 beside 3210), with a
 * certificate it makes for this computer's network addresses, signed by its own small certificate authority.
 *
 * The authority can only vouch for local names and private addresses (name constraints), so trusting it on a Mac or
 * phone can't be turned against any real site even if its key leaked. Without trusting it the browser warns once
 * ("not private"); going on from that warning is enough. Files live in data/certs.
 *
 * Off until asked for: Clone's "Turn on the secure address" (remembered in data/certs, so it opens with Crackio from then
 * on) or CRACKIO_LAN_HTTPS=1. CRACKIO_LAN_HTTPS=0 and the live demo (CRACKIO_DEMO=1) keep it off whatever was asked.
 * CRACKIO_HTTPS_PORT picks the port.
 */

const DIR = path.join(DATA_DIR, "certs");
const FILES = { caKey: "lan-ca.key", ca: "lan-ca.pem", key: "lan.key", cert: "lan.pem", meta: "lan.json", on: "lan-on" } as const;
/** Apple refuses server certificates valid for more than 825 days. */
const LEAF_DAYS = 800;
const CA_YEARS = 10;

export type LanHttps = { port: number; running: boolean; error: string | null; ips: string[]; names: string[] };
type Entry = { status: LanHttps; server: https.Server | null; starting: Promise<void> | null };
type Meta = { ips: string[]; names: string[]; notAfter: string; permitted: string[] };

const state = globalThis as unknown as { __crackioLan?: Entry };

/** Whether this Crackio may open the secure address at all (never in the live demo, nor when turned off). */
export function lanAllowed() {
  return process.env.CRACKIO_DEMO !== "1" && process.env.CRACKIO_LAN_HTTPS !== "0";
}

/** Whether it was asked for: by the environment, or turned on once from Clone. */
export async function lanWanted() {
  if (!lanAllowed()) return false;
  if (process.env.CRACKIO_LAN_HTTPS === "1") return true;
  return fs.access(path.join(DIR, FILES.on)).then(
    () => true,
    () => false,
  );
}

/** What the secure address is doing (null until it was asked to start). */
export function lanHttps(): LanHttps | null {
  return state.__crackioLan?.status ?? null;
}

export function lanHttpsPort() {
  const own = Number(process.env.CRACKIO_HTTPS_PORT);
  return own > 0 ? own : (Number(process.env.PORT) || 3000) + 1000;
}

export async function lanCaPem() {
  return fs.readFile(path.join(DIR, FILES.ca), "utf8").catch(() => null);
}

/* ------------------------------------------------------------------ DER, just enough for two certificates */

function der(tag: number, ...parts: Buffer[]) {
  const body = Buffer.concat(parts);
  const n = body.length;
  const len: number[] = [];
  if (n < 0x80) len.push(n);
  else {
    for (let v = n; v > 0; v = Math.floor(v / 256)) len.unshift(v & 0xff);
    len.unshift(0x80 | len.length);
  }
  return Buffer.concat([Buffer.from([tag, ...len]), body]);
}
const seq = (...p: Buffer[]) => der(0x30, ...p);
const set = (...p: Buffer[]) => der(0x31, ...p);
function oid(dotted: string) {
  const [a, b, ...rest] = dotted.split(".").map(Number);
  const out = [40 * a + b];
  for (const v of rest) {
    const chunk = [v & 0x7f];
    for (let x = Math.floor(v / 128); x > 0; x = Math.floor(x / 128)) chunk.unshift((x & 0x7f) | 0x80);
    out.push(...chunk);
  }
  return der(0x06, Buffer.from(out));
}
const int = (n: number) => der(0x02, Buffer.from([n]));
const utf8 = (s: string) => der(0x0c, Buffer.from(s, "utf8"));
const yes = () => der(0x01, Buffer.from([0xff]));
const octets = (b: Buffer) => der(0x04, b);
const bitString = (b: Buffer, unused = 0) => der(0x03, Buffer.from([unused]), b);
function time(d: Date) {
  const p = (n: number) => String(n).padStart(2, "0");
  const rest = `${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  const y = d.getUTCFullYear();
  return y < 2050 ? der(0x17, Buffer.from(`${String(y).slice(2)}${rest}`)) : der(0x18, Buffer.from(`${y}${rest}`));
}
const ext = (id: string, critical: boolean, value: Buffer) => seq(oid(id), ...(critical ? [yes()] : []), octets(value));
const dnsName = (s: string) => der(0x82, Buffer.from(s, "ascii"));
const ipName = (bytes: number[]) => der(0x87, Buffer.from(bytes));
const ECDSA_SHA256 = seq(oid("1.2.840.10045.4.3.2"));
const nameOf = (cn: string) => seq(set(seq(oid("2.5.4.10"), utf8("Crackio"))), set(seq(oid("2.5.4.3"), utf8(cn))));
const pem = (body: Buffer) => `-----BEGIN CERTIFICATE-----\n${body.toString("base64").match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----\n`;

function serial() {
  const b = crypto.randomBytes(16);
  // Positive, no leading zero byte.
  b[0] = (b[0] & 0x3f) | 0x40;
  return der(0x02, b);
}
const keyId = (pub: crypto.KeyObject) => crypto.createHash("sha1").update(pub.export({ type: "spki", format: "der" })).digest();

function certificate(o: {
  subject: string;
  issuer: string;
  pub: crypto.KeyObject;
  signer: crypto.KeyObject;
  from: Date;
  to: Date;
  extensions: Buffer[];
}) {
  const tbs = seq(
    der(0xa0, int(2)), // v3
    serial(),
    ECDSA_SHA256,
    nameOf(o.issuer),
    seq(time(o.from), time(o.to)),
    nameOf(o.subject),
    o.pub.export({ type: "spki", format: "der" }),
    der(0xa3, seq(...o.extensions)),
  );
  return pem(seq(tbs, ECDSA_SHA256, bitString(crypto.sign("sha256", tbs, o.signer))));
}

/* ------------------------------------------------------------------ which names */

/** Private and local ranges the authority may vouch for: [address, mask]. */
const PRIVATE_V4: [number[], number[]][] = [
  [[10, 0, 0, 0], [255, 0, 0, 0]],
  [[172, 16, 0, 0], [255, 240, 0, 0]],
  [[192, 168, 0, 0], [255, 255, 0, 0]],
  [[127, 0, 0, 0], [255, 0, 0, 0]],
  [[169, 254, 0, 0], [255, 255, 0, 0]],
  // Tailscale and other carrier-grade NAT addresses.
  [[100, 64, 0, 0], [255, 192, 0, 0]],
];
const LOCAL_SUFFIXES = ["localhost", "local", "lan", "home", "home.arpa", "internal", "ts.net"];

const v4 = (ip: string) => ip.split(".").map(Number);
const privateV4 = (ip: string) => PRIVATE_V4.some(([net4, mask]) => v4(ip).every((b, i) => (b & mask[i]) === net4[i]));

/** This computer's addresses on its networks, and its names. */
function here() {
  const ips = new Set(["127.0.0.1"]);
  for (const addrs of Object.values(os.networkInterfaces())) for (const a of addrs ?? []) if (a.family === "IPv4" && !a.internal && privateV4(a.address)) ips.add(a.address);
  const host = os
    .hostname()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "");
  const names = ["localhost", ...(host ? [host, `${host}.local`] : [])];
  return { ips: [...ips].sort(), names, host };
}

/* ------------------------------------------------------------------ the certificates */

async function read(file: string) {
  return fs.readFile(path.join(DIR, file), "utf8").catch(() => null);
}

/** The authority (made once, kept) and a server certificate for this computer's current addresses (remade when they change). */
async function certificates() {
  await fs.mkdir(DIR, { recursive: true });
  const { ips, names, host } = here();
  const now = Date.now();
  const day = 86_400_000;

  let caKeyPem = await read(FILES.caKey);
  let caPem = await read(FILES.ca);
  let meta = JSON.parse((await read(FILES.meta)) ?? "null") as Meta | null;
  if (!caKeyPem || !caPem || !meta?.permitted) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
    // Local names only: this computer's own name plus the suffixes home networks use, and private addresses.
    const permitted = [...LOCAL_SUFFIXES, ...(host ? [host] : [])];
    const constraints = seq(der(0xa0, ...permitted.map((n) => seq(dnsName(n))), ...PRIVATE_V4.map(([a, m]) => seq(ipName([...a, ...m]))))); // permittedSubtrees [0]
    caPem = certificate({
      subject: `Crackio local CA (${host || "this computer"})`,
      issuer: `Crackio local CA (${host || "this computer"})`,
      pub: publicKey,
      signer: privateKey,
      from: new Date(now - day),
      to: new Date(now + CA_YEARS * 365 * day),
      extensions: [
        ext("2.5.29.19", true, seq(yes(), int(0))), // a CA that signs only server certificates
        ext("2.5.29.15", true, bitString(Buffer.from([0x86]), 1)), // digitalSignature, keyCertSign, cRLSign
        ext("2.5.29.14", false, octets(keyId(publicKey))),
        ext("2.5.29.30", true, constraints),
      ],
    });
    caKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    await fs.writeFile(path.join(DIR, FILES.caKey), caKeyPem, { mode: 0o600 });
    await fs.writeFile(path.join(DIR, FILES.ca), caPem);
    meta = { ips: [], names: [], notAfter: new Date(0).toISOString(), permitted };
    await fs.rm(path.join(DIR, FILES.cert), { force: true });
  }

  const allowed = names.filter((n) => meta!.permitted.some((p) => n === p || n.endsWith(`.${p}`)));
  let keyPem = await read(FILES.key);
  let certPem = await read(FILES.cert);
  const stale = !keyPem || !certPem || Date.parse(meta.notAfter) - now < 30 * day || ips.some((ip) => !meta!.ips.includes(ip)) || allowed.some((n) => !meta!.names.includes(n));
  if (stale) {
    const caKey = crypto.createPrivateKey(caKeyPem);
    const ca = new crypto.X509Certificate(caPem);
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
    const to = new Date(now + LEAF_DAYS * day);
    certPem = certificate({
      subject: `Crackio on ${host || "this computer"}`,
      issuer: ca.subject.match(/CN=([^\n]+)/)?.[1] ?? `Crackio local CA (${host || "this computer"})`,
      pub: publicKey,
      signer: caKey,
      from: new Date(now - day),
      to,
      extensions: [
        ext("2.5.29.19", true, seq()),
        ext("2.5.29.15", true, bitString(Buffer.from([0x80]), 7)), // digitalSignature
        ext("2.5.29.37", false, seq(oid("1.3.6.1.5.5.7.3.1"))), // serverAuth
        ext("2.5.29.17", false, seq(...allowed.map(dnsName), ...ips.map((ip) => ipName(v4(ip))))),
        ext("2.5.29.14", false, octets(keyId(publicKey))),
        ext("2.5.29.35", false, seq(der(0x80, keyId(ca.publicKey)))),
      ],
    });
    const leaf = new crypto.X509Certificate(certPem);
    if (!leaf.verify(ca.publicKey) || !leaf.checkIssued(ca)) throw new Error("The new certificate didn't check out against Crackio's authority.");
    keyPem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    await fs.writeFile(path.join(DIR, FILES.key), keyPem, { mode: 0o600 });
    await fs.writeFile(path.join(DIR, FILES.cert), certPem);
    meta = { ...meta, ips, names: allowed, notAfter: to.toISOString() };
    await fs.writeFile(path.join(DIR, FILES.meta), JSON.stringify(meta, null, 2));
  }
  return { key: keyPem!, cert: `${certPem}${caPem}`, ips, names: allowed };
}

/* ------------------------------------------------------------------ the proxy */

/**
 * Opens the secure address if it was asked for (`turnOn` asks, and remembers it). Once per server process; a failed
 * start can be tried again. Never throws: what went wrong is in the status.
 */
export async function startLanHttps({ turnOn = false }: { turnOn?: boolean } = {}): Promise<LanHttps | null> {
  if (!lanAllowed()) return null;
  if (turnOn) {
    await fs.mkdir(DIR, { recursive: true });
    await fs.writeFile(path.join(DIR, FILES.on), `turned on ${new Date().toISOString()}\n`);
  } else if (!(await lanWanted())) return null;
  const was = state.__crackioLan;
  if (was?.starting) await was.starting;
  if (was?.status.running) return was.status;
  const port = lanHttpsPort();
  const status: LanHttps = { port, running: false, error: null, ips: [], names: [] };
  const entry: Entry = { status, server: null, starting: null };
  state.__crackioLan = entry;
  entry.starting = open(entry);
  await entry.starting;
  entry.starting = null;
  return status;
}

async function open(entry: Entry) {
  const { status } = entry;
  const port = status.port;
  try {
    const { key, cert, ips, names } = await certificates();
    status.ips = ips;
    status.names = names;
    const target = { host: "127.0.0.1", port: Number(process.env.PORT) || 3000 };
    const agent = new http.Agent({ keepAlive: true, maxSockets: 128 });
    const server = https.createServer({ key, cert }, (req, res) => {
      const headers = { ...req.headers, "x-forwarded-proto": "https", "x-forwarded-host": req.headers.host ?? "", "x-forwarded-for": req.socket.remoteAddress ?? "" };
      const up = http.request({ ...target, agent, method: req.method, path: req.url, headers }, (r) => {
        res.writeHead(r.statusCode ?? 502, r.statusMessage, r.headers);
        r.pipe(res);
      });
      up.on("error", () => {
        if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
        res.end("Crackio isn't answering on this computer right now.");
      });
      // A request the browser gave up on stops here too (long generations listen for that).
      res.on("close", () => {
        if (!res.writableFinished) up.destroy();
      });
      req.pipe(up);
    });
    // Live updates and the dev server's reloads: pass the WebSocket through as it is.
    server.on("upgrade", (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
      const up = net.connect(target.port, target.host, () => {
        let raw = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
        for (let i = 0; i < req.rawHeaders.length; i += 2) raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
        up.write(`${raw}X-Forwarded-Proto: https\r\n\r\n`);
        if (head?.length) up.write(head);
        up.pipe(socket);
        socket.pipe(up);
      });
      up.on("error", () => socket.destroy());
      socket.on("error", () => up.destroy());
    });
    // Uploads and generations can take a long time.
    server.requestTimeout = 0;
    server.headersTimeout = 60_000;
    server.keepAliveTimeout = 65_000;
    server.on("tlsClientError", () => {});
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "0.0.0.0", () => {
        server.off("error", reject);
        resolve();
      });
    });
    server.on("error", (err) => (status.error = err.message));
    entry.server = server;
    status.running = true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    status.error = code === "EADDRINUSE" ? `Port ${port} is taken by another program (set CRACKIO_HTTPS_PORT to use another).` : (err as Error).message;
    console.warn(`[crackio] secure network address off: ${status.error}`);
  }
}
