"use client";

import { useEffect } from "react";
import { create } from "zustand";
import type { TrainOptions } from "@/lib/server/train/options";
import { isActive, type LogLine, type TrainBase, type TrainGoal, type TrainJob, type TrainSettings, type TrainSummary, type SettingKey } from "@/lib/train/types";

/**
 * The Train page's data: the list of LoRAs, the one that's open (with its log while it runs), and what it could train on
 * and where (api/train). The open job is looked at every 1.5 s while it runs, the list every 5 s while anything runs;
 * nothing is asked while the tab is hidden.
 */

type ListState = { jobs: TrainSummary[] | null; error: string | null };
export const useTrainList = create<ListState>(() => ({ jobs: null, error: null }));

export async function loadTrainList() {
  try {
    const res = await fetch("/api/train", { cache: "no-store" });
    const body = (await res.json()) as { jobs?: TrainSummary[]; error?: string };
    if (!res.ok || !body.jobs) throw new Error(body.error ?? `HTTP ${res.status}`);
    useTrainList.setState({ jobs: body.jobs, error: null });
  } catch (err) {
    useTrainList.setState((s) => ({ jobs: s.jobs, error: (err as Error).message }));
  }
}

/** Keeps the list fresh while the page shows it. */
export function useTrainJobs() {
  const { jobs, error } = useTrainList();
  const busy = Boolean(jobs?.some((j) => isActive(j.state)));
  useEffect(() => {
    void loadTrainList();
    const t = setInterval(() => {
      if (!document.hidden) void loadTrainList();
    }, busy ? 5000 : 30_000);
    return () => clearInterval(t);
  }, [busy]);
  return { jobs, error };
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: "no-store", ...init, headers: init?.body && !(init.body instanceof FormData) ? { "Content-Type": "application/json", ...init.headers } : init?.headers }).catch(() => null);
  if (!res) throw new Error("Crackio didn't answer.");
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `That didn't work (${res.status}).`);
  return body;
}

export async function createTrainJob(init: { name?: string; goal?: TrainGoal } = {}): Promise<TrainJob> {
  const { job } = await api<{ job: TrainJob }>("/api/train", { method: "POST", body: JSON.stringify(init) });
  void loadTrainList();
  return job;
}

export async function deleteTrainJob(id: string, alsoLora: boolean) {
  await api(`/api/train/${id}${alsoLora ? "?lora=1" : ""}`, { method: "DELETE" });
  await loadTrainList();
}

export type TrainPatch = {
  name?: string;
  goal?: TrainGoal;
  trigger?: string;
  noun?: string;
  instruction?: string;
  base?: TrainBase | null;
  machine?: string | null;
  settings?: Partial<TrainSettings>;
  auto?: SettingKey[];
  testPrompts?: string[];
  captions?: { id: string; caption: string }[];
  skip?: { id: string; skip: boolean }[];
};

export type Upload = { done: number; total: number; refused: { name: string; why: string }[] } | null;
export type RunAction = "start" | "pause" | "finish" | "use-version" | "move" | "keep-versions" | "edit-setup";

/* ------------------------------------------------------------------ the open job */

type View = {
  /** The job that's open (the address's `?job=`). */
  id: string | null;
  job: TrainJob | null;
  log: LogLine[];
  options: TrainOptions | null;
  error: string | null;
  upload: Upload;
  /** The action in flight ("start", "pause"…), for its button's spinner. */
  working: string | null;
  /** It was deleted somewhere else while it was open here. */
  gone?: boolean;
};

const empty = (id: string | null): View => ({ id, job: null, log: [], options: null, error: null, upload: null, working: null });
const useView = create<View>(() => empty(null));
/** The last log line this page holds; asked for the ones after it. */
let seq = 0;
let optionsTimer: ReturnType<typeof setTimeout> | null = null;

const at = (id: string) => useView.getState().id === id;
const put = (id: string, patch: Partial<View>) => at(id) && useView.setState(patch);

