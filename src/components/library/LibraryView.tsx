"use client";

import Link from "next/link";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type ReactNode, type Ref } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useShallow } from "zustand/react/shallow";
import {
  ArrowDownWideNarrow,
  ArrowUpNarrowWide,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FolderInput,
  Grid2x2,
  Grid3x3,
  LayoutGrid,
  Search,
  Square,
  SquareCheck,
  Trash,
  X,
} from "lucide-react";
import { useGenerations } from "@/lib/hooks/use-generations";
import { useLibrary, type TakeKey } from "@/lib/hooks/use-library";
import { useHandoff } from "@/lib/hooks/use-handoff";
import { useComposerBridge } from "@/lib/hooks/use-composer-bridge";
import { MenuItem, Popover } from "@/components/ui/Popover";
import { AppIcon } from "@/components/ui/ToolTile";
import { cn } from "@/lib/cn";
import { GENERAL, PROJECT_COLORS, type LibraryProject, type ProjectInput } from "@/lib/library/types";
import type { Generation } from "@/lib/generations/types";
import { FolderRail } from "./FolderRail";
import { DropDock, LibraryDock, SelectionBar, type Toast } from "./LibraryDock";
import { GENERAL_COLOR, GENERAL_ICON, ProjectIcon } from "./ProjectIcon";
import { DRAG_TYPE, itemsLabel, type DragState, type FolderInfo } from "./folders";
import { GHOST_SIZE, paintGhost } from "./drag-ghost";
import { FailedTile, LibraryTile, type PickEvent, type TileHandlers } from "./LibraryTile";
import { Viewer } from "./Viewer";
import { useLibraryPrefs } from "./prefs";
import { byDay, dayKey, dayLabel, GAP, justify, PER_PAGE, targetHeight, type Density } from "./rows";
import { matches, takesOf, toolIcon, toolName, type Take } from "./takes";

/** What the grid shows: everything that rendered, only stills, only clips, or the runs that failed. */
type Kind = "all" | "image" | "video" | "failed";

const failed = (t: Take) => t.gen.status === "error";
const kindFits = (t: Take, k: Kind) => (k === "failed" ? failed(t) : !failed(t) && (k === "all" || t.kind === k));
const toolFits = (t: Take, tool: string) => tool === "all" || t.tool === tool;

const folderOf = (p: LibraryProject, count = 0): FolderInfo => ({ id: p.id, name: p.name, icon: p.icon, color: p.color, count, project: p });

/** The address with the viewer's take in it (or without). */
function withView(view: TakeKey | null) {
  const u = new URL(window.location.href);
  if (view) u.searchParams.set("view", view);
  else u.searchParams.delete("view");
  return `${u.pathname}${u.search}${u.hash}`;
}

