import "server-only";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { DATA_DIR, DB_FILE } from "./paths";
import type { Generation } from "@/lib/generations/types";
import { settle } from "@/lib/demo/codes";

// One connection per server process; survives hot reloads in dev.
const g = globalThis as unknown as { __crackioDb?: DatabaseSync };

function open() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new DatabaseSync(DB_FILE);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS generations (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      status TEXT NOT NULL,
      tool TEXT NOT NULL,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS generations_created ON generations(created_at DESC);
  `);
  // Jobs live in memory, so anything unfinished when the server stopped is gone.
  const stale = db.prepare("SELECT data FROM generations WHERE status IN ('queued', 'running')").all() as { data: string }[];
  for (const row of stale) {
    const gen = JSON.parse(row.data) as Generation;
    const next: Generation = { ...gen, status: "error", error: "Stopped when Crackio restarted.", stage: "Run it again." };
    db.prepare("UPDATE generations SET status = ?, data = ? WHERE id = ?").run(next.status, JSON.stringify(next), gen.id);
  }
  return db;
}

export const db = () => (g.__crackioDb ??= open());

export function saveGeneration(gen: Generation) {
  db()
    .prepare(
      `INSERT INTO generations (id, created_at, status, tool, data) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, data = excluded.data`,
    )
    .run(gen.id, gen.createdAt, gen.status, gen.tool, JSON.stringify(gen));
  // The live demo keeps a finished job's credits and gives a failed one's back, once (lib/demo/codes).
  if (gen.owner && (gen.status === "done" || gen.status === "error")) void settle(gen.id, gen.status === "done").catch(() => {});
  // A take made in a Storyboard project goes into its Library folder as it finishes (server/edit-projects).
  if (gen.status === "done" && typeof gen.params?.project === "string") {
    void import("./edit-projects").then((m) => m.fileFinished(gen)).catch((err) => console.warn(`[storyboard] couldn't file ${gen.id}: ${(err as Error).message}`));
  }
}

export function getGeneration(id: string): Generation | null {
  const row = db().prepare("SELECT data FROM generations WHERE id = ?").get(id) as { data: string } | undefined;
  return row ? (JSON.parse(row.data) as Generation) : null;
}

/** `owner` (live demo): only that access code's, and none for null. */
export function listGenerations({ limit = 60, before, owner }: { limit?: number; before?: number; owner?: string | null } = {}): Generation[] {
  if (owner === null) return [];
  const mine = owner === undefined ? "" : " AND json_extract(data, '$.owner') = ?";
  const rows = (
    before
      ? db()
          .prepare(`SELECT data FROM generations WHERE created_at < ?${mine} ORDER BY created_at DESC LIMIT ?`)
          .all(before, ...(owner === undefined ? [] : [owner]), limit)
      : db()
          .prepare(`SELECT data FROM generations WHERE 1${mine} ORDER BY created_at DESC LIMIT ?`)
          .all(...(owner === undefined ? [] : [owner]), limit)
  ) as { data: string }[];
  return rows.map((r) => JSON.parse(r.data) as Generation);
}

/** A tool's finished takes, newest first. */
export function listDoneByTool(tool: string, limit = 40): Generation[] {
  const rows = db().prepare("SELECT data FROM generations WHERE tool = ? AND status = 'done' ORDER BY created_at DESC LIMIT ?").all(tool, limit) as { data: string }[];
  return rows.map((r) => JSON.parse(r.data) as Generation);
}

export function deleteGeneration(id: string) {
  db().prepare("DELETE FROM generations WHERE id = ?").run(id);
}
