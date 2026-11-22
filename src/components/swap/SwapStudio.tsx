"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { ChevronDown, Eraser, Film, ImagePlus, LoaderCircle, MousePointerClick, Palette, Pause, Play, Type, Upload, UserRound, X } from "lucide-react";
import { ToolTile } from "@/components/ui/ToolTile";
import { Button } from "@/components/ui/Button";
import { Panel, Segmented, Switch } from "@/components/ui/Panel";
import { Slider } from "@/components/ui/Slider";
import { GenerationCard } from "@/components/generations/GenerationCard";
import { GeneratingField } from "@/components/ui/GeneratingField";
import { useGenerations, useGenerationsStore } from "@/lib/hooks/use-generations";
import { useCast } from "@/lib/hooks/use-cast";
import { toolBySlug } from "@/lib/tools";
import { SWAP_PRESETS, type SwapPreset } from "@/lib/swap/presets";
import type { Generation } from "@/lib/generations/types";
import { aspectById } from "@/lib/shot";
import { DEMO } from "@/lib/demo/config";
import { DEMO_CREDITS_HINT, demoSwapCredits } from "@/lib/demo/estimate";
import { cn } from "@/lib/cn";
import { posterUrl, previewUrl } from "@/lib/media-url";

const tool = toolBySlug("recast")!;
/** How much of a clip one swap takes (LTX-2.5 Ripple carries an edit up to 10 s each way from the frame it's drawn on). */
const SPAN = 15;
/** Things you can change at once, each with its own colour on the frame. */
const MAX = 4;
const COLORS = ["#ff5b2e", "#38c6ff", "#a8f04a", "#ff5bd6"];
const PAINTS = [
  { name: "red", hex: "#d8322b" },
  { name: "black", hex: "#151417" },
  { name: "white", hex: "#f3f1ec" },
  { name: "gold", hex: "#d2a339" },
  { name: "royal blue", hex: "#2f62d8" },
  { name: "hot pink", hex: "#ff6fb1" },
  { name: "emerald green", hex: "#239b5c" },
  { name: "purple", hex: "#7a4fdc" },
];
const PERSON = /\b(man|woman|person|girl|boy|guy|lady|child|kid|dancer|singer|creator|model|player|grandma|grandpa|friend|she|he|her|him)\b/i;

/** Who checks the drawings (server/swap-checker), and whether each can run now (/api/swap/checkers). */
type Checker = "auto" | "local" | "cloud";
type CheckerState = { picked: Checker; local: { ok: boolean; where?: string; why?: string }; cloud: { ok: boolean; why?: string } };

/** The line under Checks: who will check this swap, or why the pick can't. */
function checkerNote(picked: Checker, s: CheckerState): { ok: boolean; text: string } {
  const judge = `Crackio's judge on ${s.local.where}, free`;
  if (picked === "local") return s.local.ok ? { ok: true, text: judge } : { ok: false, text: s.local.why ?? "Crackio's judge isn't installed." };
  if (picked === "cloud") return s.cloud.ok ? { ok: true, text: "Gemini 3.5 Flash on your Comfy key" } : { ok: false, text: `Gemini can't check right now: ${s.cloud.why ?? "it didn't answer."}` };
  if (s.local.ok) return { ok: true, text: `Auto: ${judge}` };
  if (s.cloud.ok) return { ok: true, text: "Auto: Gemini 3.5 Flash (Crackio's judge isn't installed on your GPUs)" };
  return { ok: true, text: "Auto: a picture reader on your GPU. Crackio's judge (Settings → Tools → Swap) makes sharper checks." };
}

type Clip = { url: string; name: string; duration: number; title?: string };
type Frame = { url: string; width: number; height: number };
type Becomes = "cast" | "picture" | "paint" | "words" | "remove";
/** One thing clicked in the clip: where (0–1) and when, SAM 3.1's outline of it, its name, and what it becomes. */
type Pick = {
  id: string;
  color: string;
  t: number;
  x: number;
  y: number;
  overlay?: string;
  /** Its box on the frame, 0–1000. */
  box?: [number, number, number, number];
  name?: string;
  status: "outlining" | "ready" | "error";
  error?: string;
  to: Becomes;
  cast?: string;
  image?: string;
  paint?: string;
  words: string;
};

async function upload(file: File): Promise<{ url: string }> {
  const body = new FormData();
  body.append("file", file);
  const res = await fetch("/api/uploads", { method: "POST", body });
  const data = (await res.json()) as { items?: { url: string }[]; error?: string };
  if (!res.ok || !data.items?.[0]) throw new Error(data.error ?? "Upload failed.");
  return data.items[0];
}

async function frameAt(source: string, t: number): Promise<Frame> {
  const res = await fetch("/api/recast/frame", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source, t }) });
  const data = (await res.json()) as { frame?: Frame; error?: string };
  if (!res.ok || !data.frame) throw new Error(data.error ?? "Couldn't read the clip.");
  return data.frame;
}

/** SAM 3.1's outline of what's under a click (tinted in its colour), and with `name`, what it is in words. */
async function outlineAt(frame: string, x: number, y: number, color: string, name: boolean) {
  const res = await fetch("/api/swap/outline", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ frame, points: [{ x, y }], style: "tint", color, name }),
  });
  const data = (await res.json()) as { overlay?: string; box?: [number, number, number, number]; name?: string; error?: string };
  if (!res.ok || !data.overlay || !data.box) throw new Error(data.error ?? "Couldn't outline it.");
  return data as { overlay: string; box: [number, number, number, number]; name?: string };
}

/** A clip's length from its header; the probe lets go of the file (and of a blob: address) once it knows. */
const lengthOf = (url: string, done?: () => void) =>
  new Promise<number>((resolve) => {
    const v = document.createElement("video");
    const end = (seconds: number) => {
      v.onloadedmetadata = v.onerror = null;
      v.removeAttribute("src");
      v.load();
      done?.();
      resolve(seconds);
    };
    v.preload = "metadata";
    v.onloadedmetadata = () => end(v.duration || 0);
    v.onerror = () => end(0);
    v.src = url;
  });

