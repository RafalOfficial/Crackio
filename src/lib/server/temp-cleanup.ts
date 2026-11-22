import "server-only";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Leftovers of jobs that stopped midway (a crash, a restart, Windows refusing to delete a file still open): the temp folders
 * and files Crackio's own steps make, by their exact names, a day old or more. Only those names: other programs (and
 * other folders named crackio-something) are never touched. A job running now is never a day old.
 */
const FOLDER = /^crackio-(ripple|film|filmcheck|captions|sound|score|said|preview|pose|paste|fit|finish|clip)-[A-Za-z0-9]{6}$/;
const FILE = /^crackio-(cut|motion|talk)-[A-Za-z0-9_-]{8,10}\.(png|mp4|webm|wav)$|^crackio-[A-Za-z0-9_-]{8}\.txt$/;
const DAY = 24 * 3_600_000;

export async function cleanOldTemp(): Promise<{ removed: number; bytes: number }> {
  const dir = os.tmpdir();
  let removed = 0;
  let bytes = 0;
  const names = await fs.readdir(/*turbopackIgnore: true*/ dir).catch(() => [] as string[]);
  for (const name of names) {
    const folder = FOLDER.test(name);
    if (!folder && !FILE.test(name)) continue;
    const full = path.join(/*turbopackIgnore: true*/ dir, name);
    const st = await fs.stat(/*turbopackIgnore: true*/ full).catch(() => null);
    if (!st || Date.now() - st.mtimeMs < DAY || st.isDirectory() !== folder) continue;
    const size = folder ? await folderBytes(full) : st.size;
    const ok = await fs
      .rm(full, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
      .then(() => true)
      .catch(() => false);
    if (ok) {
      removed++;
      bytes += size;
    }
  }
  return { removed, bytes };
}

async function folderBytes(dir: string): Promise<number> {
  let total = 0;
  for (const e of await fs.readdir(/*turbopackIgnore: true*/ dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(/*turbopackIgnore: true*/ dir, e.name);
    total += e.isDirectory() ? await folderBytes(p) : ((await fs.stat(/*turbopackIgnore: true*/ p).catch(() => null))?.size ?? 0);
  }
  return total;
}