async function look(id: string, fresh = false) {
  try {
    const body = await api<{ job: TrainJob; log: LogLine[] }>(`/api/train/${id}?from=${fresh ? 0 : seq}`);
    if (!at(id)) return;
    if (body.log.length) seq = body.log.at(-1)![0];
    useView.setState((s) => ({ job: body.job, error: null, log: fresh ? body.log : body.log.length ? [...s.log, ...body.log].slice(-600) : s.log }));
  } catch (err) {
    // Deleted meanwhile (in another tab): it closes here too, and the list drops it.
    if ((err as Error).message === "No such LoRA." && at(id)) {
      useView.setState({ ...empty(id), gone: true });
      void loadTrainList();
      return;
    }
    put(id, { error: (err as Error).message });
  }
}

async function loadOptions(id: string) {
  try {
    const options = await api<TrainOptions>(`/api/train/${id}/options`);
    put(id, { options });
  } catch {
    // The page still works on Crackio's own picks; they're asked for again every little while a draft is open.
  }
}

/** Options asked again a moment after a change (several quick changes ask once). */
function refreshOptions() {
  if (optionsTimer) clearTimeout(optionsTimer);
  optionsTimer = setTimeout(() => {
    const { id } = useView.getState();
    if (id) void loadOptions(id);
  }, 350);
}

/** Opens a job: everything about the last one goes, this one is fetched from the start. */
function openJob(id: string | null) {
  if (useView.getState().id === id) return;
  seq = 0;
  useView.setState(empty(id));
  if (!id) return;
  void look(id, true);
  void loadOptions(id);
}

/** A change shows at once and is sent after; the answer (the job as the server holds it) replaces it. */
async function patch(p: TrainPatch) {
  const { id, job: had } = useView.getState();
  if (!id || !had) return;
  const next: TrainJob = { ...had, ...(p.name !== undefined ? { name: p.name } : {}), ...(p.goal ? { goal: p.goal } : {}), ...(p.trigger !== undefined ? { trigger: p.trigger } : {}), ...(p.noun !== undefined ? { noun: p.noun } : {}), ...(p.instruction !== undefined ? { instruction: p.instruction } : {}) };
  if (p.base !== undefined) next.base = p.base;
  if (p.machine !== undefined) next.machine = p.machine;
  if (p.settings) {
    next.settings = { ...had.settings, ...p.settings };
    next.auto = had.auto.filter((k) => !(k in p.settings!));
  }
  if (p.auto) next.auto = [...new Set([...next.auto, ...p.auto])];
  if (p.testPrompts) next.testPrompts = p.testPrompts;
  useView.setState({ job: next });
  try {
    const body = await api<{ job: TrainJob }>(`/api/train/${id}`, { method: "PATCH", body: JSON.stringify(p) });
    put(id, { job: body.job, error: null });
    refreshOptions();
    if (p.name !== undefined || p.goal) void loadTrainList();
  } catch (err) {
    put(id, { error: (err as Error).message });
    void look(id);
  }
}

/**
 * Pictures go up a few at a time: a 200-picture set arrives in pieces, each shown as it lands. `as`: an edit LoRA's
 * before pictures (pictures whose names say which side of a pair they are go there by themselves).
 */