export function LibraryView() {
  const router = useRouter();
  // Only what the Library shows: Home's showcase runs ticking along don't redraw it.
  const items = useGenerations(useShallow((s) => s.items.filter((g) => g.tool !== "showcase")));
  const cancel = useGenerations((s) => s.cancel);
  const { projects, placements, history, loaded, load, createProject, updateProject, deleteProject, move, restore, removeGeneration, removeGenerations } = useLibrary();
  const wanted = useSearchParams().get("project");
  const density = useLibraryPrefs((s) => s.density);
  const sort = useLibraryPrefs((s) => s.sort);
  const info = useLibraryPrefs((s) => s.info);
  const setPrefs = useLibraryPrefs((s) => s.set);
  const [prefsReady, setPrefsReady] = useState(false);
  const [kind, setKind] = useState<Kind>("all");
  const [tool, setTool] = useState("all");
  const [query, setQuery] = useState("");
  // The page belongs to what it was a page of: another folder, filter or search starts at the first.
  const [paging, setPaging] = useState({ view: "", index: 0 });
  // The take open in the viewer. The address follows (?view=), so Back closes it and a reload keeps it.
  const [viewKey, setViewKey] = useState<TakeKey | null>(null);
  const pushedView = useRef(false);
  const lastViewed = useRef<TakeKey | null>(null);
  // Selecting belongs to the folder it started in, so leaving the folder (even with Back) ends it.
  const [selectingIn, setSelectingIn] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<TakeKey>>(() => new Set());
  const anchor = useRef<TakeKey | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [leaving, setLeaving] = useState<ReadonlySet<TakeKey>>(() => new Set());
  const [landed, setLanded] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [railSeen, setRailSeen] = useState(true);
  const [width, setWidth] = useState(0);
  const rail = useRef<HTMLDivElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const top = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const ghost = useRef<HTMLDivElement>(null);
  const dragFrame = useRef(0);
  const timers = useRef<{ toast?: ReturnType<typeof setTimeout>; landed?: ReturnType<typeof setTimeout>; seq: number }>({ seq: 0 });

  // Fresh on every visit; what's cached shows meanwhile.
  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void Promise.resolve(useLibraryPrefs.persist.rehydrate()).then(() => setPrefsReady(true));
  }, []);

  // The grid is laid out for its own width.
  useLayoutEffect(() => {
    const el = grid.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Every generation; the shared store's copies are fresher while they render. A finished one
  // doesn't change, and the Library's copy also knows its file's size and a clip's length.
  const all = useMemo(() => {
    const byId = new Map<string, Generation>();
    for (const g of history) byId.set(g.id, g);
    for (const g of items) {
      if (g.status === "done" && byId.get(g.id)?.status === "done") continue;
      byId.set(g.id, g);
    }
    return Array.from(byId.values()).sort((a, b) => b.createdAt - a.createdAt);
  }, [history, items]);

  const takes = useMemo(() => all.flatMap((g) => takesOf(g, (k) => placements[k] ?? GENERAL)), [all, placements]);

  const counted = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of takes) if (t.gen.status === "done") counts.set(t.folder, (counts.get(t.folder) ?? 0) + 1);
    return [
      { id: GENERAL, name: "General", icon: GENERAL_ICON, color: GENERAL_COLOR, count: counts.get(GENERAL) ?? 0 },
      ...projects.map((p) => folderOf(p, counts.get(p.id))),
    ] satisfies FolderInfo[];
  }, [takes, projects]);
  // The same list until a folder or a count really changes, so a take rendering doesn't redraw every card.
  const foldersKey = JSON.stringify(counted.map((f) => [f.id, f.name, f.icon, f.color, f.count]));
  const [kept, setKept] = useState({ key: foldersKey, folders: counted });
  if (kept.key !== foldersKey) setKept({ key: foldersKey, folders: counted });
  const folders = kept.key === foldersKey ? kept.folders : counted;

  const current = wanted && projects.some((p) => p.id === wanted) ? wanted : GENERAL;
  const selecting = selectingIn === current;
  const folder = folders.find((f) => f.id === current) ?? folders[0];
  // A link to a project, before the projects have loaded: don't flash General's takes.
  const resolving = Boolean(wanted) && !loaded;
  const newColor = PROJECT_COLORS[projects.length % PROJECT_COLORS.length];

  // Search, then the two filters. Each filter's counts follow the search and the other filter.
  const words = useMemo(() => query.trim().toLowerCase().split(/\s+/).filter(Boolean), [query]);
  const inFolder = useMemo(() => takes.filter((t) => t.folder === current), [takes, current]);
  const searched = useMemo(() => inFolder.filter((t) => matches(t, words)), [inFolder, words]);
  const toolCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of searched) if (kindFits(t, kind === "failed" ? "all" : kind)) counts.set(t.tool, (counts.get(t.tool) ?? 0) + 1);
    return counts;
  }, [searched, kind]);
  const activeTool = tool !== "all" && toolCounts.has(tool) ? tool : "all";
  const kindCounts = useMemo(() => {
    const c: Record<Kind, number> = { all: 0, image: 0, video: 0, failed: 0 };
    for (const t of searched) {
      if (!toolFits(t, activeTool)) continue;
      if (failed(t)) c.failed++;
      else {
        c.all++;
        c[t.kind]++;
      }
    }
    return c;
  }, [searched, activeTool]);
  const activeKind: Kind = kind === "failed" && !kindCounts.failed ? "all" : kind;
  const shown = useMemo(() => {
    const list = searched.filter((t) => kindFits(t, activeKind) && toolFits(t, activeTool));
    return sort === "old" ? list.reverse() : list;
  }, [searched, activeKind, activeTool, sort]);
  // A search also finds takes in other folders: say where they are.
  const elsewhere = useMemo(() => {
    if (!words.length) return [];
    const counts = new Map<string, number>();
    for (const t of takes) if (t.folder !== current && t.gen.status === "done" && matches(t, words)) counts.set(t.folder, (counts.get(t.folder) ?? 0) + 1);
    return folders.filter((f) => counts.has(f.id)).map((f) => ({ ...f, count: counts.get(f.id)! }));
  }, [words, takes, current, folders]);

  const per = PER_PAGE[density];
  const viewSig = `${current}|${activeKind}|${activeTool}|${words.join(" ")}|${sort}`;
  const pages = Math.max(1, Math.ceil(shown.length / per));
  // The viewer steps through what rendered, in the grid's order; while it's open the grid behind
  // turns to the page of the take on show, so closing it lands where you are.
  const viewable = useMemo(() => shown.filter((t) => t.gen.status === "done"), [shown]);
  const viewIndex = viewKey ? viewable.findIndex((t) => t.key === viewKey) : -1;
  const viewedAt = viewIndex >= 0 ? shown.indexOf(viewable[viewIndex]) : -1;
  const page = viewedAt >= 0 ? Math.floor(viewedAt / per) : Math.min(paging.view === viewSig ? paging.index : 0, pages - 1);
  const pageTakes = useMemo(() => shown.slice(page * per, page * per + per), [shown, page, per]);
  const setPage = (index: number) => setPaging({ view: viewSig, index });

  const target = width ? targetHeight(width, density) : 0;
  const dayCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of shown) counts.set(dayKey(t.gen.createdAt), (counts.get(dayKey(t.gen.createdAt)) ?? 0) + 1);
    return counts;
  }, [shown]);
  const sections = useMemo(
    () => (width ? byDay(pageTakes, (t) => t.gen.createdAt).map((g) => ({ ...g, rows: justify(g.items, (t) => t.ratio, width, target) })) : []),
    [pageTakes, width, target],
  );

  const selectable = useMemo(() => shown.filter((t) => t.gen.status === "done").map((t) => t.key), [shown]);
  const picked = useMemo(() => selectable.filter((k) => selected.has(k)), [selectable, selected]);
  const dragged = useMemo(() => new Set(drag?.keys), [drag]);
  // Deleting removes whole runs, so it can take more than was picked.
  const doomed = useMemo(() => {
    const ids = new Set(picked.map((k) => k.slice(0, k.lastIndexOf(":"))));
    return takes.filter((t) => ids.has(t.gen.id)).length;
  }, [picked, takes]);

  // What the address and the keyboard act on, kept current for the listeners below.
  const latest = useRef({ viewable, page, viewSig, selecting, selectable, viewKey });
  useLayoutEffect(() => {
    latest.current = { viewable, page, viewSig, selecting, selectable, viewKey };
  });

  // The address says which take is open: on arrival (a link, a reload) and on Back and Forward.
  useEffect(() => {
    const sync = () => {
      const view = new URLSearchParams(window.location.search).get("view");
      const was = latest.current.viewKey;
      if (view) lastViewed.current = view;
      else {
        pushedView.current = false;
        if (was) {
          // Stay on the page the viewer had turned to.
          setPaging({ view: latest.current.viewSig, index: latest.current.page });
          restoreFocus(was);
        }
      }
      setViewKey(view);
    };
    void Promise.resolve().then(sync);
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);

  // A link to a take that isn't here (deleted, or in another folder or filter): just the Library.
  useEffect(() => {
    if (!loaded || !viewKey || viewIndex >= 0) return;
    window.history.replaceState(null, "", withView(null));
    pushedView.current = false;
    void Promise.resolve().then(() => setViewKey(null));
  }, [loaded, viewKey, viewIndex]);

  // When the folder row scrolls away, dragged takes get a dock of folders at the bottom instead.
  useEffect(() => {
    const el = rail.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setRailSeen(e.isIntersecting));
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // A link to a project that's gone: tidy the address back to the Library.
  useEffect(() => {
    if (loaded && wanted && !projects.some((p) => p.id === wanted)) window.history.replaceState(null, "", "/library");
  }, [loaded, wanted, projects]);

  // "/" finds; while selecting, Escape stops and Ctrl-A takes everything shown.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { selecting: picking, selectable: all_, viewKey: open } = latest.current;
      if (open) return;
      const typing = (e.target as HTMLElement | null)?.closest("input, textarea, [contenteditable]");
      if (e.key === "/" && !typing && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        search.current?.focus();
        return;
      }
      if (!picking) return;
      // Escape in an open menu closes the menu only.
      if (e.key === "Escape" && !document.querySelector("[data-popover-open]")) {
        setSelectingIn(null);
        setSelected(new Set());
      }
      if (e.key.toLowerCase() === "a" && (e.ctrlKey || e.metaKey) && !typing) {
        e.preventDefault();
        setSelected(new Set(all_));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const t = timers.current;
    return () => {
      clearTimeout(t.toast);
      clearTimeout(t.landed);
    };
  }, []);

  function say(t: Omit<Toast, "id">) {
    clearTimeout(timers.current.toast);
    setToast({ ...t, id: ++timers.current.seq });
    timers.current.toast = setTimeout(() => setToast(null), t.error ? 7000 : 5500);
  }

  /** Back on the card that was open, scrolled into sight. */
  function restoreFocus(key: TakeKey) {
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(`[data-take="${CSS.escape(key)}"]`);
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (r.top < 0 || r.bottom > window.innerHeight) el.scrollIntoView({ block: "center" });
      el.focus({ preventScroll: true });
    });
  }

  function openTake(key: TakeKey) {
    lastViewed.current = key;
    setViewKey(key);
    window.history.pushState(null, "", withView(key));
    pushedView.current = true;
  }

  /** Shows another take in the viewer (the grid behind turns to its page). */
  function viewTake(key: TakeKey) {
    lastViewed.current = key;
    setViewKey(key);
    window.history.replaceState(null, "", withView(key));
  }

  /** `leave`: going to another page, so the viewer's entry is replaced rather than gone back over. */
  function closeViewer(leave = false) {
    const was = viewKey ?? lastViewed.current;
    setPaging({ view: viewSig, index: page });
    setViewKey(null);
    if (pushedView.current && !leave) window.history.back();
    else window.history.replaceState(null, "", withView(null));
    pushedView.current = false;
    if (was && !leave) restoreFocus(was);
  }

  /** The take to show after this one leaves the list (moved or deleted): the next, else the one before. */
  function neighbour(take: Take, sameRun = false) {
    const list = latest.current.viewable;
    const at = list.findIndex((t) => t.key === take.key);
    const gone = (t: Take) => t.key === take.key || (sameRun && t.gen.id === take.gen.id);
    return list.slice(at + 1).find((t) => !gone(t)) ?? list.slice(0, Math.max(0, at)).reverse().find((t) => !gone(t)) ?? null;
  }

  function startSelecting() {
    setSelectingIn(current);
    setSelected(new Set());
    anchor.current = null;
  }

  function stopSelecting() {
    setSelectingIn(null);
    setSelected(new Set());
    anchor.current = null;
  }

  function openFolder(id: string) {
    stopSelecting();
    setTool("all");
    if (id === current) return;
    window.history.pushState(null, "", id === GENERAL ? "/library" : `/library?project=${encodeURIComponent(id)}`);
    if (!railSeen) window.scrollTo({ top: 0 });
  }

  /** A page, from the top of the grid. */
  function turnTo(index: number) {
    setPage(index);
    const el = top.current;
    if (el && el.getBoundingClientRect().top < 0) el.scrollIntoView({ block: "start" });
  }

  /** Click toggles one; Shift-click takes everything between it and the last one clicked. */
  function toggle(key: TakeKey, e: PickEvent) {
    e.preventDefault();
    e.stopPropagation();
    const from = selecting ? anchor.current : null;
    anchor.current = key;
    if (!selecting) setSelectingIn(current);
    setSelected((prev) => {
      const next = new Set(selecting ? prev : []);
      const a = from && e.shiftKey ? selectable.indexOf(from) : -1;
      const b = selectable.indexOf(key);
      if (a >= 0 && b >= 0 && a !== b) {
        for (const k of selectable.slice(Math.min(a, b), Math.max(a, b) + 1)) next.add(k);
      } else if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function moveTakes(keys: TakeKey[], dest: FolderInfo) {
    const moving = keys.filter((k) => (placements[k] ?? GENERAL) !== dest.id);
    if (!moving.length) return;
    // A short fade so a take visibly leaves, rather than blinking out (skipped for big batches,
    // and with reduced motion, where the fade is instant and the wait would only leave a hole).
    if (!viewKey && moving.length <= 12 && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setLeaving(new Set(moving));
      await new Promise((r) => setTimeout(r, 170));
    }
    try {
      const before = await move(moving, dest.id === GENERAL ? null : dest.id);
      if (moving.length >= picked.length && picked.every((k) => moving.includes(k))) stopSelecting();
      else setSelected((prev) => new Set(Array.from(prev).filter((k) => !moving.includes(k))));
      clearTimeout(timers.current.landed);
      setLanded(dest.id);
      timers.current.landed = setTimeout(() => setLanded(null), 700);
      say({
        folder: dest,
        text: (name) => (
          <>
            Moved {itemsLabel(moving.length)} to {name}
          </>
        ),
        undo: () => {
          setToast(null);
          restore(before).catch((err: Error) => say({ error: true, text: () => err.message }));
        },
        open: () => {
          setToast(null);
          if (latest.current.viewKey) closeViewer(true);
          openFolder(dest.id);
        },
      });
    } catch (err) {
      say({ error: true, text: () => (err as Error).message });
    } finally {
      setLeaving(new Set());
    }
  }

  const moveTo = (keys: TakeKey[], id: string) => {
    const dest = folders.find((f) => f.id === id);
    if (dest) void moveTakes(keys, dest);
  };

  /** "New project…" from a Move menu: make it, then move there. Errors show in the form. */
  async function createAndMove(input: ProjectInput, keys: TakeKey[]) {
    const p = await createProject(input);
    await moveTakes(keys, folderOf(p));
  }

  async function makeProject(input: ProjectInput) {
    const p = await createProject(input);
    say({
      folder: folderOf(p),
      text: (name) => <>{name} is ready. Drag takes onto it, or use Move.</>,
    });
  }

  async function dropProject(id: string) {
    const f = folders.find((x) => x.id === id);
    await deleteProject(id);
    if (!f) return;
    say({
      folder: folders[0],
      text: () => (
        <>
          Deleted <b className="font-semibold text-paper">{f.name}</b>
          {f.count ? (f.count === 1 ? ". Its 1 item is back in General." : `. Its ${f.count.toLocaleString()} items are back in General.`) : "."}
        </>
      ),
    });
  }

  async function deleteTakes(keys: TakeKey[]) {
    const ids = Array.from(new Set(keys.map((k) => k.slice(0, k.lastIndexOf(":")))));
    const count = takes.filter((t) => ids.includes(t.gen.id)).length;
    stopSelecting();
    await removeGenerations(ids);
    say({ text: () => <>Deleted {itemsLabel(count)}</> });
  }

  /** Clears the runs that failed (they have no files; only the note that they failed goes). */
  async function clearFailed() {
    const ids = shown.filter(failed).map((t) => t.gen.id);
    await removeGenerations(ids);
    setKind("all");
    say({ text: () => <>Cleared {ids.length.toLocaleString()} failed {ids.length === 1 ? "run" : "runs"}</> });
  }

  function startDrag(e: DragEvent<HTMLDivElement>, key: TakeKey) {
    const keys = selecting && selected.has(key) ? [key, ...picked.filter((k) => k !== key)] : [key];
    e.dataTransfer.effectAllowed = "copyMove";
    e.dataTransfer.setData(DRAG_TYPE, keys.join(","));
    if (ghost.current) {
      paintGhost(ghost.current, keys);
      e.dataTransfer.setDragImage(ghost.current, GHOST_SIZE / 2, GHOST_SIZE / 2);
    }
    const from = current;
    // After the browser has its snapshot: changing the page inside dragstart can cancel the drag.
    dragFrame.current = requestAnimationFrame(() => setDrag({ keys, from }));
  }

  const dropOn = (id: string) => {
    if (drag) moveTo(drag.keys, id);
    setDrag(null);
  };

  // The cards get one set of handlers for good, each running this render's version.
  const handlers = useRef<TileHandlers | null>(null);
  useLayoutEffect(() => {
    handlers.current = {
      open: openTake,
      toggle,
      startDrag,
      endDrag: () => {
        cancelAnimationFrame(dragFrame.current);
        setDrag(null);
      },
      remove: (id) => void removeGeneration(id),
      cancel: (id) => void cancel(id),
      moveTo,
      createAndMove,
    };
  });
  const [on] = useState<TileHandlers>(() => ({
    open: (key) => handlers.current?.open(key),
    toggle: (key, e) => handlers.current?.toggle(key, e),
    startDrag: (e, key) => handlers.current?.startDrag(e, key),
    endDrag: () => handlers.current?.endDrag(),
    remove: (id) => handlers.current?.remove(id),
    cancel: (id) => handlers.current?.cancel(id),
    moveTo: (keys, id) => handlers.current?.moveTo(keys, id),
    createAndMove: async (input, keys) => {
      await handlers.current?.createAndMove(input, keys);
    },
  }));

  /* The viewer's actions: the next take steps in when one leaves the list. */
  function moveFromViewer(take: Take, id: string) {
    const dest = folders.find((f) => f.id === id);
    if (!dest || dest.id === take.folder) return;
    const next = neighbour(take);
    if (next) viewTake(next.key);
    else closeViewer();
    void moveTakes([take.key], dest);
  }
  async function createAndMoveFromViewer(take: Take, input: ProjectInput) {
    const p = await createProject(input);
    const next = neighbour(take);
    if (next) viewTake(next.key);
    else closeViewer();
    await moveTakes([take.key], folderOf(p));
  }
  function deleteFromViewer(take: Take) {
    const next = neighbour(take, true);
    if (next) viewTake(next.key);
    else closeViewer();
    void removeGeneration(take.gen.id);
    say({ text: () => <>Deleted {itemsLabel(take.gen.outputs.length)}</> });
  }
  function continueIn(take: Take, href: string) {
    const o = take.gen.outputs[take.index];
    if (!o) return;
    useHandoff.getState().send({ prompt: "", references: [{ url: o.url, name: take.gen.prompt.slice(0, 40) || "Library take" }], from: "library" });
    closeViewer(true);
    router.push(href);
  }
  function usePrompt(take: Take) {
    const g = take.gen;
    // A storyboard's own "prompt" is the shot's name; what it sent is the shot itself.
    const words = take.tool === "storyboard" ? (g.compiledPrompt ?? g.prompt) : g.prompt || (g.compiledPrompt ?? "");
    useComposerBridge.getState().push({ prompt: words, aspect: g.aspect });
    closeViewer(true);
    router.push("/create");
  }

  const ready = loaded && !resolving && prefsReady && width > 0;
  const from = shown.length ? page * per + 1 : 0;
  const to = Math.min(shown.length, page * per + per);
  const tools = useMemo(() => Array.from(toolCounts.keys()).sort((a, b) => toolName(a).localeCompare(toolName(b))), [toolCounts]);

  return (
    <div className="mx-auto max-w-[2200px] px-4 pb-32 pt-6 sm:px-6 lg:px-10 lg:pt-10">
      <LibraryHeader query={query} onQuery={setQuery} inputRef={search} />

      <FolderRail
        folders={folders}
        current={current}
        loaded={loaded}
        drag={drag}
        landed={landed}
        newColor={newColor}
        railRef={rail}
        onOpen={openFolder}
        onDrop={dropOn}
        onCreate={makeProject}
        onUpdate={updateProject}
        onDelete={dropProject}
      />

      {/* The toolbar: what to show, in which order, how big; and the page you're on. */}
      <div ref={top} className="mt-5 flex scroll-mt-4 flex-wrap items-center gap-2">
        <div role="radiogroup" aria-label="Show" className="squircle inline-flex h-10 items-center gap-0.5 rounded-[14px] bg-white/[0.035] p-1 shadow-[inset_0_0_0_1px_var(--color-line)]">
          {(
            [
              ["all", "All"],
              ["image", "Images"],
              ["video", "Clips"],
              ...(kindCounts.failed ? ([["failed", "Failed"]] as const) : []),
            ] as const
          ).map(([id, label]) => (
            <Segment key={id} active={activeKind === id} onClick={() => setKind(id)} count={kindCounts[id]} danger={id === "failed"}>
              {label}
            </Segment>
          ))}
        </div>

        <ToolPicker tools={tools} counts={toolCounts} value={activeTool} onChange={setTool} />

        <div className="ml-auto flex items-center gap-2">
          <PageNav page={page} pages={pages} from={from} to={to} total={shown.length} onPage={turnTo} compact />
          <button
            type="button"
            onClick={() => setPrefs({ sort: sort === "new" ? "old" : "new" })}
            title={sort === "new" ? "Newest first (click for oldest first)" : "Oldest first (click for newest first)"}
            className="press squircle inline-flex h-10 items-center gap-2 rounded-[14px] bg-white/[0.035] px-3 text-[13px] font-semibold text-fog shadow-[inset_0_0_0_1px_var(--color-line)] hover:bg-white/[0.06] hover:text-paper"
          >
            {sort === "new" ? <ArrowDownWideNarrow size={15} /> : <ArrowUpNarrowWide size={15} />}
            <span className="hidden sm:inline">{sort === "new" ? "Newest" : "Oldest"}</span>
          </button>
          <div role="radiogroup" aria-label="Size" className="squircle inline-flex h-10 items-center gap-0.5 rounded-[14px] bg-white/[0.035] p-1 shadow-[inset_0_0_0_1px_var(--color-line)]">
            {(
              [
                ["s", "Small", Grid3x3],
                ["m", "Medium", Grid2x2],
                ["l", "Large", Square],
              ] as const
            ).map(([id, label, Icon]) => (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={density === id}
                aria-label={`${label} cards`}
                title={`${label} cards`}
                onClick={() => {
                  // Stay on the takes you were looking at.
                  const first = page * per;
                  setPrefs({ density: id as Density });
                  setPaging({ view: viewSig, index: Math.floor(first / PER_PAGE[id as Density]) });
                }}
                className={cn(
                  "press squircle grid h-8 w-9 place-items-center rounded-[10px]",
                  density === id ? "bg-paper text-[#16171a]" : "text-fog hover:bg-white/[0.06] hover:text-paper",
                )}
              >
                <Icon size={15} />
              </button>
            ))}
          </div>
          {selectable.length ? (
            <button
              type="button"
              onClick={() => (selecting ? stopSelecting() : startSelecting())}
              aria-pressed={selecting}
              title="Pick several to move or delete at once (or Ctrl-click a card)"
              className={cn(
                "press squircle inline-flex h-10 shrink-0 items-center gap-1.5 rounded-[14px] px-3 text-[13px] font-semibold",
                selecting ? "bg-paper text-[#16171a]" : "bg-white/[0.035] text-fog shadow-[inset_0_0_0_1px_var(--color-line)] hover:bg-white/[0.06] hover:text-paper",
              )}
            >
              <SquareCheck size={15} /> {selecting ? "Done" : "Select"}
            </button>
          ) : null}
        </div>
      </div>

      {elsewhere.length ? (
        <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[13px] text-haze">
          <span className="mr-0.5">Also in</span>
          {elsewhere.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => openFolder(f.id)}
              className="press squircle inline-flex h-7 items-center gap-1.5 rounded-[10px] bg-white/[0.04] pl-2 pr-2.5 text-[12.5px] font-semibold text-fog hover:bg-white/[0.08] hover:text-paper"
            >
              <ProjectIcon icon={f.icon} color={f.color} size={14} />
              {f.name}
              <span className="tabular font-normal text-haze">{f.count}</span>
            </button>
          ))}
        </div>
      ) : null}

      {activeKind === "failed" && ready ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-[16px] bg-tally/[0.06] px-4 py-3 shadow-[inset_0_0_0_1px_rgb(255_92_116/0.2)]">
          <p className="text-[13.5px] text-fog">These runs didn&rsquo;t render, so there&rsquo;s nothing to keep. Run them again from their tool, or clear them.</p>
          <ClearFailed count={kindCounts.failed} onClear={() => void clearFailed()} />
        </div>
      ) : null}

      {/* The grid: a section per day, rows that keep every take's shape. */}
      <div ref={grid} className="mt-5 min-h-[40vh]">
        {!ready ? (
          <GridSkeleton />
        ) : shown.length === 0 ? (
          <EmptyFolder folder={folder} anything={takes.length > 0} filtered={inFolder.length > 0} onGeneral={() => openFolder(GENERAL)} />
        ) : activeKind === "failed" ? (
          // Nothing to look at, so no picture-sized cards: a tidy list of what went wrong.
          <div key={`${current}|${page}|${viewSig}`} className="library-in grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(min(100%,340px),1fr))]">
            {pageTakes.map((t) => (
              <FailedTile key={t.key} take={t} onRemove={on.remove} />
            ))}
          </div>
        ) : (
          <div key={`${current}|${page}|${viewSig}`} className="library-in">
            {sections.map((sec) => (
              <section key={sec.day} aria-label={dayLabel(sec.at)} className="mt-8 first:mt-0">
                <header className="mb-3 flex items-baseline gap-2.5">
                  <h2 className="text-[15px] font-semibold text-paper">{dayLabel(sec.at)}</h2>
                  <span className="tabular text-[12.5px] text-haze">{itemsLabel(dayCounts.get(sec.day) ?? sec.items.length)}</span>
                  {selecting ? (
                    <button
                      type="button"
                      onClick={() => {
                        const day = shown.filter((t) => t.gen.status === "done" && dayKey(t.gen.createdAt) === sec.day).map((t) => t.key);
                        setSelected((prev) => {
                          const all_ = day.every((k) => prev.has(k));
                          const next = new Set(prev);
                          for (const k of day) {
                            if (all_) next.delete(k);
                            else next.add(k);
                          }
                          return next;
                        });
                      }}
                      className="press ml-1 rounded-[8px] px-1.5 text-[12.5px] font-semibold text-fog hover:text-paper"
                    >
                      Pick the day
                    </button>
                  ) : null}
                </header>
                <div className="flex flex-col" style={{ gap: GAP }}>
                  {sec.rows.map((row, r) => (
                    <div key={r} className="flex" style={{ height: Math.round(row.height), gap: GAP }}>
                      {row.items.map(({ item: t, ratio }) => (
                        <LibraryTile
                          key={t.key}
                          take={t}
                          ratio={ratio}
                          full={row.full}
                          width={Math.round(ratio * row.height)}
                          selecting={selecting}
                          selected={selecting && selected.has(t.key)}
                          leaving={leaving.has(t.key)}
                          dragged={dragged.has(t.key)}
                          folders={folders}
                          newColor={newColor}
                          on={on}
                        />
                      ))}
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>

      {ready && pages > 1 ? (
        <div className="mt-10 flex justify-center">
          <PageNav page={page} pages={pages} from={from} to={to} total={shown.length} onPage={turnTo} />
        </div>
      ) : null}

      {/* The drag picture is painted here, off screen (see drag-ghost). */}
      <div ref={ghost} aria-hidden="true" className="pointer-events-none fixed -left-[400px] top-0">
        <canvas />
      </div>

      {viewKey && viewIndex >= 0 ? (
        <Viewer
          takes={viewable}
          index={viewIndex}
          onGo={(i) => viewable[i] && viewTake(viewable[i].key)}
          onClose={() => closeViewer()}
          folders={folders}
          newColor={newColor}
          onMove={moveFromViewer}
          onCreateAndMove={createAndMoveFromViewer}
          onDelete={deleteFromViewer}
          onContinue={continueIn}
          onUsePrompt={usePrompt}
        />
      ) : null}

      <LibraryDock
        toast={toast}
        folders={folders}
        onDismiss={() => setToast(null)}
        viewer={viewKey && viewIndex >= 0 ? { info } : undefined}
        dock={drag && !railSeen ? <DropDock folders={folders} drag={drag} onDrop={dropOn} /> : null}
        selection={
          selecting ? (
            <SelectionBar
              count={picked.length}
              total={selectable.length}
              doomed={doomed}
              folders={folders}
              current={current}
              newColor={newColor}
              onSelectAll={() => setSelected(new Set(selectable))}
              onClear={stopSelecting}
              onMove={(id) => moveTo(picked, id)}
              onCreate={(input) => createAndMove(input, picked)}
              onDelete={() => void deleteTakes(picked)}
            />
          ) : null
        }
      />
    </div>
  );
}

function Segment({ active, onClick, count, danger, children }: { active: boolean; onClick: () => void; count: number; danger?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onClick}
      className={cn(
        "press squircle inline-flex h-8 items-center gap-1.5 rounded-[10px] px-3 text-[13px] font-semibold",
        active ? "bg-paper text-[#16171a]" : danger ? "text-tally/85 hover:bg-tally/10 hover:text-tally" : "text-fog hover:bg-white/[0.06] hover:text-paper",
      )}
    >
      {children}
      <span className={cn("tabular text-[11.5px] font-medium", active ? "text-[#16171a]/55" : danger ? "text-tally/60" : "text-haze")}>{count.toLocaleString()}</span>
    </button>
  );
}

/** Which tool's takes to show, with how many each has. */
function ToolPicker({ tools, counts, value, onChange }: { tools: string[]; counts: Map<string, number>; value: string; onChange: (tool: string) => void }) {
  if (tools.length < 2 && value === "all") return null;
  const icon = value === "all" ? null : toolIcon(value);
  return (
    <Popover
      placement="bottom-start"
      trigger={({ open, toggle, id }) => (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-controls={id}
          data-popover-open={open || undefined}
          className={cn(
            "press squircle inline-flex h-10 items-center gap-2 rounded-[14px] pl-2.5 pr-2.5 text-[13px] font-semibold shadow-[inset_0_0_0_1px_var(--color-line)]",
            value === "all" ? "bg-white/[0.035] text-fog hover:bg-white/[0.06] hover:text-paper" : "bg-white/[0.08] text-paper",
          )}
        >
          {icon ? <AppIcon glyph={icon.glyph} hue={icon.hue} size={22} /> : <LayoutGrid size={15} />}
          {value === "all" ? "Every tool" : toolName(value)}
          <ChevronDown size={15} className="text-haze" />
        </button>
      )}
    >
      {(close) => (
        <div role="menu" className="w-[260px]">
          <p className="label px-2.5 pb-1.5 pt-1.5">Made with</p>
          <MenuItem
            selected={value === "all"}
            onSelect={() => {
              onChange("all");
              close();
            }}
            hint={Array.from(counts.values())
              .reduce((a, b) => a + b, 0)
              .toLocaleString()}
          >
            <span className="squircle grid size-[24px] place-items-center rounded-[8px] text-fog shadow-[inset_0_0_0_1px_var(--color-line-strong)]">
              <LayoutGrid size={13} />
            </span>
            <span className="font-medium">Every tool</span>
          </MenuItem>
          {tools.map((t) => {
            const i = toolIcon(t);
            return (
              <MenuItem
                key={t}
                selected={value === t}
                onSelect={() => {
                  onChange(t);
                  close();
                }}
                hint={(counts.get(t) ?? 0).toLocaleString()}
              >
                <AppIcon glyph={i.glyph} hue={i.hue} size={24} />
                <span className="truncate font-medium">{toolName(t)}</span>
              </MenuItem>
            );
          })}
        </div>
      )}
    </Popover>
  );
}

/** Page numbers with the ends and the pages either side; `compact` is just where you are and the arrows. */
function PageNav({ page, pages, from, to, total, onPage, compact }: { page: number; pages: number; from: number; to: number; total: number; onPage: (p: number) => void; compact?: boolean }) {
  if (!total) return null;
  const arrow = (dir: -1 | 1, label: string) => (
    <button
      type="button"
      onClick={() => onPage(page + dir)}
      disabled={page + dir < 0 || page + dir >= pages}
      aria-label={label}
      title={label}
      className={cn(
        "press squircle inline-flex shrink-0 items-center justify-center gap-1 rounded-[12px] font-semibold text-fog hover:bg-white/[0.06] hover:text-paper disabled:pointer-events-none disabled:opacity-30",
        compact ? "size-9" : "h-10 px-3 text-[13px]",
      )}
    >
      {dir < 0 ? <ChevronLeft size={17} /> : null}
      {compact ? null : <span className="hidden sm:inline">{dir < 0 ? "Previous" : "Next"}</span>}
      {dir > 0 ? <ChevronRight size={17} /> : null}
    </button>
  );
  const range = (
    <span className="tabular whitespace-nowrap text-[12.5px] text-haze">
      <span className="text-fog">
        {from.toLocaleString()}–{to.toLocaleString()}
      </span>{" "}
      of {total.toLocaleString()}
    </span>
  );
  if (compact) {
    if (pages < 2) return <span className="hidden px-1 md:inline">{range}</span>;
    return (
      <div className="hidden items-center gap-0.5 md:flex">
        <span className="mr-1.5">{range}</span>
        {arrow(-1, "Previous page")}
        {arrow(1, "Next page")}
      </div>
    );
  }
  // 1 … 4 5 6 … 12
  const shown = new Set([0, pages - 1, page - 1, page, page + 1].filter((p) => p >= 0 && p < pages));
  if (page <= 2) [1, 2, 3].forEach((p) => p < pages && shown.add(p));
  if (page >= pages - 3) [pages - 2, pages - 3, pages - 4].forEach((p) => p >= 0 && shown.add(p));
  const list = Array.from(shown).sort((a, b) => a - b);
  return (
    <nav aria-label="Pages" className="flex flex-col items-center gap-3">
      <div className="flex flex-wrap items-center justify-center gap-1">
        {arrow(-1, "Previous page")}
        {list.map((p, i) => (
          <span key={p} className="flex items-center gap-1">
            {i > 0 && p - list[i - 1] > 1 ? <span className="w-6 text-center text-[13px] text-haze">&hellip;</span> : null}
            <button
              type="button"
              onClick={() => onPage(p)}
              aria-current={p === page ? "page" : undefined}
              className={cn(
                "press squircle tabular grid h-10 min-w-10 place-items-center rounded-[12px] px-2 text-[13.5px] font-semibold",
                p === page ? "bg-paper text-[#16171a]" : "text-fog hover:bg-white/[0.06] hover:text-paper",
              )}
            >
              {p + 1}
            </button>
          </span>
        ))}
        {arrow(1, "Next page")}
      </div>
      {range}
    </nav>
  );
}

function ClearFailed({ count, onClear }: { count: number; onClear: () => void }) {
  const [arming, setArming] = useState(false);
  const disarm = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(disarm.current), []);
  return (
    <button
      type="button"
      onClick={() => {
        if (arming) return onClear();
        setArming(true);
        clearTimeout(disarm.current);
        disarm.current = setTimeout(() => setArming(false), 3200);
      }}
      className={cn(
        "press squircle inline-flex h-9 items-center gap-1.5 rounded-[12px] px-3 text-[13px] font-semibold",
        arming ? "bg-tally text-white" : "bg-white/[0.05] text-fog hover:bg-white/[0.09] hover:text-paper",
      )}
    >
      <Trash size={14} /> {arming ? `Clear ${count.toLocaleString()}?` : `Clear all ${count.toLocaleString()}`}
    </button>
  );
}

function LibraryHeader({ query, onQuery, inputRef }: { query: string; onQuery?: (q: string) => void; inputRef?: Ref<HTMLInputElement> }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="font-display text-[34px]">Library</h1>
        <p className="mt-2 text-[15px] text-fog">
          Everything you&rsquo;ve made, stored on this computer in <code className="font-mono text-[13px]">data/media</code>.
        </p>
      </div>
      <label className="field-focus squircle flex h-11 w-full max-w-[400px] items-center gap-2 rounded-[14px] bg-apple px-3 shadow-[inset_0_0_0_1px_var(--color-line)]">
        <Search size={15} className="shrink-0 text-haze" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => onQuery?.(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && query) {
              e.stopPropagation();
              onQuery?.("");
            }
          }}
          readOnly={!onQuery}
          placeholder="Search prompts, models, tools"
          aria-label="Search the Library"
          className="min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-haze"
        />
        {query ? (
          <button type="button" onClick={() => onQuery?.("")} aria-label="Clear the search" className="press grid size-7 place-items-center rounded-[8px] text-haze hover:bg-white/[0.06] hover:text-paper">
            <X size={14} />
          </button>
        ) : (
          <kbd className="hidden h-5 min-w-5 place-items-center rounded-[5px] bg-white/[0.07] px-1.5 font-mono text-[11px] text-haze sm:inline-grid">/</kbd>
        )}
      </label>
    </div>
  );
}

/** Rows of placeholders shaped like a day of takes. */
function GridSkeleton() {
  const rows = [
    [16 / 9, 16 / 9, 21 / 9],
    [2 / 3, 16 / 9, 16 / 9, 2 / 3],
    [21 / 9, 16 / 9, 1],
  ];
  return (
    <div aria-hidden="true">
      <div className="skeleton mb-3 h-5 w-28 rounded-[7px]" />
      <div className="flex flex-col" style={{ gap: GAP }}>
        {rows.map((row, r) => (
          <div key={r} className="flex h-[clamp(120px,17vw,300px)]" style={{ gap: GAP }}>
            {row.map((ratio, i) => (
              <div key={i} className="skeleton squircle rounded-[12px]" style={{ flex: `${ratio} ${ratio} 0%` }} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/** What the page looks like before it can read the address (it shows the same while loading). */
export function LibraryFallback() {
  return (
    <div className="mx-auto max-w-[2200px] px-4 pb-32 pt-6 sm:px-6 lg:px-10 lg:pt-10">
      <LibraryHeader query="" />
      <div className="-m-1 mt-6 flex gap-2.5 p-1">
        {Array.from({ length: 2 }, (_, i) => (
          <div key={i} className="skeleton squircle h-[58px] w-[188px] shrink-0 rounded-[17px]" />
        ))}
      </div>
      <div className="mt-5 flex gap-2">
        <div className="skeleton squircle h-10 w-[260px] rounded-[14px]" />
        <div className="skeleton squircle h-10 w-[130px] rounded-[14px]" />
      </div>
      <div className="mt-5">
        <GridSkeleton />
      </div>
    </div>
  );
}

function EmptyFolder({ folder, anything, filtered, onGeneral }: { folder: FolderInfo; anything: boolean; filtered: boolean; onGeneral: () => void }) {
  if (filtered) {
    return (
      <div className="mt-16 text-center">
        <p className="font-display text-[22px]">No matches</p>
        <p className="mt-2 text-[14px] text-fog">Try other words, or another filter.</p>
      </div>
    );
  }
  if (folder.project) {
    return (
      <div className="mx-auto mt-14 flex max-w-[420px] flex-col items-center text-center">
        <ProjectIcon icon={folder.icon} color={folder.color} size={64} tile />
        <p className="mt-5 font-display text-[22px]">Nothing in {folder.name} yet</p>
        <p className="mt-2 text-[14px] leading-relaxed text-fog">
          In General, drag takes onto this folder, or use <FolderInput size={13} className="inline -translate-y-px" /> Move in a card&rsquo;s menu or the viewer. Select picks several at once.
        </p>
        <button
          type="button"
          onClick={onGeneral}
          className="press squircle mt-5 inline-flex h-10 items-center rounded-btn bg-white/[0.06] px-4 text-[14px] font-semibold text-paper hover:bg-white/[0.1]"
        >
          Go to General
        </button>
      </div>
    );
  }
  if (anything) {
    return (
      <div className="mt-16 text-center">
        <p className="font-display text-[22px]">General is empty</p>
        <p className="mt-2 text-[14px] text-fog">Everything you&rsquo;ve made is filed in your projects.</p>
      </div>
    );
  }
  return (
    <div className="mt-16 text-center">
      <p className="font-display text-[22px]">Nothing here yet</p>
      <p className="mt-2 text-[14px] text-fog">Your generations will appear here as soon as you make one.</p>
      <Link
        href="/"
        className="lip press mt-5 inline-flex h-10 items-center rounded-btn bg-spike px-4 text-[14px] font-semibold text-spike-ink [--lip:var(--color-spike-lip)] hover:bg-spike-hi"
      >
        Make your first shot
      </Link>
    </div>
  );
}
