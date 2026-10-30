import "server-only";
import { db } from "./db";
import { toHandle, type Character } from "@/lib/cast/types";

/** Where Cast keeps its characters: one row each in Crackio's database. */

const g = globalThis as unknown as { __crackioCastTable?: boolean };

function table() {
  const d = db();
  if (!g.__crackioCastTable) {
    d.exec(`CREATE TABLE IF NOT EXISTS characters (
      id TEXT PRIMARY KEY,
      handle TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      data TEXT NOT NULL
    )`);
    g.__crackioCastTable = true;
  }
  return d;
}

export function saveCharacter(c: Character) {
  table()
    .prepare(
      `INSERT INTO characters (id, handle, created_at, data) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET handle = excluded.handle, data = excluded.data`,
    )
    .run(c.id, c.handle, c.createdAt, JSON.stringify(c));
}

const parse = (row: { data: string } | undefined) => (row ? (JSON.parse(row.data) as Character) : null);

export function loadCharacter(id: string) {
  return parse(table().prepare("SELECT data FROM characters WHERE id = ?").get(id) as { data: string } | undefined);
}

export function characterByHandle(handle: string) {
  return parse(table().prepare("SELECT data FROM characters WHERE handle = ?").get(handle.toLowerCase()) as { data: string } | undefined);
}

export function allCharacters(): Character[] {
  return (table().prepare("SELECT data FROM characters ORDER BY created_at DESC").all() as { data: string }[]).map((r) => JSON.parse(r.data) as Character);
}

export function removeCharacter(id: string) {
  table().prepare("DELETE FROM characters WHERE id = ?").run(id);
}

/** "mia", or "mia_2" when that's taken by someone else. */
export function freeHandle(wanted: string, self?: string) {
  const base = toHandle(wanted);
  for (let n = 1; ; n++) {
    const handle = n === 1 ? base : `${base.slice(0, 21)}_${n}`;
    const owner = characterByHandle(handle);
    if (!owner || owner.id === self) return handle;
  }
}
