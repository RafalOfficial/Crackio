import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "@/lib/server/atomic-write";
import { DATA_DIR } from "@/lib/server/paths";
import type { MotionPlan } from "./playbook";

/**
 * What recent Motion projects looked like (format, look, signature moves), so the next one is
 * steered somewhere new instead of settling into a house style. One small file beside the
 * projects folder (not in it: that folder lists projects).
 */
export type RecentPiece = { projectId: string; at: number; format?: string; look?: string; moves?: string[] };

const FILE = () => path.join(DATA_DIR, "motion-recent.json");
const KEEP = 12;

export async function recentPieces(except?: string): Promise<RecentPiece[]> {
  try {
    const list = JSON.parse(await fs.readFile(FILE(), "utf8")) as RecentPiece[];
    return Array.isArray(list) ? list.filter((r) => r && r.projectId !== except).slice(0, KEEP) : [];
  } catch {
    return [];
  }
}

export async function rememberPiece(projectId: string, plan: MotionPlan) {
  const list = (await recentPieces(projectId)).slice(0, KEEP - 1);
  const next: RecentPiece[] = [{ projectId, at: Date.now(), format: plan.format, look: plan.look, moves: plan.moves }, ...list];
  await writeFileAtomic(FILE(), JSON.stringify(next));
}

export function describeRecent(list: RecentPiece[]): string {
  if (!list.length) return "";
  return list
    .slice(0, 6)
    .map((r) => `- ${r.format ?? "unnamed format"}; look: ${(r.look ?? "?").slice(0, 70)}; moves: ${(r.moves ?? []).join(", ") || "none listed"}`)
    .join("\n");
}