/** The same for a file being picked, read on this computer before it uploads. */
function durationOf(file: File) {
  const url = URL.createObjectURL(file);
  return lengthOf(url, () => URL.revokeObjectURL(url));
}

const CHECKS: Record<Checker, string> = { auto: "Auto", local: "Your GPU", cloud: "Gemini" };

const looksLikePerson = (p: Pick) => PERSON.test(p.name ?? "");

/** What a pick turns into, as the swap route takes it; null while it's still missing something. */
function changeOf(p: Pick) {
  const base = { at: { t: p.t, x: p.x, y: p.y }, what: p.name ?? "" };
  if (p.status !== "ready") return null;
  if (p.to === "remove") return { ...base, to: "remove" as const };
  if (p.to === "cast") return p.cast ? { ...base, to: "cast" as const, cast: p.cast } : null;
  if (p.to === "picture") return p.image ? { ...base, to: "picture" as const, image: p.image } : null;
  if (p.to === "paint") {
    if (!p.paint) return null;
    return { ...base, to: "words" as const, words: looksLikePerson(p) ? `wears the same outfit, all of it now ${p.paint}` : `turns ${p.paint}, keeping its exact shape, material and details` };
  }
  return p.words.trim() ? { ...base, to: "words" as const, words: p.words.trim() } : null;
}

