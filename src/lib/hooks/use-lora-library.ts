"use client";

import { create } from "zustand";
import { installedVariant } from "@/lib/local/rows";
import { loraFileName, type LoraEntry, type LoraFile, type LoraLibrary, type LoraRecord } from "@/lib/local/loras";
import type { Download, LocalModel, LocalStatus, TargetStatus } from "@/lib/local/types";
import { reloadLocal } from "./use-local";
import { setLora, useModelLoras } from "./use-model-loras";

/**
 * The LoRA library on the pages (api/local/loras): Crackio's picks for each model, what each downloaded file is, the
 * downloads and switches. Shared by the model library and the Local page: a download started in one shows in the other,
 * through the machines' downloads the local store polls.
 */

type State = { library: LoraLibrary | null; error: string | null };

export const useLoraLibrary = create<State>(() => ({ library: null, error: null }));

let asked = false;

/** Load the library once a page (again with `force`, after a download records a new file). */
export function loadLoraLibrary(force = false) {
  if (asked && !force) return;
  asked = true;
  void fetch("/api/local/loras/library", { cache: "no-store" })
    .then(async (res) => {
      const body = (await res.json().catch(() => ({}))) as LoraLibrary & { error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      useLoraLibrary.setState({ library: body, error: null });
    })
    .catch((err: Error) => {
      asked = false;
      useLoraLibrary.setState({ error: err.message });
    });
}

const ACTIVE: Download["state"][] = ["queued", "downloading", "checking"];

/** The machines whose ComfyUI answers. */
export const onlineTargets = (status: LocalStatus | null) => (status?.targets ?? []).filter((t) => t.connected);

/** Machines with a LoRA file in their models/loras. */
export const holders = (status: LocalStatus | null, file: string) => onlineTargets(status).filter((t) => t.installed.includes(`loras/${file}`));

/** A LoRA's files on their way to machines: how far, and the last one that failed. */
export function loraDownloads(status: LocalStatus | null, files: string[]) {
  const all = onlineTargets(status).flatMap((t) => t.downloads.filter((d) => d.folder === "loras" && files.includes(d.filename)).map((d) => ({ ...d, target: t })));
  const active = all.filter((d) => ACTIVE.includes(d.state));
  const received = active.reduce((n, d) => n + d.received, 0);
  const total = active.reduce((n, d) => n + d.total, 0);
  const failed = all.filter((d) => d.state === "error").at(-1) ?? null;
  return { active, share: total ? received / total : 0, checking: active.some((d) => d.state === "checking"), failed };
}

/**
 * Where a LoRA for this model goes: every machine that has the model (a job may run on any of them), else the one local
 * jobs run on, else the first that answers.
 */
export function loraTargets(status: LocalStatus | null, model: LocalModel): TargetStatus[] {
  const online = onlineTargets(status);
  const with_ = online.filter((t) => installedVariant(model, t));
  if (with_.length) return with_;
  const runOn = online.find((t) => t.id === status?.runOn);
  return runOn ? [runOn] : online.slice(0, 1);
}

/** The file names a library entry has (or will have) in models/loras. */
export const entryFiles = (e: LoraEntry) => e.local ?? e.files.map((f) => loraFileName(e.repo, f.path));

/**
 * One LoRA on a model page: its entry (a pick, or the record of a file found on Hugging Face), its files, and what they are
 * on your machines: on every machine that has the model, on some, or none yet.
 */
export type LoraView = { entry: LoraEntry; files: string[]; installed: TargetStatus[]; missing: TargetStatus[] };

export function viewOf(entry: LoraEntry, status: LocalStatus | null, model: LocalModel): LoraView {
  const files = entryFiles(entry);
  const wanted = loraTargets(status, model);
  const installed = onlineTargets(status).filter((t) => files.every((f) => t.installed.includes(`loras/${f}`)));
  return { entry, files, installed, missing: wanted.filter((t) => !installed.some((x) => x.id === t.id)) };
}

/**
 * A downloaded file's record, as an entry of the model's page: a file found on Hugging Face, or the file of a pick that
 * has since changed its file or left the picks. Either way it's its own entry, got again from its repo like a find.
 */
export function recordEntry(r: LoraRecord): LoraEntry {
  return {
    // One per file: two files of a repo, or a pick's old file beside the pick, never share an id.
    id: `file:${r.file}`,
    name: r.name,
    models: r.models,
    repo: r.repo,
    files: [{ path: r.path, bytes: r.bytes, ...(r.match ? { match: r.match } : {}) }],
    category: r.category,
    blurb: "",
    ...(r.trigger ? { trigger: r.trigger } : {}),
    strength: r.strength,
    range: r.range,
    licence: r.licence,
    author: r.repo.split("/")[0],
    found: true,
    local: [r.file],
  };
}

/**
 * A model's LoRAs: Crackio's picks for it in their order, then the other files downloaded for it (one entry per file; a
 * pick's own files aren't listed twice), which the page shows only while a machine has them or they're on.
 */
export function modelEntries(library: LoraLibrary | null, model: LocalModel) {
  if (!library) return { picks: [] as LoraEntry[], found: [] as LoraEntry[] };
  // The ones Crackio ran and saw work come first (a stable sort keeps the picks' order otherwise).
  const picks = library.entries.filter((e) => e.models.includes(model.id)).sort((a, b) => Number(Boolean(b.tested)) - Number(Boolean(a.tested)));
  const pickFiles = new Set(library.entries.flatMap(entryFiles));
  const found = Object.values(library.records)
    .filter((r) => r.models.includes(model.id) && !pickFiles.has(r.file))
    .map(recordEntry);
  return { picks, found };
}

/** LoRA files on your machines that no pick or record explains: put there by hand, or for another model. */
export function unknownFiles(library: LoraLibrary | null, status: LocalStatus | null) {
  const known = new Set([...(library?.entries ?? []).flatMap(entryFiles), ...Object.keys(library?.records ?? {})]);
  const out = new Map<string, TargetStatus[]>();
  for (const t of onlineTargets(status))
    for (const f of t.installed)
      if (f.startsWith("loras/") && /\.safetensors$/i.test(f) && !known.has(f.slice(6))) out.set(f.slice(6), [...(out.get(f.slice(6)) ?? []), t]);
  return [...out.entries()].map(([file, targets]) => ({ file, targets })).sort((a, b) => a.file.localeCompare(b.file));
}

async function post(body: Record<string, unknown>) {
  const res = await fetch("/api/local/loras/library", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
  if (!res) return { error: "Crackio didn't answer." };
  const data = (await res.json().catch(() => ({}))) as { error?: string; results?: { error?: string }[] };
  return res.ok ? data : { error: data.error ?? "That didn't work." };
}

/**
 * Download a LoRA to these machines and switch it on for the model (at its own strength); a file that's already there
 * just switches on. Returns what went wrong, if anything.
 */
export async function addLora(model: LocalModel, entry: LoraEntry, targets: TargetStatus[], file?: LoraFile): Promise<string | null> {
  if (!model.crackio) return "This model can't take LoRAs yet.";
  const body = entry.found ? { action: "install", model: model.id, repo: entry.repo, path: (file ?? entry.files[0])?.path, targets: targets.map((t) => t.id) } : { action: "install", model: model.id, id: entry.id, targets: targets.map((t) => t.id) };
  if (!targets.length) return "Connect a machine with ComfyUI first (Local page).";
  const out = await post(body);
  if ("error" in out && out.error) return out.error;
  const names = ((out as { files?: string[] }).files ?? entryFiles(entry)).slice(0, 6);
  for (const name of names) if (!isOn(model.crackio, name)) setLora(model.crackio, name, entry.strength);
  loadLoraLibrary(true);
  await reloadLocal();
  const failed = (out as { results?: { error?: string }[] }).results?.find((r) => r.error)?.error;
  return failed ?? null;
}

export async function deleteLoraFile(file: string, target: TargetStatus): Promise<string | null> {
  const out = await post({ action: "remove", file, target: target.id });
  await reloadLocal();
  return "error" in out && out.error ? out.error : null;
}

export const isOn = (crackio: string, file: string) => (useModelLoras.getState().byModel[crackio] ?? []).some((l) => l.file === file);

/** LoRAs on Hugging Face made for a model, or matching words (the server filters adult, real people and IP out). */
export async function searchLoras(model: LocalModel, query: string, sort: "downloads" | "likes" | "trendingScore"): Promise<{ entries: LoraEntry[]; error?: string }> {
  const res = await fetch(`/api/local/loras/hub?model=${encodeURIComponent(model.id)}&sort=${sort}&q=${encodeURIComponent(query)}`, { cache: "no-store" }).catch(() => null);
  if (!res) return { entries: [], error: "Crackio didn't answer." };
  const body = (await res.json().catch(() => ({}))) as { entries?: LoraEntry[]; error?: string };
  return res.ok ? { entries: body.entries ?? [] } : { entries: [], error: body.error ?? "The search didn't work." };
}

/** A repo's LoRA files (.safetensors only), to pick one of several. */
export async function repoLoraFiles(repo: string): Promise<{ files: LoraFile[]; revision?: string; gated?: boolean; trigger?: string; error?: string }> {
  const res = await fetch(`/api/local/loras/hub?repo=${encodeURIComponent(repo)}`, { cache: "no-store" }).catch(() => null);
  if (!res) return { files: [], error: "Crackio didn't answer." };
  const body = (await res.json().catch(() => ({}))) as { files?: LoraFile[]; revision?: string; gated?: boolean; trigger?: string; error?: string };
  return res.ok ? { files: body.files ?? [], revision: body.revision, gated: body.gated, trigger: body.trigger } : { files: [], error: body.error ?? "Couldn't read that repo." };
}
