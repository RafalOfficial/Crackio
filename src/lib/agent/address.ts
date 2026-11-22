import "server-only";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DATA_DIR } from "@/lib/server/paths";

/**
 * Where this Crackio answers, written to ~/.crackio/server.json so the MCP program (scripts/mcp/crackio-mcp.mjs) finds
 * it on whatever port it was started. Written once per run, the first time the agent door is asked anything (and when
 * Settings → Agents opens); other Crackios on this computer keep their own line.
 */
const FILE = path.join(os.homedir(), ".crackio", "server.json");
const g = globalThis as unknown as { __crackioAddressNoted?: boolean };

type Noted = { url: string; pid: number; startedAt: number; dataDir: string };

export async function noteAddress() {
  if (g.__crackioAddressNoted || process.env.CRACKIO_DEMO === "1") return;
  g.__crackioAddressNoted = true;
  try {
    const mine: Noted = { url: `http://127.0.0.1:${process.env.PORT || 3000}`, pid: process.pid, startedAt: Date.now(), dataDir: DATA_DIR };
    const before = await fs
      .readFile(/*turbopackIgnore: true*/ FILE, "utf8")
      .then((t) => (JSON.parse(t) as { servers?: Noted[] }).servers ?? [])
      .catch(() => [] as Noted[]);
    const servers = [mine, ...before.filter((s) => s && typeof s.url === "string" && s.url !== mine.url)].slice(0, 5);
    await fs.mkdir(/*turbopackIgnore: true*/ path.dirname(FILE), { recursive: true });
    await fs.writeFile(/*turbopackIgnore: true*/ FILE, JSON.stringify({ servers }, null, 1));
  } catch {
    // Only a convenience: the program also tries this computer's usual ports.
    g.__crackioAddressNoted = false;
  }
}
