// For the Start Crackio launchers: exits 0 when Crackio needs building (no build yet, or the code changed since the last
// one), 1 when the last build is still current. A build is current when nothing that goes into it is newer than it.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const built = path.join(root, ".next", "BUILD_ID");
if (!fs.existsSync(built)) process.exit(0);
const since = fs.statSync(built).mtimeMs;

/** The newest change under a file or folder (node_modules and dot-folders left out). */
function newest(p) {
  if (!fs.existsSync(p)) return 0;
  const stat = fs.statSync(p);
  if (!stat.isDirectory()) return stat.mtimeMs;
  let latest = 0;
  for (const name of fs.readdirSync(p)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    latest = Math.max(latest, newest(path.join(p, name)));
    if (latest > since) return latest;
  }
  return latest;
}

const inputs = ["src", "public", "package.json", "pnpm-lock.yaml", "next.config.ts", "tsconfig.json", "postcss.config.mjs"];
process.exit(inputs.some((p) => newest(path.join(root, p)) > since) ? 0 : 1);
