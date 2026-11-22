"use client";

import { create } from "zustand";
import { installedVariant } from "@/lib/local/rows";
import { loraFileName, type LoraBrowse, type LoraEntry, type LoraFile, type LoraLibrary, type LoraRecord } from "@/lib/local/loras";
import type { Download, LocalModel, LocalStatus, TargetStatus } from "@/lib/local/types";
import { reloadLocal } from "./use-local";
import { MAX_LORAS, setLora, useModelLoras } from "./use-model-loras";

/**
 * The LoRA library on the pages (api/local/loras): Crackio's picks for each model, what each downloaded file is, the
 * downloads and switches. Shared by the model library and the Local page: a download started in one shows in the other,
 * through the machines' downloads the local store polls.
 */

type State = { library: LoraLibrary | null; error: string | null };

export const useLoraLibrary = create<State>(() => ({ library: null, error: null }));

let asked = false;
/** The library's ETag as it last came: asked again (after an install), an unchanged library is an empty 304. */
let tag: string | null = null;

/** Load the library once a page (again with `force`, after a download records a new file). */
export function loadLoraLibrary(force = false) {
  if (asked && !force) return;
  asked = true;
  const held = useLoraLibrary.getState().library;
  void fetch("/api/local/loras/library", { cache: "no-store", headers: held && tag ? { "If-None-Match": tag } : undefined })
    .then(async (res) => {
      if (res.status === 304 && held) return;
      const body = (await res.json().catch(() => ({}))) as LoraLibrary & { error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      tag = res.headers.get("etag");
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
  // Comfy Cloud keeps its own model library: nothing of yours goes there (RunPod Serverless takes them on its volume).
  const online = onlineTargets(status).filter((t) => t.id !== "comfy-cloud");
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
export function recordEntry(r: LoraRecord, halves: LoraRecord[] = []): LoraEntry {
  const all = [r, ...halves];
  return {
    // One per file: two files of a repo, or a pick's old file beside the pick, never share an id. (A Wan 2.2 pair's two
    // halves are one LoRA: one entry, under its first file's name.)
    id: `file:${r.file}`,
    name: r.name,
    models: r.models,
    repo: r.repo,
    files: all.map((x) => ({ path: x.path, bytes: x.bytes, ...(x.match ? { match: x.match } : {}) })),
    category: r.category,
    blurb: "",
    ...(r.trigger ? { trigger: r.trigger } : {}),
    strength: r.strength,
    range: r.range,
    licence: r.licence,
    author: r.trained || r.uploaded ? "You" : r.repo.split("/")[0],
    found: true,
    local: all.map((x) => x.file),
    ...(r.trained ? { trained: r.trained } : {}),
    ...(r.uploaded ? { uploaded: r.uploaded } : {}),
    ...(r.triggerAt ? { triggerAt: r.triggerAt } : {}),
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
  const mine = Object.values(library.records).filter((r) => r.models.includes(model.id) && !pickFiles.has(r.file));
  // A pair's other half is listed with its first file (by name), not by itself.
  const second = new Set(mine.flatMap((r) => (r.pair ?? []).filter((f) => f > r.file && mine.some((x) => x.file === f))));
  const found = mine
    .filter((r) => !second.has(r.file))
    // An uploaded file carries what its check said for this model.
    .map((r) => ({
      ...recordEntry(
        r,
        mine.filter((x) => second.has(x.file) && r.pair?.includes(x.file)),
      ),
      ...(r.warn?.[model.id] ? { warning: r.warn[model.id] } : {}),
      ...(r.fits?.includes(model.id) ? { fits: true } : {}),
    }));
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
  // A find: the file named, else (a find straight off the listing has none yet) the one Crackio picks from its repo.
  const path = file?.path ?? (entry.files.length === 1 ? entry.files[0].path : undefined);
  const body = entry.found ? { action: "install", model: model.id, repo: entry.repo, ...(path ? { path } : {}), targets: targets.map((t) => t.id) } : { action: "install", model: model.id, id: entry.id, targets: targets.map((t) => t.id) };
  if (!targets.length) return "Connect a machine with ComfyUI first (Settings → Machines).";
  const out = await post(body);
  if ("error" in out && out.error) return out.error;
  const names = ((out as { files?: string[] }).files ?? entryFiles(entry)).slice(0, 6);
  for (const name of names) if (!isOn(model.crackio, name)) setLora(model.crackio, name, entry.strength);
  loadLoraLibrary(true);
  await reloadLocal();
  const failed = (out as { results?: { error?: string }[] }).results?.find((r) => r.error)?.error;
  return failed ?? null;
}

/* ------------------------------------------------------------------ your own files */

/** A file on its way from your browser to Crackio, then to machines. */
export type LoraUpload = { id: string; model: string; name: string; bytes: number; share: number; stage: "uploading" | "checking" | "sending" | "error"; error?: string; file?: string };

/** A LoRA file on its way from Crackio to a machine (server/lora-home `loraSends`). */
export type LoraSend = { file: string; name: string; target: string; label: string; share: number; state: "sending" | "done" | "error"; error?: string; at: number; bytes?: number; slow?: boolean; metered?: boolean };

/** A file on its way to a machine, stopped. */
export async function stopLoraSend(file: string, target: string) {
  await post({ action: "stop-send", file, target });
  void loadLoraSends();
}

export const useLoraTransfers = create<{ uploads: LoraUpload[]; sends: LoraSend[] }>(() => ({ uploads: [], sends: [] }));

const setUpload = (id: string, change: Partial<LoraUpload> | null) =>
  useLoraTransfers.setState((s) => ({ uploads: change === null ? s.uploads.filter((u) => u.id !== id) : s.uploads.map((u) => (u.id === id ? { ...u, ...change } : u)) }));

/** A failed upload's line, closed. */
export const dismissUpload = (id: string) => setUpload(id, null);

const cancelled = new Set<string>();
/** An upload stopped half-way: nothing more is sent, and what arrived is cleared. */
export function cancelUpload(id: string) {
  cancelled.add(id);
  setUpload(id, null);
  void fetch(`/api/local/loras/upload?id=${id}`, { method: "DELETE" }).catch(() => null);
}

/** The files travelling to machines right now (a model's LoRAs page asks every few seconds while it's open). */
export async function loadLoraSends() {
  const res = await fetch("/api/local/loras/upload", { cache: "no-store" }).catch(() => null);
  if (!res?.ok) return;
  const body = (await res.json().catch(() => ({}))) as { sends?: LoraSend[] };
  const sends = body.sends ?? [];
  const had = useLoraTransfers.getState().sends;
  if (JSON.stringify(had) !== JSON.stringify(sends)) useLoraTransfers.setState({ sends });
  // One that just arrived: the machines' file lists are read again.
  if (had.some((h) => h.state === "sending" && sends.some((s) => s.file === h.file && s.target === h.target && s.state === "done"))) void reloadLocal();
}

/** A piece small enough to send again cheaply when the connection blinks, big enough that a file is a few requests. */
const PIECE = 16 * 1024 * 1024;

/**
 * Upload a .safetensors LoRA from your computer for a model: Crackio keeps it, checks it (a real LoRA, one this model's
 * loader reads), switches it on for the model and sends it to the machines the model is on. Its line shows on the page
 * while it travels (`useLoraTransfers`). Returns the file's name in models/loras, or null when it failed (the line says why).
 */
export async function uploadLora(model: LocalModel, file: File, targets: TargetStatus[], onKept?: (file: string, record?: LoraRecord) => void): Promise<string | null> {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const mine: LoraUpload = { id, model: model.id, name: file.name, bytes: file.size, share: 0, stage: "uploading" };
  useLoraTransfers.setState((s) => ({ uploads: [...s.uploads, mine] }));
  const fail = (error: string) => (setUpload(id, { stage: "error", error }), null);
  if (!model.crackio) return fail("This model can't take LoRAs yet.");
  if (!/\.safetensors$/i.test(file.name)) return fail("Crackio takes .safetensors LoRA files only: other formats (.pt, .ckpt, .bin) can run code when they're loaded.");
  const query = (offset: number) => new URLSearchParams({ id, name: file.name, total: String(file.size), offset: String(offset), model: model.id });
  type Answer = { have?: number; done?: boolean; file?: string; record?: LoraRecord; error?: string };
  let done: Answer | null = null;
  let tries = 0;
  let restarts = 0;
  for (let offset = 0; !done; ) {
    if (cancelled.has(id)) return null;
    // The piece is read into memory, then sent. Sent as a slice of the file itself, Safari (26.5, Nov 2026) got the
    // answer's first line and never the rest: the upload stood at 0% for good, with the first piece already here.
    // Measured on a Mac with a 153 MB LoRA: five of five slices hung, the same bytes from memory took 0.3 s.
    const piece = await file.slice(offset, offset + PIECE).arrayBuffer().catch(() => null);
    if (!piece) return fail("This browser couldn't read the file. Is it still where it was?");
    const res = await fetch(`/api/local/loras/upload?${query(offset)}`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: piece }).catch(() => null);
    const body = res ? ((await res.json().catch(() => ({}))) as Answer) : {};
    if (!res || res.status >= 500) {
      // The connection blinked: the same piece again, a few times.
      if (++tries > 4) {
        void fetch(`/api/local/loras/upload?id=${id}`, { method: "DELETE" }).catch(() => null);
        return fail(body.error ?? "The upload stopped: Crackio didn't answer. Try again.");
      }
      await new Promise((r) => setTimeout(r, 800 * tries));
      continue;
    }
    if (!res.ok) return fail(body.error ?? "Crackio didn't take that file.");
    tries = 0;
    if (cancelled.has(id)) return null;
    if (body.done) done = body;
    else {
      // Crackio has less of the file than was sent: it couldn't keep it (its drive, most often). Sent from the start
      // again a couple of times, not for ever.
      if (body.have !== undefined && body.have < offset && ++restarts > 2) {
        void fetch(`/api/local/loras/upload?id=${id}`, { method: "DELETE" }).catch(() => null);
        return fail("Crackio couldn't keep the file (is this computer's drive full?). Try again.");
      }
      offset = body.have ?? offset + PIECE;
      setUpload(id, { share: offset / file.size, stage: offset >= file.size - PIECE ? "checking" : "uploading" });
    }
  }
  const name = done.file!;
  const strength = done.record?.strength ?? 1;
  onKept?.(name, done.record);
  if (!isOn(model.crackio, name)) {
    if ((useModelLoras.getState().byModel[model.crackio] ?? []).length < MAX_LORAS) setLora(model.crackio, name, strength);
  }
  loadLoraLibrary(true);
  // To the machines that answer and lack it; one that's off gets it before its first job with it, and so does one
  // billed per job (a RunPod endpoint: sending there runs a paid job, so it waits for a job of yours or your click).
  const lacking = targets.filter((t) => t.connected && !t.metered && !t.installed.includes(`loras/${name}`));
  if (lacking.length) {
    setUpload(id, { stage: "sending", share: 1, file: name });
    const poll = setInterval(() => void loadLoraSends(), 1500);
    const problem = await sendHomeLora(name, lacking);
    clearInterval(poll);
    void loadLoraSends();
    if (problem) {
      // Kept here, not sent: said on its line (it used to vanish as if it had arrived).
      setUpload(id, { stage: "error", error: `It's kept on this computer, but sending it didn't work: ${problem} It goes to a machine before the first job that uses it there.` });
      await reloadLocal();
      return name;
    }
  }
  setUpload(id, null);
  await reloadLocal();
  return name;
}

/** A LoRA Crackio keeps a copy of (uploaded, or trained here), sent to machines that don't have it yet. */
export async function sendHomeLora(file: string, targets: TargetStatus[]): Promise<string | null> {
  const out = await post({ action: "send", file, targets: targets.map((t) => t.id) });
  await reloadLocal();
  if ("error" in out && out.error) return out.error;
  return (out as { results?: { error?: string }[] }).results?.find((r) => r.error)?.error ?? null;
}

/** Your words for an uploaded LoRA: its name, its trigger words and where they go. */
export async function editUploadedLora(file: string, patch: { name?: string; trigger?: string; triggerAt?: "start" | "end" }): Promise<string | null> {
  const out = await post({ action: "edit", file, ...patch });
  loadLoraLibrary(true);
  return "error" in out && out.error ? out.error : null;
}

/** An uploaded LoRA deleted everywhere: Crackio's copy and the file on every machine that answers. */
export async function forgetUploadedLora(file: string): Promise<string | null> {
  const out = await post({ action: "forget", file });
  loadLoraLibrary(true);
  await reloadLocal();
  return "error" in out && out.error ? out.error : null;
}

/** A LoRA trained on the Train page, sent from Crackio's own copy to machines that don't have it yet. */
export async function sendTrainedLora(job: string, targets: TargetStatus[]): Promise<string | null> {
  let failed: string | null = null;
  for (const t of targets) {
    const res = await fetch(`/api/train/${job}/run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "send", machine: t.id }) }).catch(() => null);
    const body = res ? ((await res.json().catch(() => ({}))) as { error?: string }) : { error: "Crackio didn't answer." };
    if (!res?.ok) failed = body.error ?? "That didn't work.";
  }
  await reloadLocal();
  return failed;
}

export async function deleteLoraFile(file: string, target: TargetStatus): Promise<string | null> {
  const out = await post({ action: "remove", file, target: target.id });
  await reloadLocal();
  return "error" in out && out.error ? out.error : null;
}

export const isOn = (crackio: string, file: string) => (useModelLoras.getState().byModel[crackio] ?? []).some((l) => l.file === file);

export type LoraSort = "downloads" | "likes" | "new";

/** A model's listing, kept for the page's life: coming back to a model, or to an order, shows it at once. */
const browsed = new Map<string, Promise<LoraBrowse & { error?: string }>>();

/**
 * Every LoRA on Hugging Face made for a model that the library shows, most popular first (the server leaves adult,
 * real-people and branded ones out, and without words lists only the ones whose example was looked at); with words,
 * everything that matches them. `counts`: the picks' numbers as they are today.
 */
export function browseLoras(model: LocalModel, query: string, sort: LoraSort): Promise<LoraBrowse & { error?: string }> {
  const key = `${model.id}|${sort}|${query.trim().toLowerCase()}`;
  let hit = browsed.get(key);
  if (!hit) {
    hit = (async () => {
      const res = await fetch(`/api/local/loras/hub?model=${encodeURIComponent(model.id)}&sort=${sort}&q=${encodeURIComponent(query.trim())}`, { cache: "no-store" }).catch(() => null);
      const body = res ? ((await res.json().catch(() => ({}))) as Partial<LoraBrowse> & { error?: string }) : {};
      if (!res?.ok) {
        // A failed look isn't kept: the next ask tries again.
        browsed.delete(key);
        return { entries: [], counts: {}, error: body.error ?? (res ? "The search didn't work." : "Crackio didn't answer.") };
      }
      return { entries: body.entries ?? [], counts: body.counts ?? {} };
    })();
    browsed.set(key, hit);
    if (browsed.size > 60) browsed.delete(browsed.keys().next().value!);
  }
  return hit;
}

/** Whether you may download a LoRA whose makers ask you to accept their terms on Hugging Face first (server/loras `loraAccess`). */
export type LoraAccess = "open" | "granted" | "needed" | "no-token";
const accessAsked = new Map<string, { at: number; value: Promise<LoraAccess | null> }>();
/**
 * Asked of Hugging Face with your token, by the LoRA's repo. Kept for a few seconds here (a page of cards asks once);
 * `again` asks anew: you just came back from accepting its terms.
 */
export function loraAccess(entry: LoraEntry, again = false): Promise<LoraAccess | null> {
  const hit = accessAsked.get(entry.repo);
  if (hit && !again && Date.now() - hit.at < 15_000) return hit.value;
  const pick = !entry.found && entry.files[0] ? `&rev=${encodeURIComponent(entry.revision ?? "main")}&path=${encodeURIComponent(entry.files[0].path)}` : "";
  const value = fetch(`/api/local/loras/hub?access=${encodeURIComponent(entry.repo)}${pick}`, { cache: "no-store" })
    .then((res) => (res.ok ? (res.json() as Promise<{ access?: LoraAccess }>) : null))
    .then((body) => body?.access ?? null)
    .catch(() => null);
  accessAsked.set(entry.repo, { at: Date.now(), value });
  return value;
}

/** The searches kept in this browser are dropped (a choice that changes what they list was just saved). */
export function forgetLoraSearches() {
  browsed.clear();
  everywhere.clear();
}

const everywhere = new Map<string, Promise<LoraEntry[]>>();
/** The listed LoRAs of every other model that match the words (a search that isn't held to the model in view). */
export function searchOtherModels(query: string, except: LocalModel): Promise<LoraEntry[]> {
  const key = `${except.id}|${query.trim().toLowerCase()}`;
  let hit = everywhere.get(key);
  if (!hit) {
    hit = fetch(`/api/local/loras/hub?everywhere=1&except=${encodeURIComponent(except.id)}&q=${encodeURIComponent(query.trim())}`, { cache: "no-store" })
      .then((res) => (res.ok ? (res.json() as Promise<{ entries?: LoraEntry[] }>) : { entries: [] }))
      .then((body) => body.entries ?? [])
      .catch(() => {
        everywhere.delete(key);
        return [];
      });
    everywhere.set(key, hit);
    if (everywhere.size > 60) everywhere.delete(everywhere.keys().next().value!);
  }
  return hit;
}

/** What a find's repo holds: its LoRA files, the one (or the pair) Crackio gets for this model, and what its card says. */
export type RepoInfo = { files: LoraFile[]; pick: string[]; about: string | null; trigger?: string; gated?: boolean; error?: string };
const repos = new Map<string, Promise<RepoInfo>>();

export function repoLoraInfo(repo: string, model: LocalModel): Promise<RepoInfo> {
  const key = `${repo}|${model.id}`;
  let hit = repos.get(key);
  if (!hit) {
    hit = (async () => {
      const res = await fetch(`/api/local/loras/hub?repo=${encodeURIComponent(repo)}&model=${encodeURIComponent(model.id)}`, { cache: "no-store" }).catch(() => null);
      const body = res ? ((await res.json().catch(() => ({}))) as Partial<RepoInfo>) : {};
      if (!res?.ok) {
        repos.delete(key);
        return { files: [], pick: [], about: null, error: body.error ?? (res ? "Couldn't read that repo." : "Crackio didn't answer.") };
      }
      return { files: body.files ?? [], pick: body.pick ?? [], about: body.about ?? null, trigger: body.trigger, gated: body.gated };
    })();
    repos.set(key, hit);
    if (repos.size > 200) repos.delete(repos.keys().next().value!);
  }
  return hit;
}
