import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";

/**
 * Saves a file in one step: written beside it, then renamed over it, so a reader gets the old
 * contents or the new, never half a file. Windows refuses that rename (EPERM) while anything has
 * the file open: a request reading it, the virus scanner, the search indexer, another Crackio
 * server. That passes in milliseconds, so the rename is retried for a few seconds before it fails.
 */
export async function writeFileAtomic(file: string, data: string, options?: { mode?: number }) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  // Unique per write, so two saves of one file never share a temp file. (Built with path.join,
  // ignored: a bare template string reads to the bundler as "any file".)
  const tmp = path.join(/*turbopackIgnore: true*/ path.dirname(file), `${path.basename(file)}.${process.pid}.${nanoid(6)}.tmp`);
  try {
    await fs.writeFile(tmp, data, options);
    await renameWhenFree(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

const BUSY = new Set(["EPERM", "EACCES", "EBUSY"]);

async function renameWhenFree(from: string, to: string, ms = 5000) {
  const started = Date.now();
  for (let wait = 10; ; wait = Math.min(wait * 2, 250)) {
    try {
      return await fs.rename(from, to);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (process.platform !== "win32" || !BUSY.has(code) || Date.now() - started + wait > ms) throw err;
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}
