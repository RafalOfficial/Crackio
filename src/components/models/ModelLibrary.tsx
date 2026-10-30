"use client";

import Link from "next/link";
import { memo, useCallback, useDeferredValue, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { motion } from "motion/react";
import { createPortal } from "react-dom";
import { ArrowLeft, ArrowUpRight, Check, Cloud, CornerDownLeft, Cpu, Download, KeyRound, Layers, LoaderCircle, Monitor, Search, Sparkles, Square, TriangleAlert, X } from "lucide-react";
import { ModelLoras, useLoraCount } from "@/components/loras/ModelLoras";
import { takesLoras } from "@/lib/local/loras";
import { DEMO, demoWords } from "@/lib/demo/config";
import { TextCardPreview } from "./TextCardPreview";
import { VendorMark } from "@/components/brand/BrandMark";
import { ScrollRow } from "@/components/ui/ScrollRow";
import { floatingHost } from "@/components/ui/Popover";
import { reloadLocal, useLocalStore, useLocalWatch } from "@/lib/hooks/use-local";
import { revalidateModels, useModelsStore } from "@/lib/hooks/use-models";
import { setRunOn } from "@/lib/hooks/use-run-on";
import { useNow } from "@/lib/hooks/use-now";
import { useCoverPage } from "@/lib/hooks/use-overlay";
import { downloadGb, formatSeconds, mainGpu, shortGpuName } from "@/lib/local/fit";
import { byBest, fitRows, gb, installState, installedVariant, localAction, runsWell, stopDownloads, type Row } from "@/lib/local/rows";
import { NEW_DAYS, PREVIEW_OF, cardName, homeOf, previewSrc, type ModelHome } from "@/lib/models/gallery";
import { noteFor } from "@/lib/models/notes";
import { engineShortName } from "@/lib/providers/names";
import type { ModelAvailability, ModelKind } from "@/lib/models/catalog";
import type { ModelTask } from "@/lib/models/caps";
import type { CustomRow } from "@/lib/models/custom-types";
import type { LocalModel, LocalStatus, LocalTask, Machine, TargetStatus } from "@/lib/local/types";
import type { ClipFit } from "./ModelPicker";
import { cn } from "@/lib/cn";

/**
 * The model library: a sheet from the right with a card per model, its official ComfyUI preview behind its name (clips
 * play on hover), and what it is on hover: how good, how fast on your GPU, how big, what people say. Its tabs are where
 * models run: everything ready, each of your GPUs (what's installed there, and the best ones to install), Comfy Cloud,
 * and Get models: the open models that fit a GPU, installed in one click. Full screen on a phone.
 */

type Tab = "all" | "cloud" | "plans" | "get" | `gpu:${string}`;

/** A machine whose ComfyUI runs your open models. */
type Gpu = {
  /** Its ComfyUI's id (`TargetStatus.id`). */
  id: string;
  /** "RTX 5090"; its machine's name while it's offline. */
  gpu: string;
  /** "This computer", "vast.ai", "MacBook Air". */
  where: string;
  online: boolean;
  vram: number | null;
  machine: Machine | null;
  target: TargetStatus;
};

type Card = {
  key: string;
  /** What picking it sets; null when it has to be installed first. */
  id: string | null;
  name: string;
  maker: string;
  /** A ComfyUI template's preview (api/models/preview), or a picture's own address. */
  /** `clip`: a video template's loop plays on hover; `compare`: an upscaler's starting picture wipes to its result. */
  /** `text`: a text model's card types out a sample of its work instead (TextCardPreview). */
  preview: { template: string; clip: boolean; compare?: boolean } | { src: string } | { text: string } | null;
  home: ModelHome;
  /** Top-right: where it runs ("RTX 5090", "Comfy Cloud", "Grok"), or how well it fits a GPU. */
  badge?: { text: string; tone?: "good" | "ok" | "slow" | "no" };
  /** "~6 s", with what it's for. */
  time?: { text: string; title: string };
  blurb: string;
  quality: number | null;
  rank?: string;
  says?: string;
  released?: string;
  facts: string[];
  ready: boolean;
  reason?: string;
  tag?: string;
  fit?: ClipFit | null;
  /** Picking it on a GPU's tab sends its jobs to that GPU. */
  useOn?: Gpu;
  /** A model to install on a GPU. */
  install?: { row: Row; gpu: Gpu | null; hfToken: boolean };
  /** An open model that takes LoRAs (its `LocalModel.id`): its card opens its LoRA page. */
  lora?: string;
};

export type LibraryProps = {
  open: boolean;
  /**
   * Built ahead, hidden, once the pointer reaches the picker: opening then only starts the slide, with every card already
   * there, instead of rendering them in the frames the slide should be moving in.
   */
  primed?: boolean;
  /**
   * Draw it once now, unseen, while the page is idle: the first time a GPU draws its fonts and effects takes several
   * frames, and that shouldn't be the first slide anyone sees. Once a page load.
   */
  warm?: boolean;
  onClose: () => void;
  /** The trigger, so the sheet opens inside the dialog it sits in (a modal dialog makes the rest of the page inert). */
  anchor: HTMLElement | null;
  kind: ModelKind;
  task?: ModelTask;
  value: string;
  onChange: (id: string) => void;
  /** This tool's models (already narrowed to what it can use). */
  list: ModelAvailability[];
  /** Recommended models from providers' catalogs, first in All. */
  picks: CustomRow[];
  tags?: Record<string, string>;
  fit?: (id: string, caps: CustomRow["caps"]) => ClipFit | null;
  /** Home's composer: the sheet is smoked glass like the bar it opens from. */
  glass?: boolean;
};

const NOUN: Partial<Record<ModelKind, string>> = { image: "Image", video: "Video", upscale: "Upscale", reframe: "Reframe", text: "Text" };
const PER: Partial<Record<ModelKind, string>> = { image: "a picture", video: "a 5 s clip", upscale: "a 1 MP picture made 2×" };

/** What a tool's job needs from an open model. */
function localTasks(kind: ModelKind, task?: ModelTask): LocalTask[] {
  // Text models aren't installed from the open-model catalog: the one on your ComfyUI comes with picture models' files.
  if (kind === "text") return [];
  if (kind === "upscale") return ["upscale"];
  if (kind === "video") return task === "video-swap" ? ["swap"] : task === "video-edit" ? [] : ["video"];
  if (kind === "image") return task === "edit" || task === "retouch" ? ["edit"] : ["image"];
  return [];
}

function gpusOf(status: LocalStatus | null): Gpu[] {
  if (!status) return [];
  return status.targets
    .filter((t) => t.connected || !t.implicit)
    .map((t) => {
      const machine = status.machines.find((m) => m.target === t.id) ?? null;
      const g = machine ? mainGpu(machine) : undefined;
      if (t.id === "comfy-cloud") return { id: t.id, gpu: "Comfy Cloud", where: "Comfy's servers", online: t.connected, vram: null, machine, target: t };
      // The live demo's machine is the demo's GPU, whatever runs it.
      const where = DEMO
        ? "The demo's GPU"
        : t.cloud
        ? `${{ vast: "vast.ai", runpod: "RunPod", other: "Cloud GPU" }[t.cloud.provider]} · rented`
        : t.id.startsWith("runpod-")
          ? "RunPod · rented"
          : t.onThisComputer || t.source === "installed"
          ? "This computer"
          : t.label === "ComfyUI"
            ? new URL(t.url).hostname
            : t.label;
      return { id: t.id, gpu: g ? shortGpuName(g.name) : where, where, online: t.connected, vram: g?.memoryGb ?? null, machine, target: t };
    })
    .sort((a, b) => Number(b.online) - Number(a.online));
}

const time = (seconds: number, measured: boolean | undefined) => `${measured ? "" : "~"}${formatSeconds(seconds)}`;
const month = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString(undefined, { month: "short", year: "numeric" });
const LICENCE: Record<LocalModel["licence"]["commercial"], string> = { yes: "Commercial OK", limited: "Commercial, with limits", no: "Non-commercial" };
const FIT_BADGE: Record<Row["fit"]["state"], NonNullable<Card["badge"]>> = {
  great: { text: "Runs great", tone: "good" },
  ok: { text: "Runs well", tone: "ok" },
  slow: { text: "Runs, slower", tone: "slow" },
  no: { text: "Too big here", tone: "no" },
};

/** A ready model of this tool's list as a card. */
function modelCard(m: ModelAvailability, lm: LocalModel | undefined, extra: Partial<Card> = {}): Card {
  const home = homeOf(m);
  const note = noteFor(m.id);
  const template = lm?.thumb ?? PREVIEW_OF[m.id];
  return {
    key: m.id,
    id: m.id,
    name: cardName(lm?.name ?? m.name),
    maker: m.vendor,
    preview: template ? { template, clip: m.kind === "video", compare: m.kind === "upscale" } : m.kind === "text" ? { text: m.id } : null,
    home,
    badge: { text: home === "local" ? (m.localTime?.gpu ?? demoWords("Your GPU")) : home === "cloud" ? "Comfy Cloud" : engineShortName(m.via ?? m.providers[0]) },
    time: m.localTime ? { text: time(m.localTime.seconds, m.localTime.measured), title: `${PER[m.kind] ?? "a job"} on ${m.localTime.gpu}${m.localTime.measured ? ", measured" : ", estimated"}` } : undefined,
    blurb: m.bestFor,
    quality: note?.quality ?? (lm?.qualityKnown ? lm.quality : null),
    rank: note?.rank,
    says: note?.says,
    released: note?.released ?? lm?.released,
    facts: home === "local" ? [lm ? LICENCE[lm.licence.commercial] : "", lm?.audio ? "With sound" : ""].filter(Boolean) : home === "cloud" ? ["Paid in Comfy credits"] : [`On your ${engineShortName(m.via ?? m.providers[0])} ${(m.via ?? m.providers[0]).endsWith("-api") ? "key" : "plan"}`],
    ready: m.available,
    reason: m.reason,
    ...(lm && lm.crackio && takesLoras(lm) ? { lora: lm.id } : {}),
    ...extra,
  };
}

/** A model from a provider's catalog that a tool recommends (Templates' swap models). */
function pickCard(row: CustomRow, tag?: string, fit?: ClipFit | null): Card {
  const note = noteFor(row.id);
  const template = PREVIEW_OF[row.id];
  return {
    key: `pick:${row.id}`,
    id: row.id,
    name: cardName(row.name),
    maker: row.vendor,
    preview: template ? { template, clip: true } : row.thumbnail ? { src: row.thumbnail } : null,
    home: row.provider === "comfy-local" ? "local" : row.provider === "comfy-cloud" ? "cloud" : "plan",
    badge: { text: engineShortName(row.provider) },
    blurb: row.description,
    quality: note?.quality ?? null,
    rank: note?.rank,
    says: note?.says,
    released: note?.released,
    facts: [row.price ?? "", ...row.badges.slice(0, 2)].filter(Boolean),
    ready: row.available,
    reason: row.reason,
    tag,
    fit,
  };
}

/** An open model on one GPU: installed there (to use, its jobs sent there), or to install. */
function rowCard(r: Row, g: Gpu, ready: ModelAvailability | undefined, hfToken: boolean, kind: ModelKind): Card {
  const { model, fit } = r;
  const id = model.crackio ?? null;
  const note = id ? noteFor(id) : undefined;
  const installed = Boolean(installedVariant(model, g.target));
  const v = fit.variant;
  return {
    key: `${g.id}:${model.id}`,
    id,
    name: cardName(model.name),
    maker: model.maker,
    preview: model.thumb ? { template: model.thumb, clip: model.unit === "clip", compare: model.tasks.includes("upscale") } : null,
    home: "local",
    badge: installed ? (fit.seconds !== null ? undefined : { text: g.gpu }) : r.blocked ? { text: "Not licensed here", tone: "no" } : fit.pool ? { text: "Runs pooled", tone: "ok" } : FIT_BADGE[fit.state],
    time: fit.seconds !== null && fit.state !== "no" ? { text: time(fit.seconds, fit.measured), title: `${PER[kind] ?? "a job"} on ${g.gpu}${fit.measured ? ", measured" : ", estimated"}` } : undefined,
    blurb: model.blurb,
    quality: note?.quality ?? (model.qualityKnown ? model.quality : null),
    rank: note?.rank,
    says: note?.says,
    released: note?.released ?? model.released,
    facts: [v ? `${v.label} · ${gb(downloadGb(v))}` : "", LICENCE[model.licence.commercial], model.audio ? "With sound" : ""].filter(Boolean),
    // Installed here: ready, even before the tools' list hears of a model installed a moment ago.
    ready: installed && (ready?.available ?? true),
    reason: installed ? undefined : fit.why,
    useOn: installed ? g : undefined,
    install: installed ? undefined : { row: r, gpu: g.online ? g : null, hfToken },
    ...(installed && id && takesLoras(model) ? { lora: model.id } : {}),
  };
}

/** A screen without hover (a phone or tablet). */
const hoverless = (changed: () => void) => {
  const q = window.matchMedia("(hover: none)");
  q.addEventListener("change", changed);
  return () => q.removeEventListener("change", changed);
};
function useTouch() {
  return useSyncExternalStore(
    hoverless,
    () => window.matchMedia("(hover: none)").matches,
    () => false,
  );
}

const byQuality = (a: Card, b: Card) => (b.quality ?? -1) - (a.quality ?? -1) || a.name.localeCompare(b.name);

/** In from the right edge, easing to a stop; back out the whole way, gathering speed. The shade behind fades with it. */
const SLIDE_IN: KeyframeAnimationOptions = { duration: 460, easing: "cubic-bezier(0.32, 0.72, 0, 1)" };
const SLIDE_OUT: KeyframeAnimationOptions = { duration: 280, easing: "cubic-bezier(0.3, 0, 0.8, 0.15)", fill: "forwards" };
const SHADE_IN: KeyframeAnimationOptions = { duration: 460, easing: "cubic-bezier(0.32, 0.72, 0, 1)" };
const SHADE_OUT: KeyframeAnimationOptions = { duration: 280, easing: "cubic-bezier(0.2, 0, 0, 1)", fill: "forwards" };

/** What Tab moves between inside the drawer. */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

/** The library has been drawn once on this page (`warm`): every later open finds the GPU ready. */
let warmed = false;

/**
 * The drawer itself: a layer of its own over the page with a shade behind it, not a modal <dialog>. Opening or closing a
 * modal makes the whole page inert or live again, and the browser repaints all of it, the sidebar's icons included,
 * while the drawer is still moving; this way only the drawer and its shade change. It keeps a modal's manners: focus
 * stays inside (Tab wraps), Escape and a click on the shade close it, focus goes back to the picker.
 */
export function ModelLibrary({ open, primed = false, warm = false, onClose, anchor, glass, ...content }: LibraryProps) {
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const shade = useRef<HTMLDivElement>(null);
  const shown = useRef(false);
  const closing = useRef(false);
  const back = useRef<HTMLElement | null>(null);
  // A model's LoRA page, opened from its card (its LocalModel id); closing the sheet goes back to the cards.
  const [loraOf, setLoraOf] = useState<string | null>(null);
  // It lives where its trigger does: inside a modal dialog when the picker sits in one (the rest of the page is inert then).
  const host = (open || primed) && anchor ? floatingHost(anchor) : null;
  useCoverPage(open);
  // Your machines stay fresh while it's open (the cards read them from the shared store); the first look waits until it has
  // slid in, so new numbers don't redraw it mid-slide.
  useLocalWatch(open, 700);
  // The model list too, at the same moment: one installed since the page loaded joins the cards.
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => revalidateModels(), 700);
    return () => clearTimeout(t);
  }, [open]);
  const onCloseRef = useRef(onClose);
  useLayoutEffect(() => {
    onCloseRef.current = onClose;
  });

  // The unseen first draw: shown in place at all but no opacity, out of reach of the pointer and the keyboard, then hidden.
  useLayoutEffect(() => {
    const r = root.current;
    if (!r || !warm || open || warmed) return;
    warmed = true;
    r.inert = true;
    r.setAttribute("data-warming", "");
    r.hidden = false;
    const done = () => {
      if (!r.hasAttribute("data-warming")) return;
      r.hidden = true;
      r.removeAttribute("data-warming");
      r.inert = false;
    };
    // Its first screen of pictures decoded (two seconds at most) and drawn, then hidden again.
    let live = true;
    const pictures = [...r.querySelectorAll("img")].slice(0, 18).map((img) => {
      // Lazy pictures wait to be scrolled to: these load now.
      img.loading = "eager";
      return img.decode().catch(() => undefined);
    });
    void Promise.race([Promise.all(pictures), new Promise((done) => setTimeout(done, 2000))])
      .then(() => new Promise((next) => requestAnimationFrame(() => requestAnimationFrame(next))))
      .then(() => live && setTimeout(done, 120));
    return () => {
      live = false;
      done();
    };
  }, [warm, open, host]);

  useLayoutEffect(() => {
    const r = root.current;
    const p = panel.current;
    const sh = shade.current;
    if (!r || !p || !sh || !open || shown.current) return;
    shown.current = true;
    back.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    r.removeAttribute("data-warming");
    r.inert = false;
    r.hidden = false;
    // Typing searches on a desktop; on a phone the drawer takes focus instead, so no keyboard pops up.
    const search = p.querySelector<HTMLElement>("[data-autofocus]");
    (search?.offsetParent ? search : p).focus({ preventScroll: true });
    sh.animate([{ opacity: 0 }, { opacity: 1 }], SHADE_IN);
    // Drawing the drawer takes the GPU a few frames, and a slide started meanwhile jumps ahead to catch up. So it's drawn
    // first where it ends up, all but invisible, and slides in from the edge once that drawing is on screen: a still
    // animation of it is "ready" only when the compositor runs it, which waits for the drawing.
    p.style.opacity = "0.002";
    const probe = p.animate([{ transform: "translateX(0)" }, { transform: "translateX(0)" }], { duration: 1000, fill: "forwards" });
    let live = true;
    void probe.ready
      .then(() => new Promise((next) => requestAnimationFrame(next)))
      .then(() => {
        if (!live) return;
        p.animate([{ transform: "translateX(100%)" }, { transform: "translateX(0)" }], SLIDE_IN);
        p.style.opacity = "";
        probe.cancel();
      });
    return () => {
      live = false;
      probe.cancel();
      p.style.opacity = "";
    };
  }, [open, host]);

  // Slides all the way back out, then hides; the drawer stays built for next time.
  const close = useCallback(() => {
    const r = root.current;
    const p = panel.current;
    const sh = shade.current;
    if (!r || !p || !sh || closing.current || !shown.current) return;
    closing.current = true;
    sh.animate([{ opacity: 1 }, { opacity: 0 }], SHADE_OUT);
    const out = p.animate([{ transform: "translateX(0)" }, { transform: "translateX(100%)" }], SLIDE_OUT);
    void out.finished
      .catch(() => undefined)
      .then(() => {
        r.hidden = true;
        for (const a of [...p.getAnimations(), ...sh.getAnimations()]) a.cancel();
        closing.current = false;
        shown.current = false;
        const to = back.current;
        back.current = null;
        if (to?.isConnected) to.focus({ preventScroll: true });
        setLoraOf(null);
        onCloseRef.current();
      });
  }, []);

  // Escape closes it (and not a dialog it opened from); Tab goes round inside it.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const p = panel.current;
      if (!p) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close();
        return;
      }
      if (e.key !== "Tab") return;
      const items = [...p.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      const at = document.activeElement;
      const outside = !p.contains(at);
      if (e.shiftKey ? outside || at === first || at === p : outside || at === last) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, close]);

  if (!host) return null;
  return createPortal(
    <div ref={root} hidden className="model-library-root" data-glass={glass || undefined}>
      <div ref={shade} className="model-library-shade" onClick={close} aria-hidden="true" />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={`Choose ${content.kind === "image" ? "an image" : content.kind === "upscale" ? "an upscale" : content.kind === "video" ? "a video" : content.kind === "text" ? "a text" : "a"} model`}
        tabIndex={-1}
        className="model-library outline-none"
      >
        <Library {...content} onClose={close} loraOf={loraOf} onLoraOf={setLoraOf} />
      </div>
    </div>,
    host,
  );
}