/** Swap: drop any clip, click what changes (people, things, cars), pick what each becomes; motion, camera and sound stay. */
export function SwapStudio() {
  // Only the swaps: other takes (and every progress tick of another tool's job) don't redraw the page.
  const takes = useGenerations(useShallow((s) => s.items.filter((g) => g.tool === "recast")));
  const [clip, setClip] = useState<Clip | null>(null);
  const [start, setStart] = useState(0);
  const [t, setT] = useState(0);
  const [frame, setFrame] = useState<Frame | null>(null);
  const [loadingFrame, setLoadingFrame] = useState(false);
  const [picks, setPicks] = useState<Pick[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [background, setBackground] = useState<string | null>(null);
  const [resolution, setResolution] = useState<"540p" | "720p">("720p");
  const [sharp, setSharp] = useState(false);
  const [lock, setLock] = useState(false);
  const [fast, setFast] = useState(false);
  // Who checks each drawing: Crackio's judge on your GPU, Gemini on your Comfy key, or Auto (the judge where it's
  // installed). A setting, kept for every swap; `checkers` says whether each can run now.
  const [checker, setChecker] = useState<Checker>("auto");
  const [checkers, setCheckers] = useState<CheckerState | null>(null);
  // How sure the checker must be before a drawing is kept: Lenient keeps acceptable swaps with small flaws (fewer
  // redraws), Strict draws anything doubtful again. A setting too.
  const [strictness, setStrictness] = useState<"strict" | "normal" | "lenient">("lenient");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  // Picks that moving "Use from" left outside the part used, kept a while so the move can be undone.
  const [dropped, setDropped] = useState<{ picks: Pick[]; start: number; t: number } | null>(null);
  // One outline call at a time: SAM 3.1 queues on the GPU anyway, and overlapping calls crossed the names.
  const outlines = useRef<Promise<unknown>>(Promise.resolve());
  // The picks as of this instant: a click that lands before the page has drawn the one before it still sees that one
  // (its colour is taken, it counts toward the limit, a click beside it opens it).
  const picksNow = useRef<Pick[]>([]);
  useEffect(() => {
    picksNow.current = picks;
  }, [picks]);
  const results = useRef<HTMLDivElement>(null);
  const shown = takes.find((g) => g.id === viewing) ?? takes[0] ?? null;
  const used = clip ? Math.min(SPAN, Math.max(0.5, clip.duration - start)) : 0;

  useEffect(() => {
    void fetch("/api/swap/checkers")
      .then((r) => r.json())
      .then((s: CheckerState) => {
        setCheckers(s);
        setChecker(s.picked);
      })
      .catch(() => {});
    void fetch("/api/settings")
      .then((r) => r.json())
      .then((s: { swapStrictness?: "strict" | "normal" | "lenient" }) => s.swapStrictness && setStrictness(s.swapStrictness))
      .catch(() => {});
  }, []);

  // The frame you pick on: loaded a moment after the slider stops.
  useEffect(() => {
    if (!clip) return;
    let live = true;
    const timer = setTimeout(() => {
      setLoadingFrame(true);
      frameAt(clip.url, t)
        .then((f) => live && setFrame(f))
        .catch((err) => live && setError((err as Error).message))
        .finally(() => live && setLoadingFrame(false));
    }, 220);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [clip, t]);

  /** A new clip (or none): the last one's picks, background and frame go with it. */
  function load(next: Clip | null) {
    setClip(next);
    setStart(0);
    setT(0);
    setFrame(null);
    setPicks([]);
    setActive(null);
    setBackground(null);
    setDropped(null);
    setError(null);
  }

  /** Runs `job` once the outline calls asked for before it are done. */
  const queued = <T,>(job: () => Promise<T>): Promise<T> => {
    const run = outlines.current.then(job);
    outlines.current = run.catch(() => {});
    return run;
  };

  const patch = (id: string, p: Partial<Pick>) => setPicks((ps) => ps.map((x) => (x.id === id ? { ...x, ...p } : x)));

  async function click(x: number, y: number) {
    if (!frame) return;
    // A click on something already picked on this frame opens it; so does one right beside a pick that is still
    // being outlined (it has no box yet), so a quick second click never makes a second pick of the same thing.
    const now = picksNow.current;
    const here = now.filter((p) => Math.abs(p.t - t) < 0.05);
    const hit =
      here.find((p) => p.box && x * 1000 >= p.box[0] && x * 1000 <= p.box[2] && y * 1000 >= p.box[1] && y * 1000 <= p.box[3]) ??
      here.find((p) => !p.box && p.status === "outlining" && Math.hypot(p.x - x, p.y - y) < 0.03);
    if (hit) return setActive(hit.id);
    if (now.length >= MAX) return setError(`Up to ${MAX} things at a time: remove one first.`);
    setError(null);
    const color = COLORS.find((c) => !now.some((p) => p.color === c)) ?? COLORS[0];
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    setDropped(null);
    const pick: Pick = { id, color, t, x, y, status: "outlining", to: "cast", words: "" };
    picksNow.current = [...now, pick];
    setPicks((ps) => [...ps, pick]);
    setActive(id);
    try {
      const got = await queued(() => outlineAt(frame.url, x, y, color, false));
      patch(id, { overlay: got.overlay, box: got.box, status: "ready" });
      // Named after it shows (the same outline again: ComfyUI keeps it), so the outline doesn't wait for words; queued
      // behind any outline asked for meanwhile, so another pick's outline isn't held up by this one's name.
      const named = await queued(() => outlineAt(frame.url, x, y, color, true)).catch(() => null);
      const name = named?.name?.trim();
      setPicks((ps) =>
        ps.map((p) => {
          if (p.id !== id) return p;
          const next = { ...p, name: name || "the one you clicked" };
          // Things become a picture or a colour more often than a Cast member.
          return !PERSON.test(next.name) && p.to === "cast" && !p.cast ? { ...next, to: "picture" as const } : next;
        }),
      );
    } catch (err) {
      patch(id, { status: "error", error: (err as Error).message });
    }
  }

  const changes = picks.map(changeOf);
  const needsConsent = picks.some((p) => p.to === "cast" || p.to === "picture");
  const waiting = picks.some((p) => p.status === "outlining");
  const incomplete = changes.some((c, i) => !c && picks[i].status !== "error");
  const anything = changes.some(Boolean) || Boolean(background?.trim());
  const ready = Boolean(clip) && anything && !waiting && !incomplete && (!needsConsent || consent) && !busy && (background === null || Boolean(background.trim()));
  // About what it takes on an RTX 5090: SAM 3.1, the redraws, then LTX-2.5 (Bulin 47, 15 s: 322 s of GPU).
  const minutes = Math.max(1, Math.round((30 + used * 21.5 * (resolution === "540p" ? 0.6 : 1) * (sharp ? 1.65 : 1) * (fast ? 0.55 : 1) + picks.length * 30) / 60));
  const note = checkers ? checkerNote(checker, checkers) : null;
  const settingsLine = [`Checks ${CHECKS[checker]}`, `${strictness.charAt(0).toUpperCase()}${strictness.slice(1)}`, fast && "Fast draft", lock && "Everyone else exact"].filter(Boolean).join(" · ");
  // The button says what's still missing, as Templates' does.
  const label = busy
    ? "Starting"
    : !clip
      ? "Swap"
      : waiting
        ? "Outlining…"
        : !anything
          ? "Click what should change"
          : incomplete
            ? "Pick what each one becomes"
            : background !== null && !background.trim()
              ? "Describe the new background"
              : needsConsent && !consent
                ? "Tick the box above first"
                : picks.length > 1
                  ? `Swap ${picks.length} things`
                  : "Swap";

  async function swap() {
    if (!clip || !ready) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/swap/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clip: { url: clip.url, start },
          changes: changes.filter(Boolean),
          ...(background?.trim() ? { background: background.trim() } : {}),
          resolution,
          sharp,
          lock,
          fast,
          seconds: SPAN,
          consent,
          checker,
          strictness,
          ...(clip.title ? { title: clip.title } : {}),
        }),
      });
      const data = (await res.json()) as { item?: Generation; error?: string; hint?: string };
      if (!res.ok || !data.item) throw new Error([data.error ?? "Couldn't start the swap.", data.hint].filter(Boolean).join(" "));
      // In the list at once, and followed until it's done, so its progress shows while it renders.
      useGenerationsStore.getState().track(data.item);
      setViewing(data.item.id);
      requestAnimationFrame(() => results.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-[1600px] px-4 pb-24 pt-6 sm:px-6 lg:px-8">
      <header className="flex items-start gap-4">
        <ToolTile icon={tool.icon} hue={tool.hue} size={44} />
        <div>
          <h1 className="font-display text-[34px] sm:text-[40px]">{tool.name}</h1>
          <p className="mt-1 max-w-[72ch] text-[14.5px] leading-relaxed text-fog">Click what should change in any clip: a person, a product, a car. Motion, camera and sound stay. Runs on your GPU with LTX-2.5.</p>
        </div>
      </header>

      <div className="mt-8 grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_400px]">
        <main className="min-w-0 space-y-8">
          {clip ? (
            <Stage
              clip={clip}
              frame={frame}
              loading={loadingFrame}
              t={t}
              start={start}
              used={used}
              picks={picks}
              active={active}
              onClick={click}
              onTime={setT}
              onStart={(v) => {
                // Clicks outside the part that's used would point at the wrong frame: they go, with an Undo.
                const out = picks.some((p) => p.t < v || p.t > v + SPAN);
                if (out) setDropped((d) => d ?? { picks, start, t });
                setStart(v);
                setT(v);
                if (out) setPicks((ps) => ps.filter((p) => p.t >= v && p.t <= v + SPAN));
              }}
              dropped={dropped ? dropped.picks.length - picks.length : 0}
              onUndo={() => {
                if (!dropped) return;
                setPicks(dropped.picks);
                setStart(dropped.start);
                setT(dropped.t);
                setDropped(null);
              }}
              onClear={() => load(null)}
            />
          ) : (
            <Pickup onClip={load} onError={setError} error={error} />
          )}
          <div ref={results} className="scroll-mt-6 space-y-8">
            {shown ? <Compare gen={shown} /> : null}
            {takes.length > 1 ? (
              <section>
                <h2 className="label mb-2">Your swaps</h2>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
                  {takes.map((g) => (
                    // A div, not a button: the card has its own buttons inside.
                    <div
                      key={g.id}
                      role="button"
                      tabIndex={0}
                      aria-label={`Show ${g.prompt}`}
                      onClick={() => setViewing(g.id)}
                      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && setViewing(g.id)}
                      className={cn("cursor-pointer rounded-[18px]", g.id === shown?.id && "ring-2 ring-spike ring-offset-2 ring-offset-stage")}
                    >
                      <GenerationCard gen={g} />
                    </div>
                  ))}
                </div>
              </section>
            ) : null}
          </div>
        </main>

        <aside className="lg:sticky lg:top-6">
          {/* The panel stays on screen beside the frame, its settings scrolling inside it and Swap always in view (four
              open picks pushed the button below the fold on a MacBook), as Templates' panel works. */}
          <Panel className="flex flex-col lg:max-h-[calc(100dvh-3rem)] lg:overflow-hidden">
            <div className="space-y-6 p-4 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
              <Section title="What changes" hint={clip ? `${picks.length}/${MAX} · click in the frame` : undefined}>
                {picks.length ? (
                  <div className="space-y-2.5">
                    {picks.map((p, i) => (
                      <PickCard
                        key={p.id}
                        n={i + 1}
                        pick={p}
                        open={active === p.id}
                        onOpen={() => setActive(active === p.id ? null : p.id)}
                        onChange={(next) => patch(p.id, next)}
                        onRemove={() => {
                          setDropped(null);
                          setPicks((ps) => ps.filter((x) => x.id !== p.id));
                        }}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="rounded-[16px] bg-white/[0.03] p-4 text-[13px] leading-relaxed text-fog shadow-[inset_0_0_0_1px_var(--color-line)]">
                    <p className="flex items-center gap-2 font-semibold text-paper">
                      <MousePointerClick size={15} className="text-spike" /> {clip ? "Click anything in the frame" : "Start with a clip"}
                    </p>
                    <p className="mt-1.5">
                      {clip ? "SAM 3.1 outlines what you click through the whole clip. Up to four, each in its own colour." : "Drop your own clip or try one of Crackio's. Then click who or what should change."}
                    </p>
                  </div>
                )}
              </Section>

              <Section title="Background" hint="Optional">
                <Segmented
                  value={background === null ? "keep" : "new"}
                  onChange={(v) => setBackground(v === "keep" ? null : (background ?? ""))}
                  options={[
                    { id: "keep", label: "Keep it" },
                    { id: "new", label: "New background" },
                  ]}
                />
                {background !== null ? (
                  <input
                    value={background}
                    onChange={(e) => setBackground(e.target.value)}
                    placeholder="a neon-lit Tokyo street at night"
                    className="field-focus mt-2 block h-10 w-full rounded-[12px] bg-white/[0.04] px-3 text-[13px] text-paper outline-none placeholder:text-haze"
                  />
                ) : null}
              </Section>

              <Section title="Quality">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <Segmented
                    value={resolution}
                    onChange={setResolution}
                    options={[
                      { id: "540p", label: "540p" },
                      { id: "720p", label: "720p" },
                    ]}
                  />
                  <Switch checked={sharp} onChange={setSharp} label="Sharp 1080p" title="Each pass finished by LTX's ×2 upscaler: crisper, about twice as long, and fast hands can smear" />
                </div>
                {/* What most swaps never touch, folded under one line that still says how it's set. */}
                <button
                  type="button"
                  onClick={() => setMore(!more)}
                  aria-expanded={more}
                  className="mt-3 flex w-full items-center justify-between gap-3 text-left text-[12.5px] text-fog hover:text-paper"
                >
                  <span className="min-w-0 truncate">More · {settingsLine}</span>
                  <ChevronDown size={14} className={cn("shrink-0 transition-transform duration-200", more && "rotate-180")} />
                </button>
                {more ? (
                  <div className="mt-2.5 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <Switch checked={fast} onChange={setFast} label="Fast draft" title="Fewer steps and step reuse (EasyCache): about half the time, a little softer. Good for a first look." />
                      <Switch
                        checked={lock}
                        onChange={setLock}
                        label="Keep everyone else exact"
                        title="LTX-2.5 always makes the whole frame, so the new one is never cut. On: everyone else is put back from your clip, so their clothes stay exactly as filmed (their edges can show a faint line)."
                      />
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <span className="text-[12.5px] text-fog" title="Every drawing is checked before it's used: is the character fully swapped in, is the pose kept. Your GPU: Crackio's own judge, free. Gemini: Gemini 3.5 Flash on your Comfy API key. Auto: your GPU where the judge is installed, else Gemini.">
                        Checks
                      </span>
                      <Segmented
                        value={checker}
                        onChange={(v) => {
                          setChecker(v);
                          void fetch("/api/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ swapChecker: v }) }).catch(() => {});
                        }}
                        options={[
                          { id: "auto", label: "Auto" },
                          { id: "local", label: "Your GPU" },
                          { id: "cloud", label: "Gemini" },
                        ]}
                      />
                    </div>
                    {note ? <p className={cn("-mt-1.5 text-right text-[12px] leading-snug", note.ok ? "text-haze" : "text-[var(--color-spike)]")}>{note.text}</p> : null}
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <span className="text-[12.5px] text-fog" title="How sure the checker must be before a drawing is kept. Lenient: an acceptable swap with small flaws is kept, so fewer redraws. Strict: anything doubtful is drawn again, slower and safer.">
                        Strictness
                      </span>
                      <Segmented
                        value={strictness}
                        onChange={(v) => {
                          setStrictness(v);
                          void fetch("/api/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ swapStrictness: v }) }).catch(() => {});
                        }}
                        options={[
                          { id: "lenient", label: "Lenient" },
                          { id: "normal", label: "Normal" },
                          { id: "strict", label: "Strict" },
                        ]}
                      />
                    </div>
                  </div>
                ) : note && !note.ok ? (
                  <p className="mt-1.5 text-[12px] leading-snug text-[var(--color-spike)]">{note.text}</p>
                ) : null}
              </Section>
            </div>

            <div className="space-y-2 border-t border-line p-4">
              {/* Beside the button it unlocks. */}
              {needsConsent ? (
                <label className="flex cursor-pointer items-start gap-2.5 text-[12.5px] leading-snug text-fog">
                  <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-[3px] size-4 shrink-0 accent-[var(--color-spike)]" />
                  Everyone in these pictures agreed to this and is an adult.
                </label>
              ) : null}
              <Button variant="primary" size="lg" className="w-full" disabled={!ready} onClick={swap}>
                {busy ? <LoaderCircle size={16} className="animate-spin" /> : null}
                {label}
              </Button>
              <p className="text-center text-[12px] leading-snug text-haze" title={DEMO ? DEMO_CREDITS_HINT : undefined}>
                {error && clip ? (
                  <span className="text-tally">{error}</span>
                ) : !clip ? (
                  DEMO ? `About ${demoSwapCredits()} credits · LTX-2.5 + Ripple` : "Free on your GPU · LTX-2.5 + Ripple"
                ) : (
                  `${used.toFixed(1)} s of clip · about ${minutes} min on an RTX 5090 · ${DEMO ? `about ${demoSwapCredits()} credits` : "free on your GPU"}`
                )}
              </p>
            </div>
          </Panel>
        </aside>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ clip */

function Pickup({ onClip, onError, error }: { onClip: (c: Clip) => void; onError: (e: string | null) => void; error: string | null }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  // Your latest clips, followed on their own: a job running elsewhere doesn't redraw the presets.
  const recent = useGenerations(useShallow((s) => s.items.filter((g) => g.status === "done" && g.params?.kind === "video" && g.outputs[0]?.url?.endsWith(".mp4")).slice(0, 8)));

  async function pick(file?: File) {
    if (!file) return;
    if (!file.type.startsWith("video/")) return onError("Pick a video file (MP4, MOV or WebM).");
    setBusy(true);
    onError(null);
    try {
      const duration = await durationOf(file);
      const up = await upload(file);
      onClip({ url: up.url, name: file.name, duration });
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-8">
      <button
        type="button"
        onClick={() => input.current?.click()}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          setOver(true);
        }}
        // Crossing the button's own text isn't leaving it (the highlight used to flicker).
        onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          void pick(e.dataTransfer.files[0]);
        }}
        className={cn(
          "surface press flex min-h-[260px] w-full flex-col items-center justify-center gap-3 rounded-panel p-8 text-center transition-shadow",
          over ? "shadow-[inset_0_0_0_2px_var(--color-spike)]" : "shadow-[inset_0_0_0_1px_var(--color-line-strong)] hover:shadow-[inset_0_0_0_1px_var(--color-line-strong),0_0_0_6px_rgb(255_255_255/0.02)]",
        )}
      >
        <span className="grid size-14 place-items-center rounded-full bg-white/[0.06] text-paper">{busy ? <LoaderCircle size={22} className="animate-spin" /> : <Upload size={22} />}</span>
        <span className="font-display text-[26px] leading-tight text-paper">Drop a clip to swap things in it</span>
        <span className="max-w-[46ch] text-[13.5px] leading-relaxed text-fog">MP4, MOV or WebM. Up to {SPAN} s is used; pick where it starts after.</span>
      </button>
      <input
        ref={input}
        type="file"
        accept="video/*"
        hidden
        onChange={(e) => {
          void pick(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      {/* Right under the drop zone it's about. */}
      {error ? (
        <p role="alert" className="-mt-5 text-center text-[13px] text-tally">
          {error}
        </p>
      ) : null}

      <section>
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <h2 className="font-display text-[22px]">Try one of these</h2>
          <span className="text-[12px] text-haze">Made by Crackio on open models: nobody&rsquo;s likeness, nobody&rsquo;s clip</span>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
          {SWAP_PRESETS.map((p) => (
            <PresetCard key={p.id} preset={p} onPick={() => onClip({ url: p.clip, name: p.title, duration: p.seconds, title: p.title })} />
          ))}
        </div>
      </section>

      {recent.length ? (
        <section>
          <h2 className="label mb-2">Or one of your clips</h2>
          <div className="scrollbar-none flex gap-2.5 overflow-x-auto pb-1">
            {recent.map((g) => {
              const o = g.outputs[0];
              // 640: the width the server makes ahead for every clip (a smaller one isn't there on first look).
              const still = posterUrl(o.url, 640);
              return (
                <button
                  key={g.id}
                  type="button"
                  onClick={async () => onClip({ url: o.url, name: g.prompt || "Your clip", duration: o.duration || (await lengthOf(o.url)) || 5 })}
                  className="press group relative h-36 shrink-0 overflow-hidden rounded-[14px] bg-black shadow-[inset_0_0_0_1px_var(--color-line)]"
                  style={{ aspectRatio: o.width && o.height ? `${o.width} / ${o.height}` : "9 / 16" }}
                  title={g.prompt}
                  aria-label={`Use ${g.prompt || "this clip"}`}
                >
                  {/* Its opening frame as a light still, not the whole clip. */}
                  {still ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={still} alt="" loading="lazy" decoding="async" className="size-full object-cover opacity-90 transition-opacity group-hover:opacity-100" />
                  ) : (
                    <video src={o.url} muted playsInline preload="metadata" className="size-full object-cover opacity-90 transition-opacity group-hover:opacity-100" />
                  )}
                </button>
              );
            })}
          </div>
        </section>
      ) : null}
    </div>
  );
}

/** A preset: its clip's first frame; on hover, a swap Crackio made on it (or the clip itself). */
function PresetCard({ preset, onPick }: { preset: SwapPreset; onPick: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const dwell = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [hover, setHover] = useState(false);
  useEffect(
    () => () => {
      if (dwell.current) clearTimeout(dwell.current);
    },
    [],
  );
  return (
    <button
      type="button"
      onClick={onPick}
      onPointerEnter={() => {
        setHover(true);
        // A moment's rest first: sweeping the pointer across the grid doesn't start eight downloads.
        dwell.current = setTimeout(() => void video.current?.play().catch(() => {}), 140);
      }}
      onPointerLeave={() => {
        setHover(false);
        if (dwell.current) clearTimeout(dwell.current);
        dwell.current = null;
        const v = video.current;
        if (!v) return;
        v.pause();
        v.currentTime = 0;
      }}
      className="press group overflow-hidden rounded-[18px] bg-white/[0.03] text-left shadow-[inset_0_0_0_1px_var(--color-line)] hover:bg-white/[0.05]"
    >
      <div className="relative aspect-[9/14] overflow-hidden bg-black">
        <video ref={video} src={preset.example?.clip ?? preset.clip} poster={preset.poster} muted loop playsInline preload="none" className="size-full object-cover transition-transform duration-500 group-hover:scale-[1.03]" />
        <span className="absolute left-2 top-2 rounded-full bg-black/65 px-2 py-0.5 text-[10.5px] font-semibold text-white">{preset.seconds} s</span>
        {preset.example ? (
          <span className={cn("absolute inset-x-2 bottom-2 truncate rounded-full bg-black/65 px-2.5 py-1 text-center text-[11px] font-semibold text-white transition-opacity", hover ? "opacity-100" : "opacity-0")}>
            Swapped: {preset.example.caption}
          </span>
        ) : null}
      </div>
      <div className="p-3">
        <p className="text-[13.5px] font-semibold text-paper">{preset.title}</p>
        <p className="mt-0.5 line-clamp-2 text-[12px] leading-snug text-haze">{preset.line}</p>
      </div>
    </button>
  );
}

function Stage({
  clip,
  frame,
  loading,
  t,
  start,
  used,
  picks,
  active,
  onClick,
  onTime,
  onStart,
  dropped,
  onUndo,
  onClear,
}: {
  clip: Clip;
  frame: Frame | null;
  loading: boolean;
  t: number;
  start: number;
  used: number;
  picks: Pick[];
  active: string | null;
  onClick: (x: number, y: number) => void;
  onTime: (t: number) => void;
  onStart: (v: number) => void;
  /** How many picks the last move of "Use from" left out, for its Undo. */
  dropped: number;
  onUndo: () => void;
  onClear: () => void;
}) {
  const img = useRef<HTMLImageElement>(null);
  const long = clip.duration > SPAN + 0.2;
  const here = picks.filter((p) => Math.abs(p.t - t) < 0.05);

  return (
    <section className="surface rounded-panel p-3 sm:p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <span className="inline-flex min-w-0 items-center gap-2 text-[13px] font-semibold text-paper">
          <Film size={15} className="shrink-0 text-fog" /> <span className="truncate">{clip.name}</span>
        </span>
        <Button size="sm" variant="ghost" onClick={onClear}>
          <X size={13} /> Change clip
        </Button>
      </div>

      <div className="grid place-items-center rounded-[16px] bg-black/60 p-2">
        {frame ? (
          <div className="relative inline-block cursor-crosshair select-none">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              ref={img}
              src={frame.url}
              alt="The frame you pick on"
              draggable={false}
              onClick={(e) => {
                // The second click of a double-click isn't another pick.
                if (e.detail > 1) return;
                const r = img.current?.getBoundingClientRect();
                if (!r) return;
                onClick(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)));
              }}
              className={cn("block max-h-[64vh] max-w-full rounded-[10px] transition-opacity", loading && "opacity-60")}
            />
            {here.map((p) =>
              p.overlay ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img key={p.id} src={p.overlay} alt="" draggable={false} className={cn("pointer-events-none absolute inset-0 size-full rounded-[10px] transition-opacity", active && active !== p.id && "opacity-60")} />
              ) : null,
            )}
            {here.map((p) => (
              <span
                key={p.id}
                className="pointer-events-none absolute grid size-6 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full text-[11px] font-bold text-black shadow-[0_0_0_2px_rgb(0_0_0/0.55)]"
                style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%`, background: p.color }}
              >
                {p.status === "outlining" ? <LoaderCircle size={12} className="animate-spin" /> : picks.indexOf(p) + 1}
              </span>
            ))}
            {here.some((p) => p.status === "outlining") ? (
              <span className="pointer-events-none absolute inset-x-0 bottom-3 mx-auto flex w-fit items-center gap-1.5 rounded-full bg-black/70 px-3 py-1 text-[11.5px] font-semibold text-white">
                <LoaderCircle size={12} className="animate-spin" /> <Outlining />
              </span>
            ) : null}
          </div>
        ) : (
          <div className="skeleton aspect-[9/16] h-[64vh] max-w-full rounded-[10px]" />
        )}
      </div>

      <div className="mt-3 space-y-2.5">
        <Slider
          label="Pick on the frame at"
          value={t}
          min={start}
          max={Math.max(start + 0.1, start + used - 0.05)}
          step={0.1}
          onChange={onTime}
          format={(v) => `${v.toFixed(1)} s`}
        />
        {long ? <Slider label="Use from" value={start} min={0} max={Math.max(0.1, clip.duration - SPAN)} step={0.1} onChange={onStart} format={(v) => `${v.toFixed(1)}–${Math.min(clip.duration, v + SPAN).toFixed(1)} s`} /> : null}
        {dropped > 0 ? (
          <p role="status" className="flex items-center justify-between gap-3 rounded-[12px] bg-white/[0.04] px-3 py-2 text-[12.5px] text-fog">
            <span>{dropped === 1 ? "A pick was outside the part used, so it's gone." : `${dropped} picks were outside the part used, so they're gone.`}</span>
            <button type="button" onClick={onUndo} className="shrink-0 font-semibold text-paper hover:underline">
              Undo
            </button>
          </p>
        ) : null}
      </div>
    </section>
  );
}

/** What an outline is waiting on: SAM 3.1 takes a few seconds, unless the GPU is busy with a render first. */
function Outlining() {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 9000);
    return () => clearTimeout(timer);
  }, []);
  return <>{slow ? "Waiting for the GPU to finish a render, then outlining…" : "SAM 3.1 is outlining it…"}</>;
}

/* ------------------------------------------------------------------ changes */

const TABS: { id: Becomes; label: string; icon: typeof UserRound }[] = [
  { id: "cast", label: "Cast", icon: UserRound },
  { id: "picture", label: "Picture", icon: ImagePlus },
  { id: "paint", label: "Colour", icon: Palette },
  { id: "words", label: "Describe", icon: Type },
  { id: "remove", label: "Remove", icon: Eraser },
];

function PickCard({ n, pick, open, onOpen, onChange, onRemove }: { n: number; pick: Pick; open: boolean; onOpen: () => void; onChange: (p: Partial<Pick>) => void; onRemove: () => void }) {
  const done = Boolean(changeOf(pick));
  const summary =
    pick.to === "remove" ? "Removed" : pick.to === "paint" ? (pick.paint ? `Turns ${pick.paint}` : "Pick a colour") : pick.to === "words" ? pick.words.trim() || "Describe it" : pick.to === "picture" ? (pick.image ? "Your picture" : "Add a picture") : null;

  return (
    <div className="rounded-[16px] bg-white/[0.03] shadow-[inset_0_0_0_1px_var(--color-line)]" style={open ? { boxShadow: `inset 0 0 0 1.5px ${pick.color}` } : undefined}>
      <div className="flex items-center gap-2.5 p-3">
        <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-2.5 text-left">
          <span className="grid size-6 shrink-0 place-items-center rounded-full text-[11px] font-bold text-black" style={{ background: pick.color }}>
            {n}
          </span>
          <span className="min-w-0">
            <span className="block truncate text-[13px] font-semibold text-paper">
              {pick.status === "outlining" ? <Outlining /> : pick.status === "error" ? "Couldn't outline it" : pick.name ? `${pick.name.charAt(0).toUpperCase()}${pick.name.slice(1)}` : "Naming it…"}
            </span>
            <span className={cn("block truncate text-[11.5px]", done ? "text-fog" : "text-haze")}>
              {pick.status === "error" ? pick.error : pick.to === "cast" ? <CastName id={pick.cast} /> : summary} · {pick.t.toFixed(1)} s
            </span>
          </span>
        </button>
        <button type="button" onClick={onRemove} className="grid size-7 shrink-0 place-items-center rounded-full text-haze hover:bg-white/[0.06] hover:text-paper" aria-label={`Remove change ${n}`}>
          <X size={14} />
        </button>
      </div>
      {open && pick.status !== "error" ? (
        <div className="border-t border-line p-3 pt-2.5">
          <span className="label mb-1.5 block">Becomes</span>
          <div className="grid grid-cols-5 gap-1">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => onChange({ to: tab.id })}
                className={cn(
                  "press flex h-[52px] flex-col items-center justify-center gap-1 rounded-[11px] text-[11px] font-semibold",
                  pick.to === tab.id ? "bg-white/[0.12] text-paper shadow-[inset_0_0_0_1px_rgb(255_255_255/0.1)]" : "text-fog hover:bg-white/[0.05] hover:text-paper",
                )}
              >
                <tab.icon size={15} />
                {tab.label}
              </button>
            ))}
          </div>
          <div className="mt-3">
            {pick.to === "cast" ? <CastChoice pick={pick} onChange={onChange} /> : null}
            {pick.to === "picture" ? <PictureChoice pick={pick} onChange={onChange} /> : null}
            {pick.to === "paint" ? (
              <div className="flex flex-wrap gap-2">
                {PAINTS.map((c) => (
                  <button
                    key={c.name}
                    type="button"
                    title={c.name}
                    onClick={() => onChange({ paint: c.name })}
                    className={cn("press size-8 rounded-full shadow-[inset_0_0_0_1px_rgb(255_255_255/0.18)]", pick.paint === c.name && "ring-2 ring-paper ring-offset-2 ring-offset-stage")}
                    style={{ background: c.hex }}
                    aria-label={c.name}
                  />
                ))}
              </div>
            ) : null}
            {pick.to === "words" ? <WordsChoice pick={pick} onChange={onChange} /> : null}
            {pick.to === "remove" ? (
              <p className="text-[12.5px] leading-relaxed text-fog">
                It disappears from the whole clip, and what was behind it is filled in. Best on things nobody holds: something in a hand tends to come back as a see-through copy.
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function CastName({ id }: { id?: string }) {
  const { items } = useCast();
  const c = id ? items.find((x) => x.id === id) : null;
  return <>{c ? `Becomes ${c.name}` : "Pick who it becomes"}</>;
}

function CastChoice({ pick, onChange }: { pick: Pick; onChange: (p: Partial<Pick>) => void }) {
  const { items, loaded } = useCast();
  const person = looksLikePerson(pick);
  // People first for a person, things first for a thing.
  const ready = items
    .filter((c) => c.status === "ready" && (c.portrait || c.photos[0]))
    .sort((a, b) => Number(person ? a.kind === "object" : a.kind !== "object") - Number(person ? b.kind === "object" : b.kind !== "object"));
  if (!ready.length) {
    return (
      <p className="text-[12.5px] leading-relaxed text-fog">
        {loaded ? "Your Cast is empty. Make someone on the Cast page, or use a picture." : "Loading your Cast…"}
      </p>
    );
  }
  return (
    <div className="scrollbar-none grid max-h-[232px] grid-cols-4 gap-1.5 overflow-y-auto pr-0.5">
      {ready.map((c) => (
        <button
          key={c.id}
          type="button"
          onClick={() => onChange({ cast: c.id })}
          title={`${c.name} (@${c.handle})`}
          className={cn("press group overflow-hidden rounded-[11px] bg-white/[0.04] text-left", pick.cast === c.id ? "ring-2 ring-offset-2 ring-offset-stage" : "hover:bg-white/[0.07]")}
          style={pick.cast === c.id ? ({ "--tw-ring-color": pick.color } as CSSProperties) : undefined}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={previewUrl((c.portrait ?? c.photos[0])!, 640)} alt="" loading="lazy" decoding="async" className="aspect-square w-full object-cover" />
          <span className="block truncate px-1.5 py-1 text-[10.5px] font-semibold text-fog group-hover:text-paper">{c.name}</span>
        </button>
      ))}
    </div>
  );
}

function PictureChoice({ pick, onChange }: { pick: Pick; onChange: (p: Partial<Pick>) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [oops, setOops] = useState<string | null>(null);

  async function pickFile(file?: File) {
    if (!file) return;
    if (!file.type.startsWith("image/")) return setOops("Pick a picture (PNG, JPG or WebP).");
    setBusy(true);
    setOops(null);
    try {
      onChange({ image: (await upload(file)).url });
    } catch (err) {
      setOops((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => input.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          void pickFile(e.dataTransfer.files[0]);
        }}
        className="press flex w-full items-center gap-3 rounded-[12px] bg-white/[0.04] p-2 text-left shadow-[inset_0_0_0_1px_var(--color-line-strong)] hover:bg-white/[0.06]"
      >
        <span className="grid size-14 shrink-0 place-items-center overflow-hidden rounded-[9px] bg-black/40 text-fog">
          {busy ? (
            <LoaderCircle size={16} className="animate-spin" />
          ) : pick.image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={previewUrl(pick.image, 640)} alt="" className="size-full object-cover" />
          ) : (
            <ImagePlus size={17} />
          )}
        </span>
        <span>
          <span className="block text-[13px] font-semibold text-paper">{pick.image ? "Change the picture" : "Add a picture"}</span>
          <span className="mt-0.5 block text-[11.5px] leading-snug text-haze">Your product, car or anything: one clean photo, the whole of it in view</span>
        </span>
      </button>
      {oops ? <p className="mt-1.5 text-[12px] text-tally">{oops}</p> : null}
      <input
        ref={input}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          void pickFile(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
    </div>
  );
}

function WordsChoice({ pick, onChange }: { pick: Pick; onChange: (p: Partial<Pick>) => void }) {
  const person = looksLikePerson(pick);
  const ideas = person ? ["a chrome robot", "wearing a red ball gown", "a marble statue", "in an astronaut suit"] : ["a vintage version of it", "made of gold", "a glowing neon version", "made of glass"];
  return (
    <div>
      <input
        value={pick.words}
        onChange={(e) => onChange({ words: e.target.value })}
        placeholder={person ? "wearing a yellow raincoat" : "a vintage camper van"}
        className="field-focus block h-10 w-full rounded-[12px] bg-white/[0.04] px-3 text-[13px] text-paper outline-none placeholder:text-haze"
      />
      <div className="mt-2 flex flex-wrap gap-1.5">
        {ideas.map((idea) => (
          <button key={idea} type="button" onClick={() => onChange({ words: idea })} className="press h-7 rounded-full bg-white/[0.05] px-2.5 text-[11.5px] font-semibold text-fog hover:text-paper">
            {idea}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ results */

function Compare({ gen }: { gen: Generation }) {
  const before = useRef<HTMLVideoElement>(null);
  const after = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const source = typeof gen.params?.videoUrl === "string" ? gen.params.videoUrl : null;
  const result = gen.outputs[0]?.url;

  const toggle = () => {
    const videos = [before.current, after.current].filter((v): v is HTMLVideoElement => Boolean(v));
    if (playing) videos.forEach((v) => v.pause());
    else {
      videos.forEach((v) => (v.currentTime = 0));
      void Promise.all(videos.map((v) => v.play().catch(() => {})));
    }
    setPlaying(!playing);
  };

  return (
    <section>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="line-clamp-1 font-display text-[22px]">{gen.prompt}</h2>
        {result ? (
          <Button size="sm" variant="secondary" onClick={toggle}>
            {playing ? <Pause size={13} /> : <Play size={13} />} {playing ? "Pause" : "Play both"}
          </Button>
        ) : null}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <figure>
          <div className="overflow-hidden rounded-card bg-black">{source ? <video ref={before} src={source} muted loop playsInline className="max-h-[62vh] w-full object-contain" /> : null}</div>
          <figcaption className="label mt-2">Before</figcaption>
        </figure>
        <figure>
          <div className="relative overflow-hidden rounded-card bg-black">
            {result ? (
              <video ref={after} src={result} loop playsInline controls className="max-h-[62vh] w-full object-contain" />
            ) : gen.status === "error" ? (
              <div className="grid min-h-[280px] place-items-center p-6 text-center text-[13px] text-tally">
                {gen.error}
                {gen.stage ? <span className="mt-1 block text-fog">{gen.stage}</span> : null}
              </div>
            ) : (
              // The swap on its way, as tall as the clip beside it.
              <div className="relative max-h-[62vh] min-h-[280px] w-full" style={{ aspectRatio: aspectById(gen.aspect).w / aspectById(gen.aspect).h }}>
                <GeneratingField stage={gen.stage} progress={gen.progress} prompt={gen.prompt} since={gen.createdAt} onCancel={() => void useGenerationsStore.getState().cancel(gen.id)} />
              </div>
            )}
          </div>
          <figcaption className="label mt-2">After</figcaption>
        </figure>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ bits */

function Section({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <section>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h2 className="label shrink-0">{title}</h2>
        {hint ? <span className="truncate text-right text-[11.5px] leading-snug text-haze">{hint}</span> : null}
      </div>
      {children}
    </section>
  );
}
