"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { motion } from "motion/react";
import { create } from "zustand";
import { Check, ChevronDown, Clapperboard, CloudOff, Download, Film, LoaderCircle, Plus, Scissors, Trash2 } from "lucide-react";
import { useEditProjects } from "@/lib/hooks/use-edit-projects";
import { flushSaves, queueSave, useEditor } from "@/lib/storyboard/edit-store";
import { FPS, filmLength, timecode, type EditFile, type EditMode, type EditProject, type EditTimeline } from "@/lib/storyboard/edit";
import { becomeClip, patchClip, replaceClip } from "@/lib/storyboard/edit-ops";
import { useGenerations, useSubmitTags } from "@/lib/hooks/use-generations";
import type { Generation } from "@/lib/generations/types";
import { emptyScene, useDirector } from "@/lib/director/store";
import { room } from "@/lib/director/room";
import type { Scene } from "@/lib/director/types";
import { useTakesFrom } from "@/components/director/Takes";
import { useTakeView } from "@/components/director/take-view";
import { useLocation } from "@/components/director/location";
import { useAround, useWorld } from "@/components/director/around";
import { useLift } from "@/components/director/lift";
import { useExtend } from "@/components/director/extend";
import { Popover } from "@/components/ui/Popover";
import { ProjectIcon } from "@/components/library/ProjectIcon";
import { previewUrl, posterUrl } from "@/lib/media-url";
import { Monitor } from "./edit/Monitor";
import { Timeline, cut } from "./edit/Timeline";
import { Files, isFilm } from "./edit/Files";
import { MakeClip } from "./edit/MakeClip";
import { useProjectFiles } from "./edit/project-files";
import { film } from "./edit/film";
import { usePlayhead } from "./edit/engine";
import { isExporting, useExport } from "./edit/exporting";
import { cn } from "@/lib/cn";

const DirectorWorkspace = dynamic(() => import("@/components/director/DirectorWorkspace").then((m) => m.DirectorWorkspace), {
  ssr: false,
  loading: () => (
    <div className="grid grid-cols-1 gap-3 p-3 sm:p-4 lg:h-full lg:grid-cols-[300px_minmax(0,1fr)_330px] lg:py-4">
      <div className="skeleton hidden rounded-panel lg:block" />
      <div className="skeleton h-[60vh] rounded-panel lg:h-auto" />
      <div className="skeleton hidden rounded-panel lg:block" />
    </div>
  ),
});

/**
 * The Editor's two columns: the screen and the timeline, and the files beside them. The files column is as wide as the
 * Director's right panel, so switching modes keeps the right edge where it was.
 */
function Frame({ main, side }: { main: React.ReactNode; side: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-3 p-3 sm:p-4 lg:h-full lg:grid-cols-[minmax(0,1fr)_330px] lg:py-4">
      <div className="flex min-h-0 flex-col gap-3">{main}</div>
      <aside aria-label="Files" className="flex min-h-0 flex-col gap-3">
        {side}
      </aside>
    </div>
  );
}

/**
 * Storyboard: a film made at home. Each project is a folder of everything made for it, with two modes over the same
 * frame: the Director (the set, the cast and the camera; every shot lands in the project) and the Editor (the shots on
 * a timeline, cut together, pictures made to move, one MP4 out). Every change is saved with the project.
 */