type ContentProps = Omit<LibraryProps, "open" | "primed" | "anchor" | "glass"> & { loraOf: string | null; onLoraOf: (id: string | null) => void };

/** What's in the sheet. Memoized: opening and closing it doesn't render a single card again. */
const Library = memo(function Library({ kind, task, value, onChange, onClose, list, picks, tags, fit, loraOf, onLoraOf: setLoraOf }: ContentProps) {
  const { status, catalog, error: localError } = useLocalStore();
  // The first frames carry only the header and placeholders, so the slide starts at once; the cards follow.
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    let next = 0;
    const first = requestAnimationFrame(() => {
      next = requestAnimationFrame(() => setSettled(true));
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(next);
    };
  }, []);
  const tabsId = useId();
  const refreshModels = useModelsStore((s) => s.refresh);
  const known = useModelsStore((s) => s.models);
  const now = useNow();
  const touch = useTouch();
  const [tab, setTab] = useState<Tab>("all");
  const [query, setQuery] = useState("");
  const search = useDeferredValue(query.trim().toLowerCase());
  const [getOn, setGetOn] = useState<string | null>(null);
  const [onlyRuns, setOnlyRuns] = useState(true);
  const [onlyCommercial, setOnlyCommercial] = useState(false);

  const gpus = useMemo(() => gpusOf(status), [status]);
  const online = gpus.filter((g) => g.online);
  const wants = localTasks(kind, task);
  const byCrackio = useMemo(() => new Map((catalog ?? []).map((m) => [m.crackio ?? `local:${m.id}`, m])), [catalog]);
  const listed = useMemo(() => new Map(list.map((m) => [m.id, m])), [list]);
  const knownIds = useMemo(() => new Set(known.map((m) => m.id)), [known]);
  // The open models this tool can use: what it does, and once Crackio knows one (installed somewhere), what the tool's
  // list allows (an edit tool leaves out models that only make pictures from words).
  const fitsTool = (m: LocalModel) => m.tasks.some((t) => wants.includes(t)) && (!m.crackio || listed.has(m.crackio) || !knownIds.has(m.crackio));

  // Every model on each GPU (local/rows), for the GPU tabs and Get models.
  const rowsByGpu = useMemo(() => {
    const out = new Map<string, Row[]>();
    if (!catalog || !settled) return out;
    for (const g of gpus) if (g.machine) out.set(g.id, fitRows({ machine: g.machine, catalog, target: g.target, status }));
    return out;
  }, [gpus, catalog, status, settled]);

  // Get models installs on: the one picked, else where jobs run, else this computer, else the first online GPU.
  const getGpu = online.find((g) => g.id === getOn) ?? online.find((g) => g.id === status?.runOn) ?? online.find((g) => g.where === "This computer") ?? online[0] ?? null;
  // Without any ComfyUI yet: what this computer could run, to set one up.
  const thisComputer = status?.machines.find((m) => m.where === "this-computer") ?? null;

  const cards = useMemo(() => {
    const local = list.filter((m) => m.available && homeOf(m) === "local").map((m) => modelCard(m, byCrackio.get(m.id)));
    const cloud = list.filter((m) => homeOf(m) === "cloud").map((m) => modelCard(m, undefined));
    const plans = list.filter((m) => homeOf(m) === "plan").map((m) => modelCard(m, undefined));
    const best = picks.map((r) => pickCard(r, tags?.[r.id], fit?.(r.id, r.caps)));
    const withFit = (c: Card) => (fit && c.id && !c.fit ? { ...c, fit: fit(c.id, listed.get(c.id)?.caps ?? null) } : c);
    return {
      best: best.map(withFit),
      local: local.sort(byQuality).map(withFit),
      cloud: cloud.sort((a, b) => Number(b.ready) - Number(a.ready) || byQuality(a, b)).map(withFit),
      plans: plans.sort((a, b) => Number(b.ready) - Number(a.ready) || byQuality(a, b)).map(withFit),
    };
  }, [list, picks, tags, fit, byCrackio, listed]);

  const gpuCards = (g: Gpu) => {
    const rows = (rowsByGpu.get(g.id) ?? []).filter((r) => fitsTool(r.model));
    const here = rows.filter((r) => installedVariant(r.model, g.target)).map((r) => rowCard(r, g, r.model.crackio ? listed.get(r.model.crackio) : undefined, Boolean(status?.hfToken), kind));
    const toGet = rows
      .filter((r) => !installedVariant(r.model, g.target) && !r.blocked && runsWell(r.fit))
      .sort(byBest)
      .map((r) => rowCard(r, g, undefined, Boolean(status?.hfToken), kind));
    return { here: here.sort(byQuality), toGet };
  };

  const getCards = (() => {
    const machine = getGpu?.machine ?? thisComputer;
    if (!machine || !catalog) return [];
    const g: Gpu = getGpu ?? { id: "this-computer", gpu: mainGpu(machine) ? shortGpuName(mainGpu(machine)!.name) : "This computer", where: "This computer", online: false, vram: null, machine, target: { id: "this-computer", label: "This computer", url: "", source: "main", connected: false, onThisComputer: true, bridge: null, installed: [], downloads: [], measured: {} } };
    const rows = (getGpu ? (rowsByGpu.get(getGpu.id) ?? []) : fitRows({ machine, catalog, target: null, status }))
      .filter((r) => fitsTool(r.model) && !r.blocked && !installedVariant(r.model, g.target))
      .filter((r) => !onlyRuns || runsWell(r.fit))
      .filter((r) => !onlyCommercial || r.model.licence.commercial !== "no")
      .sort(byBest);
    return rows.map((r) => rowCard(r, g, undefined, Boolean(status?.hfToken), kind));
  })();

  const matches = (c: Card) => {
    if (!search) return true;
    const hay = `${c.name} ${c.maker} ${c.blurb} ${c.says ?? ""} ${c.facts.join(" ")}`.toLowerCase();
    return search.split(/\s+/).every((w) => hay.includes(w));
  };

  // Picked on one GPU's tab (with more than one online): its jobs go to that GPU.
  const sendTo = async (g: Gpu | null | undefined) => {
    if (g && online.length > 1 && g.id !== status?.runOn) await setRunOn(g.id).catch(() => undefined);
  };

  const pick = async (c: Card) => {
    if (!c.id || !c.ready) return;
    await sendTo(c.useOn);
    // Installed a moment ago: the tools' model list hears of it first.
    if (!listed.has(c.id) && c.home === "local") await refreshModels();
    onChange(c.id);
    onClose();
  };

  // A model that just finished installing joins the tool's list, then gets picked.
  const pickInstalled = async (c: Card) => {
    if (!c.id) return;
    await refreshModels();
    await sendTo(c.install?.gpu);
    onChange(c.id);
    onClose();
  };

  const counts = {
    all: cards.best.length + cards.local.length + cards.cloud.filter((c) => c.ready).length + cards.plans.filter((c) => c.ready).length,
    cloud: cards.cloud.length,
    plans: cards.plans.length,
  };
  const comfyKey = cards.cloud.some((c) => c.ready);
  const noun = NOUN[kind] ?? "";

  const grid = (items: Card[], opts: { install?: boolean } = {}) =>
    items.filter(matches).length ? (
      <CardGrid>
        {items.filter(matches).map((c) => (
          <LibraryCard
            key={c.key}
            card={c}
            selected={c.id === value && !c.install}
            now={now}
            touch={touch}
            onPick={() => void pick(c)}
            onUseInstalled={() => void pickInstalled(c)}
            installMode={opts.install}
            // The live demo has no downloads (lib/demo/routes): no LoRA pages there.
            onLoras={c.lora && !DEMO ? () => setLoraOf(c.lora!) : undefined}
          />
        ))}
      </CardGrid>
    ) : null;

  let body: ReactNode;
  if (tab === "all") {
    const nothing = !cards.best.length && !cards.local.length && !cards.cloud.some((c) => c.ready) && !cards.plans.some((c) => c.ready);
    const text = kind === "text";
    body = (
      <>
        <Section title="Best for this" items={cards.best} search={search} render={grid} />
        <Section title={DEMO ? "On the demo's GPU" : "On your GPUs"} hint={gpus.length ? undefined : "Install open models to run them free"} items={cards.local} search={search} render={grid} />
        <Section title="Comfy Cloud" items={cards.cloud.filter((c) => c.ready)} search={search} render={grid} />
        <Section title="Your plans" items={cards.plans.filter((c) => c.ready)} search={search} render={grid} />
        {nothing ? (
          <Empty
            title={`No ${noun.toLowerCase()} model is ready yet`}
            body={
              text
                ? "Add a Comfy key for the hosted models (Claude, Gemini, DeepSeek), or put Qwen 3.5 9B or Qwen3-VL 8B in your ComfyUI to write for free."
                : "Install an open model on your GPU (free), or add a Comfy key for the cloud models."
            }
            actions={
              <>
                {text ? null : (
                  <button type="button" onClick={() => setTab("get")} className="lip press inline-flex h-10 items-center gap-2 rounded-btn bg-spike px-4 text-[13px] font-bold text-spike-ink [--lip:var(--color-spike-lip)] hover:bg-spike-hi">
                    <Download size={15} /> Get models
                  </button>
                )}
                <Link href="/settings/connections" className="press inline-flex h-10 items-center gap-2 rounded-btn bg-white/[0.07] px-4 text-[13px] font-semibold hover:bg-white/[0.12]">
                  <KeyRound size={15} /> Add a Comfy key
                </Link>
              </>
            }
          />
        ) : search && ![...cards.best, ...cards.local, ...cards.cloud.filter((c) => c.ready), ...cards.plans.filter((c) => c.ready)].some(matches) ? (
          text ? (
            <Empty title={`Nothing ready matches “${query.trim()}”`} body="Try another word, or see the Comfy Cloud tab." />
          ) : (
            <Empty title={`Nothing ready matches “${query.trim()}”`} body="Get models has every open model you could install." actions={<GhostButton onClick={() => setTab("get")}>Search Get models</GhostButton>} />
          )
        ) : null}
      </>
    );
  } else if (tab.startsWith("gpu:")) {
    const g = gpus.find((x) => `gpu:${x.id}` === tab);
    if (!g) body = null;
    else if (!g.online)
      body = <Empty title={`${g.where} is offline`} body="Its models come back when its ComfyUI does. Start it, or check it on the Local page." actions={<GhostLink href="/local">Open Local</GhostLink>} />;
    else {
      const { here, toGet } = gpuCards(g);
      body = (
        <>
          <GpuLine g={g} runOn={status?.runOn ?? "auto"} />
          <Section title={`Installed on ${g.gpu}`} hint="Picking one here runs it on this GPU" items={here} search={search} render={grid} />
          {!here.length && !search ? <Empty title={`No ${noun.toLowerCase()} model on ${g.gpu} yet`} body="These run well on it. Install one: it's free, and it stays." /> : null}
          {toGet.length ? (
            <Section
              title={`Best to install on ${g.gpu}`}
              action={
                <GhostButton
                  onClick={() => {
                    setGetOn(g.id);
                    setTab("get");
                  }}
                >
                  See all
                </GhostButton>
              }
              items={toGet.slice(0, here.length ? 4 : 8)}
              search={search}
              render={(items) => grid(items, { install: true })}
            />
          ) : null}
        </>
      );
    }
  } else if (tab === "cloud") {
    body = (
      <>
        {comfyKey ? null : (
          <Banner icon={<Cloud size={16} />} action={<GhostLink href="/settings/connections">Add a Comfy key</GhostLink>}>
            These run on Comfy Cloud: no GPU needed, paid per job in Comfy credits. Add your Comfy key to use them.
          </Banner>
        )}
        {grid(cards.cloud) ?? <Empty title="No cloud model matches" body="Try another word." />}
      </>
    );
  } else if (tab === "plans") {
    body = grid(cards.plans) ?? <Empty title="No plan model matches" body="Try another word." />;
  } else {
    body = (
      <>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="flex items-center gap-2">
            <span className="text-[12.5px] text-haze">Install on</span>
            {online.length ? (
              <div role="radiogroup" aria-label="Install on" className="flex rounded-[12px] bg-white/[0.05] p-[3px]">
                {online.map((g) => {
                  const on = g.id === getGpu?.id;
                  return (
                    <button
                      key={g.id}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      onClick={() => setGetOn(g.id)}
                      className={cn(
                        "press squircle h-8 rounded-[9px] px-3 text-[12.5px] font-semibold",
                        on ? "bg-white/[0.13] text-paper shadow-[inset_0_1px_0_rgb(255_255_255/0.08),0_1px_2px_rgb(0_0_0/0.25)]" : "text-fog hover:text-paper",
                      )}
                    >
                      {g.gpu}
                      <span className="ml-1.5 font-medium text-haze">{g.where}</span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <span className="text-[12.5px] text-fog">{thisComputer ? "this computer, once ComfyUI is on it" : "a computer with ComfyUI"}</span>
            )}
          </div>
          <div className="flex items-center gap-1">
            <CheckToggle on={onlyRuns} onClick={() => setOnlyRuns(!onlyRuns)}>
              Runs well there
            </CheckToggle>
            <CheckToggle on={onlyCommercial} onClick={() => setOnlyCommercial(!onlyCommercial)}>
              Commercial use
            </CheckToggle>
          </div>
        </div>
        {!online.length ? (
          <Banner icon={<Monitor size={16} />} action={<GhostLink href="/local">Set up ComfyUI</GhostLink>}>
            Open models run in ComfyUI. Crackio installs it for you on the Local page, then installs any model here in one click.
          </Banner>
        ) : null}
        {grid(getCards, { install: true }) ?? (
          <Empty
            title={search ? `Nothing to install matches “${query.trim()}”` : "Nothing more to install here"}
            body={onlyRuns ? "Turn off “Runs well there” to see models that run slowly on this GPU." : "Every model for this job is installed."}
          />
        )}
      </>
    );
  }

  const planNames = [...new Set(cards.plans.map((c) => c.badge?.text).filter(Boolean))];
  const tabs: TabItem[] = [
    { id: "all", label: "All ready", caption: `${counts.all} model${counts.all === 1 ? "" : "s"}`, icon: <Sparkles size={15} /> },
    // Each GPU by its card's name, with its memory and where it is; a dot says whether it's online. Text models have no
    // GPU tabs: the one on your ComfyUI shows under All ready.
    ...(kind === "text" ? [] : gpus).map(
      (g): TabItem => ({
        id: `gpu:${g.id}`,
        label: g.gpu,
        caption: g.online ? [g.vram ? gb(g.vram) : null, g.where].filter(Boolean).join(" · ") : "Offline",
        count: g.online && settled ? (rowsByGpu.get(g.id) ?? []).filter((r) => fitsTool(r.model) && installedVariant(r.model, g.target)).length : undefined,
        icon: <Cpu size={15} />,
        dot: g.online ? "on" : "off",
        off: !g.online,
      }),
    ),
    ...(counts.cloud ? [{ id: "cloud" as Tab, label: "Comfy Cloud", caption: comfyKey ? `${counts.cloud} models` : "Needs a Comfy key", icon: <Cloud size={15} /> }] : []),
    ...(counts.plans
      ? [
          {
            id: "plans" as Tab,
            label: "Your plans",
            caption: planNames.join(", ") || `${counts.plans} models`,
            icon: planNames.length === 1 && planNames[0] === "Grok" ? <VendorMark vendor="xAI" model="Grok" variant="bare" size={15} /> : <KeyRound size={15} />,
          },
        ]
      : []),
  ];

  // A model's LoRA page: its picks, yours, a Hugging Face search (components/loras/ModelLoras); back goes to the cards.
  const loraModel = loraOf ? (catalog?.find((m) => m.id === loraOf) ?? null) : null;
  if (loraModel) {
    const ready = Boolean(loraModel.crackio && listed.get(loraModel.crackio)?.available);
    const chosen = loraModel.crackio === value;
    return (
      <div data-sheet tabIndex={-1} className="@container flex h-full min-h-0 flex-col outline-none">
        <header className="shrink-0 px-4 pt-4 sm:px-6 sm:pt-6">
          <div className="flex items-center gap-2.5">
            <button type="button" onClick={() => setLoraOf(null)} aria-label="Back to the models" className="press grid size-10 shrink-0 place-items-center rounded-full bg-white/[0.06] text-fog hover:bg-white/[0.12] hover:text-paper">
              <ArrowLeft size={17} />
            </button>
            <div className="min-w-0 flex-1">
              <h2 className="truncate font-display text-[22px] leading-[1.2] sm:text-[24px]">{cardName(loraModel.name)} LoRAs</h2>
              <p className="mt-0.5 truncate text-[12.5px] text-haze">Add-ons that change how it draws, on every job it runs</p>
            </div>
            {ready ? (
              <button
                type="button"
                onClick={() => {
                  onChange(loraModel.crackio!);
                  onClose();
                }}
                className="press inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full bg-paper px-3.5 text-[13px] font-bold text-[#16131b] hover:bg-white"
              >
                {chosen ? <Check size={14} strokeWidth={3} /> : <CornerDownLeft size={14} strokeWidth={2.6} />}
                <span className="hidden @min-[440px]:inline">{chosen ? "Done" : "Use it"}</span>
              </button>
            ) : null}
            <button type="button" onClick={onClose} aria-label="Close" className="press grid size-10 shrink-0 place-items-center rounded-full bg-white/[0.06] text-fog hover:bg-white/[0.12] hover:text-paper">
              <X size={17} />
            </button>
          </div>
          <div className="mt-3.5 h-px bg-line" />
        </header>
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-6 pt-4 sm:px-6">
          <ModelLoras model={loraModel} compact />
          <footer className="mt-8 flex flex-wrap items-center justify-end gap-2 border-t border-line pt-3 text-[12.5px]">
            <Link href="/local#loras" onClick={onClose} className="inline-flex items-center gap-1 font-semibold text-haze hover:text-paper">
              Every model&rsquo;s LoRAs <ArrowUpRight size={13} />
            </Link>
          </footer>
        </div>
      </div>
    );
  }

  return (
    <div data-sheet tabIndex={-1} className="@container flex h-full min-h-0 flex-col outline-none">
      <header className="shrink-0 px-4 pt-4 sm:px-6 sm:pt-6">
        <div className="flex items-center gap-2.5">
          <div className="min-w-0 flex-1">
            <h2 className="truncate font-display text-[22px] leading-[1.2] sm:text-[24px]">{tab === "get" ? `Get ${noun.toLowerCase()} models` : `${noun} models`}</h2>
            <p className="mt-0.5 truncate text-[12.5px] text-haze">
              {tab === "get" ? "Open models in the version that fits your GPU, set up in one click" : touch ? "Tap a card for what it's like" : "Hover a card for what it's like"}
            </p>
          </div>
          {wants.length ? (
            <button
              type="button"
              onClick={() => setTab(tab === "get" ? "all" : "get")}
              aria-pressed={tab === "get"}
              // Never outlined: focus shows as a brighter fill.
              className={cn(
                "press inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-bold outline-none focus-visible:outline-none",
                tab === "get" ? "bg-spike text-spike-ink focus-visible:bg-spike-hi" : "bg-spike/[0.13] text-spike hover:bg-spike/[0.2] focus-visible:bg-spike/[0.24]",
              )}
            >
              <Download size={15} strokeWidth={2.4} />
              <span className="hidden @min-[440px]:inline @min-[640px]:hidden @min-[760px]:inline">Get models</span>
            </button>
          ) : null}
          <label className="field-focus hidden h-10 w-[min(260px,30vw)] items-center gap-2 rounded-full bg-white/[0.06] px-3.5 sm:flex">
            <Search size={15} className="shrink-0 text-haze" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={tab === "get" ? "Search open models" : `Search ${noun.toLowerCase()} models`}
              aria-label="Search models"
              // Focused as the sheet opens on a desktop (ModelLibrary); hidden on a phone.
              data-autofocus
              className="min-w-0 flex-1 bg-transparent text-[13.5px] text-paper outline-none placeholder:text-haze"
            />
            {query ? (
              <button type="button" onClick={() => setQuery("")} aria-label="Clear the search" className="press text-haze hover:text-paper">
                <X size={14} />
              </button>
            ) : null}
          </label>
          <button type="button" onClick={onClose} aria-label="Close" className="press grid size-10 shrink-0 place-items-center rounded-full bg-white/[0.06] text-fog hover:bg-white/[0.12] hover:text-paper">
            <X size={17} />
          </button>
        </div>
        <label className="field-focus mt-3 flex h-10 items-center gap-2 rounded-full bg-white/[0.06] px-3.5 sm:hidden">
          <Search size={15} className="shrink-0 text-haze" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search models" aria-label="Search models" className="min-w-0 flex-1 bg-transparent text-[14px] text-paper outline-none placeholder:text-haze" />
        </label>
        <div className="relative mt-3.5">
          <ScrollRow trackClassName="gap-1">
            {tabs.map((t, i) => (
              <span key={t.id} className="contents">
                {/* Where the GPUs go, while Crackio reads your machines. */}
                {i === 1 && !status && !localError && kind !== "text" ? (
                  <TabButton item={{ id: "all", label: "Your GPUs", caption: "Finding them…", icon: <LoaderCircle size={15} className="animate-spin" /> }} on={false} layout={tabsId} />
                ) : null}
                <TabButton item={t} on={tab === t.id} layout={tabsId} onClick={() => setTab(t.id)} />
              </span>
            ))}
          </ScrollRow>
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-line" />
        </div>
      </header>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-6 pt-4 sm:px-6">
        <div className="space-y-5">
          {settled ? (
            body
          ) : (
            <CardGrid>
              {Array.from({ length: 6 }, (_, i) => (
                <div key={i} className="squircle aspect-[4/5] rounded-[18px] bg-white/[0.035]" />
              ))}
            </CardGrid>
          )}
        </div>
        <footer className="mt-8 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3 text-[12.5px]">
          <Link href="/settings/models" onClick={onClose} className="font-semibold text-haze hover:text-paper">
            Default models
          </Link>
          <Link href="/local" onClick={onClose} className="inline-flex items-center gap-1 font-semibold text-haze hover:text-paper">
            Machines and installs <ArrowUpRight size={13} />
          </Link>
        </footer>
      </div>
    </div>
  );
});

function Section({ title, hint, action, items, search, render }: { title: string; hint?: string; action?: ReactNode; items: Card[]; search: string; render: (items: Card[]) => ReactNode }) {
  const shown = render(items);
  if (!items.length || !shown) return null;
  return (
    <section>
      <div className="mb-2.5 flex items-end justify-between gap-3">
        <h3 className="label">
          {title}
          {hint ? <span className="ml-2 font-medium normal-case tracking-normal text-haze/80">{hint}</span> : null}
        </h3>
        {action && !search ? action : null}
      </div>
      {shown}
    </section>
  );
}

/** Cards in as many columns as the sheet's width holds: 2 on a phone, 3 to 5 on a desktop. Arrow keys move between them. */
function CardGrid({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const onKey = (e: React.KeyboardEvent) => {
    const grid = ref.current;
    if (!grid || !["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp"].includes(e.key)) return;
    const mains = [...grid.querySelectorAll<HTMLElement>("[data-card-main]")];
    const at = mains.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    const cols = getComputedStyle(grid).gridTemplateColumns.split(" ").length || 1;
    const to = at + ({ ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols } as Record<string, number>)[e.key];
    if (to < 0 || to >= mains.length) return;
    e.preventDefault();
    mains[to].focus();
  };
  return (
    <div ref={ref} onKeyDown={onKey} className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2.5 sm:grid-cols-[repeat(auto-fill,minmax(184px,1fr))] sm:gap-3">
      {children}
    </div>
  );
}

type TabItem = { id: Tab; label: string; caption: string; icon: ReactNode; count?: number; dot?: "on" | "off"; off?: boolean };

/** A tab: its icon on a small tile, its name over a line of detail, and the spike underline that slides to the open one. */
function TabButton({ item, on, layout, onClick }: { item: TabItem; on: boolean; layout: string; onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      aria-pressed={onClick ? on : undefined}
      className={cn(
        "group/tab relative flex shrink-0 items-center gap-2.5 rounded-[12px] px-2.5 pb-3 pt-1 text-left outline-none transition-[color,opacity] duration-200 focus-visible:bg-white/[0.05]",
        on ? "text-paper" : "text-fog hover:text-paper",
        item.off && !on && "opacity-55",
      )}
    >
      <span
        className={cn(
          "squircle relative grid size-8 shrink-0 place-items-center rounded-[10px] transition-colors duration-200",
          on ? (item.id === "all" ? "bg-spike/[0.16] text-spike" : "bg-white/[0.12] text-paper") : "bg-white/[0.045] text-haze group-hover/tab:bg-white/[0.08] group-hover/tab:text-fog",
        )}
      >
        {item.icon}
        {item.dot ? (
          <i
            className={cn(
              "absolute -right-[3px] -top-[3px] size-[9px] rounded-full ring-2 ring-[var(--color-flat)]",
              item.dot === "on" ? "bg-chroma shadow-[0_0_6px_rgb(90_215_143/0.6)]" : "bg-haze",
            )}
          />
        ) : null}
      </span>
      <span className="min-w-0">
        <span className="flex items-baseline gap-1.5 whitespace-nowrap text-[13px] font-semibold leading-[1.3]">
          {item.label}
          {item.count !== undefined ? <span className="tabular text-[11px] font-medium text-haze">{item.count}</span> : null}
        </span>
        <span className="block whitespace-nowrap text-[11px] leading-[1.3] text-haze">{item.caption}</span>
      </span>
      {on ? <motion.span layoutId={`${layout}-tab`} transition={{ type: "spring", stiffness: 520, damping: 42 }} className="absolute inset-x-2 bottom-0 h-[2px] rounded-full bg-spike" /> : null}
    </button>
  );
}

/** A filter that's on or off: a small check box and its words, not another pill. */
function CheckToggle({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" role="switch" aria-checked={on} onClick={onClick} className="press inline-flex h-8 items-center gap-2 rounded-[10px] px-2 text-[12.5px] font-semibold text-fog hover:bg-white/[0.04] hover:text-paper">
      <span
        className={cn(
          "grid size-4 place-items-center rounded-[5px] transition-colors duration-150",
          on ? "bg-spike text-spike-ink" : "shadow-[inset_0_0_0_1.5px_rgb(255_255_255/0.28)]",
        )}
      >
        {on ? <Check size={11} strokeWidth={3.5} /> : null}
      </span>
      {children}
    </button>
  );
}

function LibraryCard({
  card,
  selected,
  now,
  touch,
  onPick,
  onUseInstalled,
  installMode,
  onLoras,
}: {
  card: Card;
  selected: boolean;
  now: number | null;
  /** No hover here (a phone): the first tap shows what it's like, its Use button picks it. */
  touch: boolean;
  onPick: () => void;
  onUseInstalled: () => void;
  installMode?: boolean;
  /** Opens its LoRA page (open models that take LoRAs). */
  onLoras?: () => void;
}) {
  const [pinned, setPinned] = useState(false);
  const loras = useLoraCount(card.lora ? card.id : null);
  const fresh = Boolean(now && card.released && now - Date.parse(card.released) < NEW_DAYS * 86_400_000);
  const locked = !card.ready && !card.install;
  const fit = rowFit(selected, selected ? undefined : card.useOn?.gpu, Boolean(onLoras));
  // A local model's time leads: on a narrow card the maker is what gets cut.
  const meta = [card.fit ? null : card.time?.text, card.maker].filter(Boolean).join(" · ");
  return (
    <div
      data-card
      data-pinned={pinned || undefined}
      className={cn(
        "library-card group/card squircle relative aspect-[4/5] overflow-hidden rounded-[18px] bg-apple",
        selected && "library-card-on",
        locked && "library-card-locked",
      )}
    >
      <CardMedia card={card} />
      <div className="library-card-shade pointer-events-none absolute inset-0" />
      <button
        type="button"
        data-card-main
        onClick={() => (card.ready && !card.install && !touch ? onPick() : setPinned((p) => !p))}
        aria-current={selected || undefined}
        aria-label={`${card.name} by ${card.maker}${card.ready && !card.install ? "" : card.install ? ", to install" : `, ${card.reason ?? "not ready"}`}`}
        className="absolute inset-0 z-10 rounded-[inherit] outline-none"
      />
      <div className="pointer-events-none absolute inset-x-2 top-2 z-20 flex items-start justify-between gap-1.5">
        <span className="flex gap-1">
          {fresh ? <span className="rounded-full bg-spike px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-[0.06em] text-spike-ink">New</span> : null}
          {card.tag ? <span className="rounded-full bg-black/60 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-[0.06em] text-paper">{card.tag}</span> : null}
          {loras ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-[#0d0c11]/75 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-[0.06em] text-spike" title={`${loras} LoRA${loras === 1 ? "" : "s"} on`}>
              <Layers size={10} strokeWidth={2.6} />
              {loras}
            </span>
          ) : null}
        </span>
        {selected ? (
          <span className="grid size-6 place-items-center rounded-full bg-spike text-spike-ink shadow-[0_2px_8px_rgb(0_0_0/0.4)]">
            <Check size={14} strokeWidth={3} />
          </span>
        ) : card.badge ? (
          <span
            className={cn(
              "truncate rounded-full bg-[#0d0c11]/75 px-2 py-0.5 text-[11px] font-semibold",
              card.badge.tone === "good" ? "text-chroma" : card.badge.tone === "ok" ? "text-[var(--color-tool-upscale)]" : card.badge.tone === "slow" ? "text-tungsten" : card.badge.tone === "no" ? "text-haze" : "text-fog",
            )}
          >
            {card.badge.text}
          </span>
        ) : null}
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 p-3">
        <h4 className="font-display text-[17px] uppercase leading-[0.98] tracking-[-0.01em] text-paper [text-wrap:balance] sm:text-[19px]">{card.name}</h4>
        <p className="mt-1 flex items-center gap-1.5 truncate text-[11.5px] text-fog">
          {card.quality !== null ? <QualityPips value={card.quality} /> : null}
          <span className="truncate" title={card.time?.title}>
            {meta}
          </span>
        </p>
        {card.fit ? (
          <p className={cn("mt-1 flex items-center gap-1 truncate text-[11.5px] font-semibold", card.fit.whole === true ? "text-chroma" : card.fit.whole === false ? "text-tungsten" : "text-fog")}>
            {card.fit.whole === true ? <Check size={11} className="shrink-0" /> : null}
            <span className="truncate">{card.fit.text}</span>
          </p>
        ) : null}
        <div className="library-card-more grid">
          <div className="min-h-0 overflow-hidden">
            <Details card={card} />
            {card.install ? (
              <InstallActions card={card} onUse={onUseInstalled} />
            ) : locked ? (
              <LockedNote card={card} />
            ) : installMode ? null : (
              // One row that never wraps: a second row of buttons covered the picture.
              <div className="@container mt-2.5 flex items-center gap-1.5">
                <UseButton selected={selected} gpu={card.useOn?.gpu} fit={fit} onPick={onPick} />
                {onLoras ? <LorasButton count={loras} fit={fit} onClick={onLoras} /> : null}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** How good it is, in five pips; the number is in the details. */
function QualityPips({ value }: { value: number }) {
  const lit = Math.max(1, Math.round(value / 20));
  return (
    <span className="inline-flex shrink-0 items-center gap-[2px]" aria-label={`Quality ${value} of 100`} title={`Quality ${value} of 100`}>
      {[0, 1, 2, 3, 4].map((i) => (
        <i key={i} className={cn("block h-2 w-[3px] rounded-full", i < lit ? "bg-spike" : "bg-white/20")} />
      ))}
    </span>
  );
}

function Details({ card }: { card: Card }) {
  return (
    <div className="pt-2.5 text-[11.5px] leading-snug">
      {card.quality !== null ? (
        <div className="flex items-center gap-2">
          <span className="h-1 flex-1 overflow-hidden rounded-full bg-white/[0.12]">
            <span className="block h-full rounded-full bg-spike" style={{ width: `${card.quality}%` }} />
          </span>
          <span className="tabular shrink-0 font-semibold text-paper">{card.quality}</span>
        </div>
      ) : null}
      {card.rank ? <p className="library-card-rank mt-1 truncate text-haze">{card.rank}</p> : null}
      <p className="library-card-says mt-1.5 text-fog">{card.says ?? card.blurb}</p>
      <p className="mt-1.5 line-clamp-2 text-haze">{[card.released ? month(card.released) : null, ...card.facts].filter(Boolean).join(" · ")}</p>
      {card.time ? (
        <p className="library-card-time mt-0.5 truncate text-haze">
          <span className="font-semibold text-paper">{card.time.text}</span> {card.time.title.replace(/^a /, "per ")}
        </p>
      ) : null}
    </div>
  );
}

/** Picks the model: the whole card does on a desktop, this is what a phone taps once the card shows its details. */
function UseButton({ selected, gpu, fit, onPick }: { selected: boolean; gpu?: string; fit: RowFit; onPick: () => void }) {
  return (
    <button
      type="button"
      onClick={onPick}
      tabIndex={-1}
      className="press pointer-events-auto inline-flex h-8 min-w-0 items-center gap-1.5 rounded-full bg-paper px-3 text-[12px] font-bold text-[#16131b] hover:bg-white"
    >
      {selected ? <Check size={13} strokeWidth={3} className="shrink-0" /> : <CornerDownLeft size={13} strokeWidth={2.6} className="shrink-0" />}
      <span className="flex min-w-0">
        {selected ? "Selected" : "Use"}
        {gpu && !selected ? <span className={cn("hidden truncate", fit.name)}>{` on ${gpu}`}</span> : null}
      </span>
    </button>
  );
}

/** A card's LoRA page, beside its Use button: as tall, lighter, a round icon when the card is too narrow for its word. */
function LorasButton({ count, fit, onClick }: { count: number; fit: RowFit; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="LoRAs: add-ons that change how it draws"
      aria-label={`LoRAs${count ? `, ${count} on` : ""}`}
      className="press pointer-events-auto inline-flex h-8 shrink-0 items-center rounded-full bg-white/[0.12] px-[9.5px] text-[12px] font-bold text-paper hover:bg-white/[0.2]"
    >
      <Layers size={13} strokeWidth={2.4} className={cn("shrink-0", count ? "text-spike" : null)} />
      <span className={cn("hidden whitespace-nowrap pl-1", fit.word)}>LoRAs</span>
    </button>
  );
}

type RowFit = { name: string; word: string };

/**
 * Keeps a card's button row (an @container) on one row as the card narrows: the LoRAs button drops its word first, then
 * "Use on RTX 5090" its GPU's name, which can make room for the word again. Container queries worked out from widths
 * measured at 12px bold (the pill saying "Use" 64, "Selected" 91, the round LoRAs button 32, its word +39, gaps 6, slack
 * 4) and a GPU name's letters at 6.4 each, by its length: up to 8 ("RTX 5090"), 12, or longer (cut with "…" if need be).
 * `cqw` sizes worked out the same way went stale in Chrome when the card resized; queries don't.
 */
const GPU_FIT = [
  { upTo: 8, name: "@min-[183px]:inline", alone: "@min-[145px]:inline", word: "@min-[145px]:inline @min-[183px]:hidden @min-[222px]:inline" },
  { upTo: 12, name: "@min-[209px]:inline", alone: "@min-[171px]:inline", word: "@min-[145px]:inline @min-[209px]:hidden @min-[248px]:inline" },
  { upTo: Infinity, name: "@min-[241px]:inline", alone: "@min-[203px]:inline", word: "@min-[145px]:inline @min-[241px]:hidden @min-[280px]:inline" },
];

function rowFit(selected: boolean, gpu: string | undefined, loras: boolean): RowFit {
  if (selected) return { name: "", word: "@min-[172px]:inline" };
  if (!gpu) return { name: "", word: "@min-[145px]:inline" };
  const fit = GPU_FIT.find((f) => gpu.length <= f.upTo)!;
  return { name: loras ? fit.name : fit.alone, word: fit.word };
}

function LockedNote({ card }: { card: Card }) {
  const comfy = card.home === "cloud";
  return (
    <span className="pointer-events-auto mt-2.5 flex flex-wrap items-center gap-2">
      <Link
        href="/settings/connections"
        className="press inline-flex h-8 items-center gap-1.5 rounded-full bg-white/[0.12] px-3 text-[12px] font-bold text-paper hover:bg-white/[0.18]"
      >
        <KeyRound size={13} /> {comfy ? "Add a Comfy key" : "Connect"}
      </Link>
      {!comfy && card.reason ? <span className="text-[11px] text-haze">{card.reason}</span> : null}
    </span>
  );
}

/** Install on the GPU it's shown for, the download's progress, then Use. */
function InstallActions({ card, onUse }: { card: Card; onUse: () => void }) {
  const inst = card.install!;
  const { row, gpu } = inst;
  const v = row.fit.variant;
  const state = installState(v, gpu?.target ?? null);
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const refresh = useModelsStore((s) => s.refresh);
  const was = useRef(state.installed);
  useEffect(() => {
    // Done downloading: the tools' model list hears of it.
    if (state.installed && !was.current) void refresh();
    was.current = state.installed;
  }, [state.installed, refresh]);

  const roomy = gpu?.machine?.diskFreeGb == null || state.missingGb < (gpu.machine.diskFreeGb ?? 0) - 2;
  const gated = Boolean(row.model.gated) && !inst.hfToken;
  async function install() {
    if (!v || !gpu) return;
    setWorking(true);
    setProblem(await localAction("install", row.model.id, v.id, gpu.id));
    setWorking(false);
    void reloadLocal();
  }

  let action: ReactNode;
  if (!gpu) action = <span className="text-[11.5px] text-haze">Set up ComfyUI on the Local page to install.</span>;
  else if (state.installed)
    action = (
      <button type="button" onClick={onUse} className="press inline-flex h-8 items-center gap-1.5 rounded-full bg-paper px-3 text-[12px] font-bold text-[#16131b]">
        <Check size={13} strokeWidth={3} /> Installed · Use
      </button>
    );
  else if (state.active.length)
    action = (
      <div className="w-full">
        <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.12]">
          <div className="h-full rounded-full bg-spike transition-[width] duration-700" style={{ width: `${Math.max(2, (state.done / Math.max(1, state.total)) * 100)}%` }} />
        </div>
        <div className="mt-1.5 flex items-center justify-between gap-2">
          <span className="truncate text-[11px] text-fog">{state.checking ? "Checking the files…" : `${gb(state.done / 1024 ** 3)} of ${gb(state.total / 1024 ** 3)}`}</span>
          <button
            type="button"
            onClick={() =>
              void stopDownloads(
                state.active.map((d) => d.id),
                gpu.id,
              ).then(() => reloadLocal())
            }
            className="press inline-flex h-7 items-center gap-1 rounded-full bg-white/[0.12] px-2.5 text-[11px] font-semibold text-paper hover:bg-white/[0.18]"
          >
            <Square size={10} /> Stop
          </button>
        </div>
      </div>
    );
  else if (row.fit.state === "no") action = <span className="text-[11.5px] text-haze">Too big for {gpu.gpu}: {row.fit.why.toLowerCase()}.</span>;
  else if (gated)
    action = (
      <Link href="/local" className="press inline-flex h-8 items-center gap-1.5 rounded-full bg-white/[0.12] px-3 text-[12px] font-bold text-paper hover:bg-white/[0.18]">
        <KeyRound size={13} /> Accept its licence on Local
      </Link>
    );
  else if (!roomy) action = <span className="text-[11.5px] text-tungsten">Needs {gb(state.missingGb)} free on {gpu.where}.</span>;
  else
    action = (
      <button
        type="button"
        onClick={() => void install()}
        disabled={working}
        className="lip press inline-flex h-8 items-center gap-1.5 rounded-full bg-spike px-3 text-[12px] font-bold text-spike-ink [--lip:var(--color-spike-lip)] hover:bg-spike-hi disabled:opacity-70"
      >
        {working ? <LoaderCircle size={13} className="animate-spin" /> : <Download size={13} strokeWidth={2.6} />} Install · {gb(state.missingGb)}
      </button>
    );
  return (
    <div className="pointer-events-auto mt-2.5">
      {action}
      {problem || state.failed?.error ? (
        <p className="mt-1.5 flex items-start gap-1 text-[11px] text-tally">
          <TriangleAlert size={12} className="mt-px shrink-0" /> {problem ?? state.failed?.error}
        </p>
      ) : null}
    </div>
  );
}

/** The card's picture: the official preview's opening frame, its clip while pointed at; or the maker's mark. */
function CardMedia({ card }: { card: Card }) {
  const [failed, setFailed] = useState(false);
  const p = card.preview;
  if (p && "text" in p) return <TextCardPreview id={p.text} name={card.name} maker={card.maker} hue={`oklch(0.72 0.13 ${hueOf(card.name)})`} />;
  if (!p || failed) {
    // No official preview: its name over a color field of its own, so no two blank cards look alike.
    return (
      <div className="library-card-blank absolute inset-0 overflow-hidden" style={{ "--hue": `oklch(0.66 0.14 ${hueOf(card.name)})` } as React.CSSProperties}>
        <span aria-hidden="true" className="absolute -left-1 top-6 w-[140%] break-words font-display text-[58px] uppercase leading-[0.86] tracking-[-0.03em] text-white/[0.07]">
          {card.name}
        </span>
        <span className="absolute inset-0 grid place-items-center pb-10">
          <VendorMark vendor={card.maker} model={card.name} size={52} />
        </span>
      </div>
    );
  }
  const src = "src" in p ? p.src : previewSrc(p.template);
  return (
    <>
      {/* Small, cached stills; a plain img keeps a page of them cheap. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt=""
        loading="lazy"
        decoding="async"
        onLoad={(e) => e.currentTarget.setAttribute("data-loaded", "")}
        onError={() => setFailed(true)}
        className="library-card-still absolute inset-0 size-full object-cover"
      />
      {"template" in p && p.clip ? <CardClip src={previewSrc(p.template, "clip")} /> : null}
      {"template" in p && p.compare && !p.clip ? <CardCompare src={previewSrc(p.template, "before")} /> : null}
    </>
  );
}

/** A steady hue per name, for cards without a preview. */
function hueOf(name: string) {
  let h = 7;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

/**
 * An upscaler's card, pointed at: the picture it started from (its ComfyUI compare template's other half), then a wipe to
 * the result. Loaded on the first hover; cards whose template has no starting picture just keep their still.
 */
function CardCompare({ src }: { src: string }) {
  const img = useRef<HTMLImageElement>(null);
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const el = img.current;
    const card = el?.closest<HTMLElement>("[data-card]");
    if (!el || !card) return;
    const show = () => {
      setArmed(true);
      // Restart the wipe each time the card is pointed at.
      el.removeAttribute("data-wipe");
      void el.offsetWidth;
      if (el.complete && el.naturalWidth) el.setAttribute("data-wipe", "");
    };
    const hide = () => el.removeAttribute("data-wipe");
    card.addEventListener("pointerenter", show);
    card.addEventListener("pointerleave", hide);
    card.addEventListener("focusin", show);
    card.addEventListener("focusout", hide);
    return () => {
      card.removeEventListener("pointerenter", show);
      card.removeEventListener("pointerleave", hide);
      card.removeEventListener("focusin", show);
      card.removeEventListener("focusout", hide);
    };
  }, []);
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      ref={img}
      src={armed ? src : undefined}
      alt=""
      aria-hidden="true"
      decoding="async"
      onLoad={(e) => e.currentTarget.closest("[data-card]")?.matches(":hover, :focus-within") && e.currentTarget.setAttribute("data-wipe", "")}
      onError={(e) => e.currentTarget.remove()}
      className="library-card-before absolute inset-0 size-full object-cover"
    />
  );
}

/** A video model's preview clip over its still while its card is pointed at or focused; loaded on the first hover only. */
function CardClip({ src }: { src: string }) {
  const video = useRef<HTMLVideoElement>(null);
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const v = video.current;
    const card = v?.closest<HTMLElement>("[data-card]");
    if (!v || !card) return;
    let inside = false;
    const play = () => {
      inside = true;
      setArmed(true);
      v.preload = "auto";
      void v
        .play()
        .then(() => inside && v.setAttribute("data-playing", ""))
        .catch(() => {});
    };
    const stop = () => {
      inside = false;
      v.pause();
      v.removeAttribute("data-playing");
    };
    card.addEventListener("pointerenter", play);
    card.addEventListener("pointerleave", stop);
    card.addEventListener("focusin", play);
    card.addEventListener("focusout", stop);
    return () => {
      card.removeEventListener("pointerenter", play);
      card.removeEventListener("pointerleave", stop);
      card.removeEventListener("focusin", play);
      card.removeEventListener("focusout", stop);
      stop();
    };
  }, []);
  return (
    <video
      ref={video}
      src={armed ? src : undefined}
      muted
      loop
      playsInline
      preload="none"
      aria-hidden="true"
      className="absolute inset-0 size-full object-cover opacity-0 transition-opacity duration-300 data-[playing]:opacity-100"
    />
  );
}

function GpuLine({ g, runOn }: { g: Gpu; runOn: string }) {
  const m = g.machine;
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-[14px] bg-white/[0.035] px-3.5 py-2.5 text-[12.5px] text-haze">
      <Cpu size={14} className="shrink-0 text-fog" />
      <span className="font-semibold text-paper">{g.gpu}</span>
      {g.vram ? <span>{gb(g.vram)} {m?.gpus[0]?.unified ? "unified memory" : "VRAM"}</span> : null}
      <span>· {g.where}</span>
      {m?.diskFreeGb != null ? <span>· {gb(m.diskFreeGb)} disk free</span> : null}
      {/* Other apps (or another job) hold part of its memory now: what fits is counted from what's free. */}
      {g.vram && m && !m.gpus[0]?.unified && m.modelMemoryGb < g.vram - 2 ? <span className="text-tungsten">· {gb(m.modelMemoryGb)} of its memory free now</span> : null}
      <span className="ml-auto">{runOn === g.id ? "Local jobs run here" : runOn === "auto" ? "Local jobs: Auto picks the fastest free GPU" : ""}</span>
    </p>
  );
}

function Banner({ icon, children, action }: { icon: ReactNode; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[14px] bg-white/[0.04] px-3.5 py-3 text-[13px] leading-relaxed text-fog">
      <span className="shrink-0 text-haze">{icon}</span>
      <span className="min-w-0 flex-1">{children}</span>
      {action}
    </div>
  );
}

function Empty({ title, body, actions }: { title: string; body: string; actions?: ReactNode }) {
  return (
    <div className="rounded-[18px] bg-white/[0.025] px-5 py-8 text-center">
      <p className="text-[14.5px] font-semibold text-paper">{title}</p>
      <p className="mx-auto mt-1 max-w-[46ch] text-[13px] leading-relaxed text-haze">{body}</p>
      {actions ? <div className="mt-4 flex flex-wrap justify-center gap-2">{actions}</div> : null}
    </div>
  );
}

function GhostButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="press inline-flex h-8 items-center gap-1 rounded-full bg-white/[0.06] px-3 text-[12.5px] font-semibold text-fog hover:bg-white/[0.1] hover:text-paper">
      {children}
    </button>
  );
}

function GhostLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="press inline-flex h-8 items-center gap-1 rounded-full bg-white/[0.08] px-3 text-[12.5px] font-semibold text-paper hover:bg-white/[0.14]">
      {children} <ArrowUpRight size={13} />
    </Link>
  );
}
