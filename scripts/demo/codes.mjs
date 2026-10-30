#!/usr/bin/env node
/**
 * Access codes for the live demo (docs/DEMO.md). A code is shown once, when it's made; only its hash is kept.
 *
 *   node scripts/demo/codes.mjs add --credits 300 --label judge1      make a code
 *   node scripts/demo/codes.mjs add --credits 300 --count 10 --label pub   make several
 *   node scripts/demo/codes.mjs list                                  every code with what it has left
 *   node scripts/demo/codes.mjs off <id>                              switch a code off
 *   node scripts/demo/codes.mjs topup <id> --credits 100             give a code more
 *
 * Reads CRACKIO_DATA_DIR, like the server (default ./data). The server notices changes on its own.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DATA_DIR = path.resolve(process.env.CRACKIO_DATA_DIR || path.join(process.cwd(), "data"));
const FILE = path.join(DATA_DIR, "demo", "codes.json");
// No 0/O or 1/I: codes get read aloud and typed from screenshots.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const hash = (code) => createHash("sha256").update(code.toUpperCase().replace(/[^A-Z0-9]/g, "")).digest("hex");
const load = () => (fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, "utf8")) : { version: 1, codes: {} });
function save(file) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(file, null, 2));
  fs.renameSync(tmp, FILE);
  // Run as root on the demo host: hand the files to whoever owns the data folder (the server charges codes there).
  if (process.getuid?.() === 0) {
    const { uid, gid } = fs.statSync(DATA_DIR);
    for (const p of [path.dirname(FILE), FILE]) fs.chownSync(p, uid, gid);
  }
}
function makeCode() {
  const bytes = randomBytes(8);
  const chars = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join("");
  return `CRK-${chars.slice(0, 4)}-${chars.slice(4, 8)}`;
}
const flag = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};

const [cmd, arg] = process.argv.slice(2);
const file = load();
const byId = (id) => Object.values(file.codes).find((c) => c.id === id);

if (cmd === "add") {
  const credits = Number(flag("credits", 300));
  const count = Math.max(1, Math.min(200, Number(flag("count", 1))));
  const label = String(flag("label", "code")).slice(0, 40);
  if (!(credits > 0)) throw new Error("--credits must be a positive number");
  for (let n = 1; n <= count; n++) {
    const code = makeCode();
    const id = randomUUID().replaceAll("-", "").slice(0, 12);
    file.codes[hash(code)] = { id, label: count > 1 ? `${label}${n}` : label, credits, spent: 0, createdAt: Date.now() };
    console.log(`${code}  ${credits} credits  (${count > 1 ? `${label}${n}` : label}, id ${id})`);
  }
  save(file);
  console.log("\nShown once: copy them now.");
} else if (cmd === "list") {
  const rows = Object.values(file.codes).sort((a, b) => a.createdAt - b.createdAt);
  if (!rows.length) console.log("No codes yet: node scripts/demo/codes.mjs add --credits 300 --label judge1");
  for (const c of rows) {
    const held = Object.values(c.held ?? {}).reduce((a, b) => a + b, 0);
    console.log(
      `${c.id}  ${c.label.padEnd(12)} ${String(Math.max(0, c.credits - c.spent)).padStart(5)} of ${c.credits} left${held ? ` (${held} on running jobs)` : ""}${c.disabled ? "  OFF" : ""}`,
    );
  }
} else if (cmd === "off" && arg) {
  const c = byId(arg);
  if (!c) throw new Error(`No code with id ${arg}`);
  c.disabled = true;
  save(file);
  console.log(`${arg} is off.`);
} else if (cmd === "topup" && arg) {
  const c = byId(arg);
  if (!c) throw new Error(`No code with id ${arg}`);
  c.credits += Number(flag("credits", 100));
  save(file);
  console.log(`${arg} now has ${c.credits - c.spent} left.`);
} else {
  console.log("Usage: codes.mjs add --credits 300 [--count N] [--label name] | list | off <id> | topup <id> --credits N");
  process.exitCode = 1;
}
