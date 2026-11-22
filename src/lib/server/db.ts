import "server-only";
import fs from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { DATA_DIR, DB_FILE } from "./paths";
import type { Generation } from "@/lib/generations/types";
import { settle } from "@/lib/demo/codes";

// One connection per server process; survives hot reloads in dev.
const g = globalThis as unknown as {
  __crackioDb?: DatabaseSync;
  /** Prepared statements by their SQL: preparing again on every call cost about as much as running them. */
  __crackioDbStatements?: Map<string, StatementSync>;
  /** Takes deleted in this run: a job still running writes its next progress (or its "Cancelled.") after the delete. */
  __crackioDbGone?: Set<string>;
};
const gone = (g.__crackioDbGone ??= new Set());

function open() {
  fs.mkdirSync(/*turbopackIgnore: true*/ DATA_DIR, { recursive: true });
  const db = new DatabaseSync(DB_FILE);
  db.exec(`
    PRAGMA journal_mode = WAL;
    -- Another process on data/ (a second server, a script) waits its turn instead of failing with "database is locked".
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS generations (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      status TEXT NOT NULL,
      tool TEXT NOT NULL,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS generations_created ON generations(created_at DESC);
    -- One tool's takes (Product Studio's list, a tool's own history): 13 ms -> 0.2 ms.
    CREATE INDEX IF NOT EXISTS generations_tool_created ON generations(tool, created_at DESC);
  `);
  // Jobs live in memory, so anything unfinished when the server stopped is gone.
  const stale = db.prepare("SELECT data FROM generations WHERE status IN ('queued', 'running')").all() as { data: string }[];
  if (stale.length) {
    const update = db.prepare("UPDATE generations SET status = ?, data = ? WHERE id = ?");
    db.exec("BEGIN");
    try {
      for (const row of stale) {
        const gen = JSON.parse(row.data) as Generation;
        const next: Generation = { ...gen, status: "error", error: "Stopped when Crackio restarted.", stage: "Run it again." };
        update.run(next.status, JSON.stringify(next), gen.id);
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  return db;
}

export const db = () => (g.__crackioDb ??= open());

/** A prepared statement, made once per SQL text. */
function sql(text: string): StatementSync {
  const all = (g.__crackioDbStatements ??= new Map());
  let s = all.get(text);
  if (!s) {
    s = db().prepare(text);
    all.set(text, s);
  }
  return s;
}

export function saveGeneration(gen: Generation) {
  // Deleted: a job that was still running doesn't bring its card back with its next write.
  if (gone.has(gen.id)) return;
  sql(
    `INSERT INTO generations (id, created_at, status, tool, data) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, data = excluded.data`,
  ).run(gen.id, gen.createdAt, gen.status, gen.tool, JSON.stringify(gen));
  // The live demo keeps a finished job's credits and gives a failed one's back, once (lib/demo/codes).
  if (gen.owner && (gen.status === "done" || gen.status === "error")) void settle(gen.id, gen.status === "done").catch(() => {});
  // A take made in a Storyboard project goes into its Library folder as it finishes (server/edit-projects).
  if (gen.status === "done" && typeof gen.params?.project === "string") {
    void import("./edit-projects").then((m) => m.fileFinished(gen)).catch((err) => console.warn(`[storyboard] couldn't file ${gen.id}: ${(err as Error).message}`));
  }
}

export function getGeneration(id: string): Generation | null {
  const row = sql("SELECT data FROM generations WHERE id = ?").get(id) as { data: string } | undefined;
  return row ? (JSON.parse(row.data) as Generation) : null;
}

/**
 * Newest first. `owner` (live demo): only that access code's, and none for null. `tools`: only those tools' takes (a tool's
 * own history reaches past the newest 60 of every tool).
 */
export function listGenerations({ limit = 60, before, owner, tools }: { limit?: number; before?: number; owner?: string | null; tools?: string[] } = {}): Generation[] {
  if (owner === null) return [];
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (before) {
    where.push("created_at < ?");
    args.push(before);
  }
  if (owner !== undefined) {
    where.push("json_extract(data, '$.owner') = ?");
    args.push(owner);
  }
  if (tools?.length) {
    where.push(`tool IN (${tools.map(() => "?").join(", ")})`);
    args.push(...tools);
  }
  const rows = sql(`SELECT data FROM generations${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ?`).all(...args, limit) as { data: string }[];
  return rows.map((r) => JSON.parse(r.data) as Generation);
}

/** A tool's finished takes, newest first. */
export function listDoneByTool(tool: string, limit = 40): Generation[] {
  const rows = sql("SELECT data FROM generations WHERE tool = ? AND status = 'done' ORDER BY created_at DESC LIMIT ?").all(tool, limit) as { data: string }[];
  return rows.map((r) => JSON.parse(r.data) as Generation);
}

export function deleteGeneration(id: string) {
  gone.add(id);
  // Kept for this run only, and only the last 2,000.
  if (gone.size > 2000) gone.delete(gone.values().next().value!);
  sql("DELETE FROM generations WHERE id = ?").run(id);
}