async function addImages(files: File[], as?: "before") {
  const { id } = useView.getState();
  if (!id || !files.length) return;
  const pictures = files.filter((f) => f.type.startsWith("image/") || /\.(jpe?g|png|webp|avif|heic|tiff?|bmp)$/i.test(f.name));
  const refused: { name: string; why: string }[] = files.filter((f) => !pictures.includes(f)).map((f) => ({ name: f.name, why: "Not a picture." }));
  put(id, { upload: { done: 0, total: pictures.length, refused } });
  // (It goes on when another LoRA is opened meanwhile: what's shown is this one's only while it's the open one.)
  for (let i = 0; i < pictures.length; i += 6) {
    const form = new FormData();
    for (const f of pictures.slice(i, i + 6)) form.append("file", f);
    try {
      const body = await api<{ job: TrainJob; refused: { name: string; why: string }[] }>(`/api/train/${id}/images${as ? "?as=before" : ""}`, { method: "POST", body: form });
      put(id, { job: body.job });
      refused.push(...body.refused);
    } catch (err) {
      refused.push({ name: `${pictures.slice(i, i + 6).length} pictures`, why: (err as Error).message });
    }
    put(id, { upload: { done: Math.min(pictures.length, i + 6), total: pictures.length, refused: [...refused] } });
  }
  put(id, { upload: refused.length ? { done: pictures.length, total: pictures.length, refused } : null });
  refreshOptions();
  void loadTrainList();
}

async function removeImages(ids: string[]) {
  const { id, job: had } = useView.getState();
  if (!id || !had) return;
  useView.setState({ job: { ...had, images: had.images.filter((i) => !ids.includes(i.id)) } });
  try {
    const body = await api<{ job: TrainJob }>(`/api/train/${id}/images`, { method: "DELETE", body: JSON.stringify({ ids }) });
    put(id, { job: body.job });
    refreshOptions();
    void loadTrainList();
  } catch (err) {
    put(id, { error: (err as Error).message });
    void look(id);
  }
}

/** Takes the before picture off some of an edit LoRA's pairs. */
async function removeBefore(ids: string[]) {
  const { id } = useView.getState();
  if (!id) return;
  try {
    const body = await api<{ job: TrainJob }>(`/api/train/${id}/images`, { method: "DELETE", body: JSON.stringify({ ids, before: true }) });
    put(id, { job: body.job });
    refreshOptions();
  } catch (err) {
    put(id, { error: (err as Error).message });
    void look(id);
  }
}

async function run(action: RunAction, step?: number, machine?: string) {
  const { id } = useView.getState();
  if (!id) return;
  put(id, { working: action });
  try {
    const body = await api<{ job: TrainJob }>(`/api/train/${id}/run`, { method: "POST", body: JSON.stringify(action === "use-version" ? { action, step } : action === "move" ? { action, machine } : { action }) });
    put(id, { job: body.job, error: null });
    void loadTrainList();
  } catch (err) {
    put(id, { error: (err as Error).message });
  } finally {
    put(id, { working: null });
  }
}

const clearUpload = () => useView.setState({ upload: null });
const dismissError = () => useView.setState({ error: null });

/** One job, live: the job, its log, its options, and the things you can do to it. */
export function useTrainJob(id: string | null) {
  const view = useView();
  // The job in the address is the one that's open; a render with another one's data shows nothing of it.
  useEffect(() => openJob(id), [id]);
  const mine = view.id === id;
  const job = mine ? view.job : null;
  const active = job ? isActive(job.state) : false;
  useEffect(() => {
    if (!id) return;
    const t = setInterval(() => {
      if (document.hidden) return;
      void look(id);
      // A draft's machines and models are asked again too: a rented GPU that finished starting stayed "Off" (and
      // couldn't be picked) for as long as the page was open.
      if (!active && useView.getState().job?.state !== "done") void loadOptions(id);
    }, active ? 1500 : 20_000);
    return () => clearInterval(t);
  }, [id, active]);
  // A run that ended (or began): the list and the options follow.
  const state = job?.state;
  useEffect(() => {
    if (!id || !state) return;
    void loadTrainList();
    if (!active) refreshOptions();
  }, [id, active, state]);
  return {
    job,
    log: mine ? view.log : [],
    options: mine ? view.options : null,
    error: mine ? view.error : null,
    upload: mine ? view.upload : null,
    working: mine ? view.working : null,
    gone: mine ? Boolean(view.gone) : false,
    patch,
    addImages,
    removeImages,
    removeBefore,
    run,
    clearUpload,
    dismissError,
  };
}