export function StoryboardApp() {
  const { items, loaded, current, load, create } = useEditProjects();
  const project = useEditor((s) => s.project);
  const [problem, setProblem] = useState<string | null>(null);
  const creating = useRef(false);

  useEffect(() => {
    void load().catch((err: Error) => setProblem(err.message));
  }, [load]);

  // A first visit starts a project: everything made here needs somewhere to go.
  useEffect(() => {
    if (!loaded || current || items.length || creating.current) return;
    creating.current = true;
    void create()
      .catch((err: Error) => setProblem(err.message))
      .finally(() => (creating.current = false));
  }, [loaded, current, items.length, create]);

  // The open project: the last one's changes saved first, then this one's timeline, files and set.
  useEffect(() => {
    if (!current) return;
    let alive = true;
    void (async () => {
      await flushSaves();
      const res = await fetch(`/api/storyboard/projects/${current}`, { cache: "no-store" });
      const data = (await res.json().catch(() => ({}))) as { project?: EditProject; error?: string };
      if (!alive) return;
      if (!res.ok || !data.project) {
        // Gone (its folder was deleted in the Library): on to another one.
        if (res.status === 404) return void load();
        return setProblem(data.error ?? "Couldn't open the project.");
      }
      film.pause();
      usePlayhead.setState({ t: 0, playing: false });
      useEditor.getState().open(data.project);
      if (data.project.mode === "direct") useDirectorSince.setState({ project: data.project.id, at: Date.now() });
      void useProjectFiles.getState().load(data.project.id);
      setProblem(null);
    })();
    return () => {
      alive = false;
    };
  }, [current, load]);

  useProjectTags(project?.id ?? null);
  useProjectScene(project);
  useMadeClips(project?.id ?? null);

  const mode: EditMode = project?.mode ?? "edit";
  const setMode = (m: EditMode) => {
    film.pause();
    if (m === "direct") useDirectorSince.setState({ project: project?.id ?? null, at: Date.now() });
    useEditor.getState().setMode(m);
  };

  return (
    <div className="flex flex-col lg:h-dvh">
      <TopBar mode={mode} onMode={setMode} />
      {problem ? <p className="mx-4 mt-3 rounded-[12px] bg-tally/10 px-3 py-2 text-[13px] text-tally">{problem}</p> : null}
      <div className="min-h-0 flex-1">
        {!project ? (
          <Frame main={<div className="skeleton h-[60vh] rounded-panel lg:h-full" />} side={<div className="skeleton h-full min-h-[200px] rounded-panel" />} />
        ) : mode === "direct" ? (
          <DirectorWorkspace className="lg:h-full" />
        ) : (
          <EditorMode projectId={project.id} onDirect={() => setMode("direct")} />
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ editor */

function EditorMode({ projectId, onDirect }: { projectId: string; onDirect: () => void }) {
  useEditorKeys();
  const upload = useProjectFiles((s) => s.upload);
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <Frame
        main={
          <>
            <Monitor onDirect={onDirect} onUpload={() => input.current?.click()} />
            <Timeline onDirect={onDirect} />
          </>
        }
        side={
          <>
            <Files projectId={projectId} onDirect={onDirect} />
            <MakeClip />
          </>
        }
      />
      <input
        ref={input}
        type="file"
        accept="image/*,video/*,audio/*"
        multiple
        hidden
        onChange={(e) => {
          void upload(Array.from(e.target.files ?? []));
          e.target.value = "";
        }}
      />
    </>
  );
}

/** Space plays, S splits, Delete deletes, the arrows step a frame (a second with Shift), Ctrl+Z undoes. */
function useEditorKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest("input, textarea, select, [contenteditable=true], [role=dialog], .model-library-root")) return;
      const s = useEditor.getState();
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      if (mod && key === "z") {
        e.preventDefault();
        return e.shiftKey ? s.redo() : s.undo();
      }
      if (mod && key === "y") {
        e.preventDefault();
        return s.redo();
      }
      if (mod && key === "d") {
        e.preventDefault();
        return cut.duplicate();
      }
      if (mod || e.altKey) return;
      if (e.key === " ") {
        e.preventDefault();
        // A focused button would press itself again on the key's release.
        (document.activeElement as HTMLElement | null)?.blur?.();
        return film.toggle();
      }
      if (key === "s") return cut.split();
      if ((e.key === "Delete" || e.key === "Backspace") && s.selected) {
        e.preventDefault();
        return cut.remove();
      }
      if (e.key === "Escape") {
        s.select(null);
        return s.setPick(null);
      }
      const t = usePlayhead.getState().t;
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        const step = e.shiftKey ? 1 : 1 / FPS;
        return film.seek(t + (e.key === "ArrowLeft" ? -step : step));
      }
      if (e.key === "Home") return film.seek(0);
      if (e.key === "End") return film.seek(filmLength(s.timeline));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/* ------------------------------------------------------------------ the project's ties */

/** Everything made while a project is open carries it, so the server files it into the project's folder. */
function useProjectTags(id: string | null) {
  useEffect(() => {
    if (!id) return;
    useSubmitTags.setState({ params: { project: id } });
    return () => useSubmitTags.setState({ params: {} });
  }, [id]);
}

/** The Director's own work in flight (a place being drawn, built, measured): switching projects waits for it. */
export function directorBusy() {
  return (
    useLocation.getState().busy ||
    useAround.getState().busy ||
    useWorld.getState().busy ||
    useWorld.getState().measuring ||
    Boolean(useLift.getState().busy) ||
    Boolean(useExtend.getState().stage)
  );
}

/**
 * While Storyboard is open, the Director's set is the open project's: it's saved with the project (never over
 * /director's own set, which comes back when you leave), and the Director shows only this project's takes.
 */
function useProjectScene(project: EditProject | null) {
  const owner = useRef<string | null>(null);
  useEffect(() => {
    const standalone = useDirector.getState().scene;
    useDirector.persist.setOptions({ name: "crackio-director:storyboard" });
    const unsubscribe = useDirector.subscribe((s, prev) => {
      if (s.scene !== prev.scene && owner.current) queueSave(owner.current, { scene: s.scene });
    });
    return () => {
      unsubscribe();
      owner.current = null;
      room.current = null;
      useTakesFrom.setState({ project: null });
      // /director's set as it's stored (another tab may have changed it meanwhile), else as it was when Storyboard opened.
      let scene = standalone;
      try {
        const stored = JSON.parse(localStorage.getItem("crackio-director") ?? "null") as { state?: { scene?: Scene } } | null;
        if (stored?.state?.scene?.camera) scene = stored.state.scene;
      } catch {
        /* no storage: the set it had */
      }
      // Back under its own name with its own set in one step: a save in between would put this project's set there.
      useDirector.persist.setOptions({ name: "crackio-director" });
      useDirector.setState({ scene, past: [], future: [], selectedId: null });
    };
  }, []);

  const id = project?.id;
  useEffect(() => {
    if (!project || !id) return;
    // Loading the set isn't a change to save.
    owner.current = null;
    const saved = project.scene as Scene | undefined;
    const scene = saved && Array.isArray(saved.elements) && saved.camera ? saved : { ...emptyScene(), aspect: project.aspect };
    room.current = null;
    useTakeView.setState({ viewing: null });
    useLocation.setState({ error: null });
    useAround.setState({ error: null });
    useWorld.setState({ error: null });
    useLift.setState({ error: null });
    useExtend.setState({ error: null });
    useDirector.setState({ scene, past: [], future: [], selectedId: null });
    owner.current = id;
    useTakesFrom.setState({ project: id });
    // Only when another project opens: the doc's own scene changes as you work.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
}

/**
 * A still being made into a clip on the timeline: when its clip is done it takes the still's place (and its file is in
 * the project); if it fails, the still stays as it was.
 */
function useMadeClips(projectId: string | null) {
  const making = useEditor((s) => s.timeline.main.flatMap((c) => (c.making ? [c.making] : [])).join(","));
  useEffect(() => {
    if (!making || !projectId) return;
    let stopped = false;
    const check = async () => {
      const ids = [...new Set(making.split(","))];
      const res = await fetch(`/api/generations?ids=${ids.join(",")}`, { cache: "no-store" }).catch(() => null);
      const data = (await res?.json().catch(() => null)) as { items?: Generation[] } | null;
      if (stopped || !data?.items || useEditor.getState().project?.id !== projectId) return;
      const found = new Map(data.items.map((g) => [g.id, g]));
      const { timeline, change } = useEditor.getState();
      let next = timeline;
      for (const c of timeline.main) {
        if (!c.making) continue;
        const g = found.get(c.making);
        if (g && (g.status === "queued" || g.status === "running")) continue;
        const index = g?.status === "done" ? g.outputs.findIndex((o) => o.kind === "video") : -1;
        const out = g && index >= 0 ? g.outputs[index] : null;
        if (g && out) {
          const file: EditFile = {
            key: `gen:${g.id}:${index}`,
            url: out.url,
            kind: "video",
            name: c.name ?? "Clip",
            width: out.width,
            height: out.height,
            duration: out.duration,
            gen: g.id,
            index,
            createdAt: g.finishedAt ?? g.createdAt,
          };
          next = replaceClip(next, c.id, becomeClip(c, file));
        } else next = patchClip(next, c.id, { making: undefined });
      }
      if (next !== timeline) {
        change(() => next);
        const settled = new Set(ids.filter((id) => !next.main.some((c) => c.making === id)));
        const plain = (t: EditTimeline) => (t.main.some((c) => c.making && settled.has(c.making)) ? { ...t, main: t.main.map((c) => (c.making && settled.has(c.making) ? { ...c, making: undefined } : c)) } : t);
        useEditor.setState((s) => ({ past: s.past.map(plain), future: s.future.map(plain) }));
        void useProjectFiles.getState().refresh();
      }
    };
    void check();
    const timer = setInterval(() => void check(), 2500);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [making, projectId]);
}

/* ------------------------------------------------------------------ top bar */

function TopBar({ mode, onMode }: { mode: EditMode; onMode: (m: EditMode) => void }) {
  return (
    <header className="relative flex flex-wrap items-center gap-2 px-3 pt-3 sm:px-4 lg:pt-4">
      <ProjectMenu />
      <div className="order-3 flex w-full justify-center lg:absolute lg:left-1/2 lg:top-4 lg:order-none lg:w-auto lg:-translate-x-1/2">
        <ModeSwitch mode={mode} onMode={onMode} />
      </div>
      <div className="ml-auto flex items-center justify-end gap-2">
        <SaveState />
        <ExportButton />
      </div>
    </header>
  );
}

const MODES: { id: EditMode; label: string; icon: typeof Film; title: string }[] = [
  { id: "edit", label: "Editor", icon: Scissors, title: "Cut your shots together on the timeline and make pictures move" },
  { id: "direct", label: "Director", icon: Clapperboard, title: "Build the place, stage the cast, light it and shoot: every shot lands in this project" },
];

/** When you went to the Director, for the count of what it made since. */
const useDirectorSince = create<{ project: string | null; at: number }>(() => ({ project: null, at: 0 }));

function ModeSwitch({ mode, onMode }: { mode: EditMode; onMode: (m: EditMode) => void }) {
  // Shots and clips of this project that finished while you were in the Director: they wait in the Editor's Files.
  const since = useDirectorSince();
  const project = useEditor((s) => s.project?.id ?? null);
  const items = useGenerations((s) => s.items);
  const fresh = mode === "direct" && since.project === project ? items.filter((g) => g.params?.project === project && g.status === "done" && (g.finishedAt ?? 0) > since.at).length : 0;
  return (
    <div role="radiogroup" aria-label="Mode" className="squircle flex h-10 rounded-[14px] bg-white/[0.04] p-1 shadow-[inset_0_0_0_1px_var(--color-line)]">
      {MODES.map((m) => {
        const on = mode === m.id;
        const Icon = m.icon;
        return (
          <button
            key={m.id}
            type="button"
            role="radio"
            aria-checked={on}
            title={m.title}
            onClick={() => onMode(m.id)}
            className={cn("press squircle relative inline-flex h-8 w-[124px] items-center justify-center gap-1.5 rounded-[10px] text-[13px] font-semibold", on ? "text-paper" : "text-fog hover:text-paper")}
          >
            {on ? (
              <motion.span
                layoutId="storyboard-mode"
                className="squircle absolute inset-0 rounded-[10px] bg-white/[0.12] shadow-[inset_0_1px_0_rgb(255_255_255/0.09),0_1px_2px_rgb(0_0_0/0.25)]"
                transition={{ type: "spring", bounce: 0.16, duration: 0.4 }}
              />
            ) : null}
            <Icon size={14} className={cn("relative", on && (m.id === "direct" ? "text-spike" : "text-tool-storyboard"))} />
            <span className="relative">{m.label}</span>
            {m.id === "edit" && fresh ? (
              <span className="tabular relative grid h-[18px] min-w-[18px] place-items-center rounded-full bg-spike px-1 text-[10.5px] font-bold text-spike-ink" title={`${fresh} new in Files`}>
                {fresh}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

function SaveState() {
  const saving = useEditor((s) => s.saving);
  const error = useEditor((s) => s.saveError);
  if (saving === "idle") return null;
  return (
    <span className={cn("hidden items-center gap-1 text-[12px] sm:inline-flex", saving === "error" ? "text-tally" : "text-haze")} title={error ?? undefined}>
      {saving === "saving" ? <LoaderCircle size={12} className="animate-spin" /> : saving === "error" ? <CloudOff size={12} /> : <Check size={12} />}
      {saving === "saving" ? "Saving" : saving === "error" ? "Not saved yet" : "Saved"}
    </span>
  );
}

/* ------------------------------------------------------------------ projects */

const ago = (t: number) => {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" });
};

function ProjectMenu() {
  const { items, current, open, create, remove } = useEditProjects();
  const project = useEditor((s) => s.project);
  const rename = useEditor((s) => s.rename);
  const [error, setError] = useState<string | null>(null);
  const [arming, setArming] = useState(false);
  const [name, setName] = useState("");

  const switchTo = async (go: () => void | Promise<unknown>, close: () => void) => {
    if (directorBusy()) return setError("The Director is still building this project's place: switch when it's done.");
    setError(null);
    film.pause();
    await flushSaves();
    await go();
    close();
  };

  return (
    <Popover
      placement="bottom-start"
      panelClassName="w-[340px] p-1.5"
      trigger={({ open: shown, toggle }) => (
        <button
          type="button"
          onClick={() => {
            setName(project?.name ?? "");
            setArming(false);
            setError(null);
            toggle();
          }}
          aria-expanded={shown}
          title="Your projects: each is a folder of everything made for it"
          className="press squircle flex h-10 min-w-0 max-w-[230px] items-center gap-2 rounded-[12px] bg-white/[0.04] pl-2 pr-2.5 shadow-[inset_0_0_0_1px_var(--color-line)] hover:bg-white/[0.07]"
        >
          {project ? <ProjectIcon icon={project.icon} color={project.color} size={24} tile /> : <span className="skeleton size-6 rounded-[8px]" />}
          <span className="min-w-0 truncate text-[13.5px] font-semibold">{project?.name ?? "Projects"}</span>
          <ChevronDown size={13} className="shrink-0 text-haze" />
        </button>
      )}
    >
      {(close) => (
        <div>
          {project ? (
            <form
              className="flex items-center gap-1.5 p-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                void rename(name)
                  .then(() => setError(null))
                  .catch((err: Error) => setError(err.message));
              }}
            >
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={() => name.trim() && name.trim() !== project.name && void rename(name).catch((err: Error) => setError(err.message))}
                aria-label="Project name"
                maxLength={26}
                className="field-focus h-9 min-w-0 flex-1 rounded-[10px] bg-white/[0.05] px-3 text-[13.5px] font-semibold text-paper outline-none"
              />
            </form>
          ) : null}
          {error ? <p className="px-2.5 pb-1.5 text-[12px] text-tally">{error}</p> : null}
          <div className="scroll-thin max-h-[360px] overflow-y-auto">
            {items.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => void switchTo(() => open(p.id), close)}
                className={cn(
                  "squircle flex w-full items-center gap-2.5 rounded-[14px] px-2 py-1.5 text-left transition-colors",
                  p.id === current ? "bg-gaffer text-paper" : "text-fog hover:bg-gaffer/60 hover:text-paper",
                )}
              >
                <span className="relative grid h-9 w-14 shrink-0 place-items-center overflow-hidden rounded-[8px] bg-apple">
                  {p.cover ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={/\.(mp4|webm|mov)$/i.test(p.cover) ? (posterUrl(p.cover, 160) ?? "") : previewUrl(p.cover, 160)} alt="" className="size-full object-cover" />
                  ) : (
                    <ProjectIcon icon={p.icon} color={p.color} size={16} />
                  )}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[13px] font-semibold">{p.name}</span>
                  <span className="tabular block truncate text-[11.5px] text-haze">
                    {p.clips ? `${p.clips} ${p.clips === 1 ? "piece" : "pieces"} · ${timecode(p.seconds, false)}` : "Empty"} · {ago(p.updatedAt)}
                  </span>
                </span>
              </button>
            ))}
          </div>
          <div className="mt-1 flex items-center gap-1 border-t border-white/[0.06] pt-1">
            <button
              type="button"
              onClick={() => void switchTo(() => create({ aspect: project?.aspect }), close).catch((err: Error) => setError(err.message))}
              className="press squircle flex h-9 flex-1 items-center gap-2 rounded-[12px] px-2.5 text-[13px] font-semibold text-fog hover:bg-gaffer/60 hover:text-paper"
            >
              <Plus size={14} /> New project
            </button>
            {project ? (
              <button
                type="button"
                onClick={() => {
                  if (!arming) return setArming(true);
                  void switchTo(() => remove(project.id), close).catch((err: Error) => setError(err.message));
                }}
                title="Delete this project: its files go back to General in the Library"
                className={cn("press squircle flex h-9 items-center gap-1.5 rounded-[12px] px-2.5 text-[12.5px] font-semibold", arming ? "bg-tally/15 text-tally" : "text-haze hover:bg-gaffer/60 hover:text-tally")}
              >
                <Trash2 size={13} /> {arming ? "Delete it?" : "Delete"}
              </button>
            ) : null}
          </div>
        </div>
      )}
    </Popover>
  );
}

/* ------------------------------------------------------------------ export */

function ExportButton() {
  const project = useEditor((s) => s.project);
  const pieces = useEditor((s) => s.timeline.main.length);
  const making = useEditor((s) => s.timeline.main.some((c) => c.making));
  const files = useProjectFiles((s) => s.items);
  const latest = files.find(isFilm);
  const [quality, setQuality] = useState<"720p" | "1080p">("1080p");
  const job = useExport((s) => s.job);
  const error = useExport((s) => s.error);
  const running = isExporting(job) && job?.params?.project === project?.id;
  const start = () => project && void useExport.getState().start(project.id, quality);

  return (
    <Popover
      placement="bottom-end"
      panelClassName="w-[300px] p-3"
      trigger={({ open, toggle }) => (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          disabled={!project}
          className="lip squircle inline-flex h-10 items-center gap-2 rounded-[12px] bg-spike px-4 text-[13px] font-bold text-spike-ink [--lip:var(--color-spike-lip)] hover:bg-spike-hi disabled:opacity-50"
        >
          {running ? <LoaderCircle size={14} className="animate-spin" /> : <Download size={14} />}
          {running ? `Exporting ${Math.round((job?.progress ?? 0) * 100)}%` : "Export"}
        </button>
      )}
    >
      {() => (
        <div className="space-y-3">
          <div>
            <p className="text-[14px] font-semibold">Export the film</p>
            <p className="mt-0.5 text-[12px] leading-relaxed text-haze">One MP4 of the timeline with its sound. It lands in Files and in the project&apos;s Library folder.</p>
          </div>
          <div role="radiogroup" aria-label="Quality" className="grid grid-cols-2 gap-1 rounded-[12px] bg-white/[0.04] p-0.5">
            {(["720p", "1080p"] as const).map((q) => (
              <button
                key={q}
                type="button"
                role="radio"
                aria-checked={quality === q}
                onClick={() => setQuality(q)}
                className={cn("press squircle h-8 rounded-[10px] text-[12.5px] font-semibold", quality === q ? "bg-white/[0.14] text-paper" : "text-fog hover:text-paper")}
              >
                {q}
                <span className="ml-1 font-normal text-haze">{q === "720p" ? "quick" : "sharp"}</span>
              </button>
            ))}
          </div>
          {making ? <p className="text-[12px] leading-relaxed text-tungsten">Some clips are still being made: their pictures go in for now.</p> : null}
          {error ? <p className="text-[12px] text-tally">{error}</p> : null}
          <button
            type="button"
            onClick={() => void start()}
            disabled={!pieces || Boolean(running)}
            className="press squircle flex h-10 w-full items-center justify-center gap-2 rounded-[12px] bg-paper text-[13px] font-bold text-[#16131b] hover:bg-white disabled:opacity-40"
          >
            {running ? <LoaderCircle size={14} className="animate-spin" /> : <Film size={14} />}
            {running ? `Putting it together · ${Math.round((job?.progress ?? 0) * 100)}%` : pieces ? "Export MP4" : "Put something on the timeline"}
          </button>
          {latest ? (
            <a
              href={latest.url}
              download={`${project?.name ?? "film"}.mp4`}
              className="press squircle flex h-9 items-center justify-center gap-1.5 rounded-[12px] bg-white/[0.05] text-[12.5px] font-semibold text-fog hover:bg-white/[0.09] hover:text-paper"
            >
              <Download size={13} /> Download the latest{latest.duration ? ` · ${timecode(latest.duration, false)}` : ""}
            </a>
          ) : null}
        </div>
      )}
    </Popover>
  );
}
