"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { ArrowUpRight, Check, ChevronDown, CornerDownLeft, Download, Film, LoaderCircle, Mic, Pencil, Sparkles, TriangleAlert, Undo2, Upload, X } from "lucide-react";
import { Popover } from "@/components/ui/Popover";
import { GeneratingField } from "@/components/ui/GeneratingField";
import { RecDot } from "@/components/ui/Viewfinder";
import { ChipButton, shotFor } from "@/components/dashboard/ComposerControls";
import { Orb } from "@/components/voice/Orb";
import { usePlayer } from "@/components/voice/player";
import { VoiceModelMark } from "@/components/voice/ModelMark";
import { LipsyncSetupBar } from "./LipsyncSetup";
import { useLipsyncPrefs } from "./prefs";
import { isLive, useGenerations, useGenerationsStore } from "@/lib/hooks/use-generations";
import { lipsyncHome, useLipsyncMachines, useLipsyncStore } from "@/lib/hooks/use-lipsync";
import { useVoiceSetup, useVoiceStore } from "@/lib/hooks/use-voice";
import { LIPSYNC_BEST_VRAM_GB } from "@/lib/lipsync/machines";
import { bridgeHas } from "@/lib/setup/bridge";
import { regionsOf, sameWords } from "@/lib/lipsync/plan";
import type { LipAnalysis, LipRegion, LipSentence, LipsyncAsk, LipsyncReport } from "@/lib/lipsync/types";
import { VOICE_MODELS, voiceModel } from "@/lib/voice/models";
import type { Generation } from "@/lib/generations/types";
import { posterUrl } from "@/lib/media-url";
import { cn } from "@/lib/cn";

// Voices' drawer carries the model library's code: it comes once the page has settled, not with it.
const VoiceDrawer = dynamic(() => import("@/components/voice/VoiceDrawer").then((m) => m.VoiceDrawer), { ssr: false });

/** Where the clip is playing: read only by the sentence it lights up, so playing doesn't redraw the page 4 times a second. */
const useClipTime = create<{ t: number }>(() => ({ t: 0 }));

/** The speech models that can say new words in someone's voice (the clip's own, or one of yours). */
const SPEAKERS = VOICE_MODELS.filter((m) => m.can.clone);
const FALLBACK: [string, string] = ["#ffb3a7", "#a8323f"];

type Clip = { url: string; name: string };
type Fit = { tone: "ok" | "warn" | "bad" | "quiet"; text: string };

/** "0:02.6" */
const clock = (t: number) => {
  const s = Math.max(0, t);
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
};
const wordsIn = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

/** How fast the speaker talks, in words a second (from the clip itself), for how long new words will take. */
function rateOf(a: LipAnalysis) {
  const spoken = a.sentences.reduce((s, x) => s + Math.max(0.2, x.end - x.start), 0);
  return a.words.length && spoken ? Math.min(4.5, Math.max(1.6, a.words.length / spoken)) : 2.6;
}

/** Whether a stretch's new words fit the time there, as the speaker talks (the take that fits best is picked from three). */
function fitOf(r: LipRegion, rate: number): Fit {
  const n = wordsIn(r.text);
  if (!n) return { tone: "quiet", text: "Taken out: the mouth rests there" };
  const est = n / rate + 0.2;
  const natural = r.until - r.start;
  const room = r.until - r.from;
  if (est <= natural) return { tone: "ok", text: `About ${est.toFixed(1)} s · fits` };
  if (est <= room) return { tone: "ok", text: `About ${est.toFixed(1)} s · starts a touch earlier to fit` };
  if (est <= room * 1.2) return { tone: "warn", text: `About ${est.toFixed(1)} s for ${room.toFixed(1)} s · said a little faster` };
  return { tone: "bad", text: `About ${est.toFixed(1)} s for ${room.toFixed(1)} s · may not fit: try fewer words` };
}

/**
 * Roughly how long a take takes on an RTX 5090: the new words, the mouths (about 0.8 s a frame), the video; in another
 * voice, every line said again and timed too. Best quality adds HuMo: about 5.5 minutes for each of its windows (97
 * frames of the stretch and its margins; longer ones take several that share 16), as measured: the take 424 s in all.
 * `best`: HuMo's seconds a window (0 without it): 345, 0.7 of that with the MXFP8 build (`bestFast`).
 */
function minutesFor(regions: LipRegion[], a: LipAnalysis, whole = false, best = 0) {
  const fps = a.fps || 24;
  const frames = (r: LipRegion) => (r.until - r.from) * fps + 22;
  const span = (r: LipRegion) => (r.end - r.start) * fps + 22;
  const humo = best ? regions.reduce((t, r) => t + (span(r) <= 97 ? 1 : Math.ceil((span(r) - 16) / 81)) * best, 0) : 0;
  const s = 10 + regions.reduce((t, r) => t + 40 + frames(r) * 0.8, 0) + (regions.length ? a.duration * fps * 0.06 : 0) + (whole ? 20 + a.duration * 1.2 : 0) + humo;
  return Math.max(1, Math.round(s / 60));
}

const editsKey = (key: string) => `crackio.lipsync.edits.${key}`;
function readEdits(key: string): Record<number, string> {
  try {
    return JSON.parse(sessionStorage.getItem(editsKey(key)) ?? "{}") as Record<number, string>;
  } catch {
    return {};
  }
}

/**
 * Lip Sync: change what someone in a clip says. Drop a clip (or pick one you made); speech to text writes out what's
 * said, sentence by sentence, with times; edit any sentence. Sync makes each changed stretch anew (server/lipsync/run):
 * the new words said in their own voice (cloned from the clip, with your permission) or one of yours, then the mouth
 * redrawn by LatentSync 1.6 only there and only round the mouth; every other pixel and sound stays the clip's own.
 * In another voice, every line is said again in it and timed word by word to their lips (no new mouths for lines whose
 * words stay), so a new voice alone needs no redrawing at all.
 */
export function LipsyncStudio() {
  useLipsyncMachines();
  useVoiceSetup();
  const machines = useLipsyncStore((s) => s.machines);
  const loaded = useLipsyncStore((s) => s.loaded);
  const voiceMachines = useVoiceStore((s) => s.machines);
  const voiceLoaded = useVoiceStore((s) => s.machinesLoaded);
  const ready = useVoiceStore((s) => s.ready);
  const yours = useVoiceStore((s) => s.yours);
  // Only Lip Sync's takes: another tool's job ticking along doesn't redraw the page.
  const takes = useGenerations(useShallow((s) => s.items.filter((g) => g.tool === "lipsync")));
  const submit = useGenerations((s) => s.submit);
  const cancel = useGenerations((s) => s.cancel);
  const model = useLipsyncPrefs((s) => s.model);
  const voice = useLipsyncPrefs((s) => s.voice);
  const quality = useLipsyncPrefs((s) => s.quality);
  const setPrefs = useLipsyncPrefs((s) => s.set);

  const [clip, setClip] = useState<Clip | null>(null);
  /** What speech to text heard in the clip (for the clip and attempt it was asked for). */
  const [heard, setHeard] = useState<{ key: string; analysis: LipAnalysis | null; error: string | null } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [edited, setEdited] = useState<Record<number, string>>({});
  const [consent, setConsent] = useState(false);
  const [viewing, setViewing] = useState<string | null>(null);
  const [before, setBefore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [voicesOpen, setVoicesOpen] = useState(false);
  const [voiceAnchor, setVoiceAnchor] = useState<HTMLSpanElement | null>(null);
  const player = useRef<PlayerApi | null>(null);
  const [drawerIn, setDrawerIn] = useState(false);

  useEffect(() => {
    if (!useGenerationsStore.getState().loaded) void useGenerationsStore.getState().load();
    void useLipsyncPrefs.persist.rehydrate();
    // The voices' drawer comes once the page has settled (or at once when it opens), then stays.
    const t = window.setTimeout(() => setDrawerIn(true), 1500);
    return () => window.clearTimeout(t);
  }, []);
  // A voice sample still playing stops when you leave (its sound isn't in the page, so hiding the page can't pause it).
  useLayoutEffect(() => () => usePlayer.getState().stop(), []);

  /** A clip to work on (or none): everything about the last one goes, and the address keeps the new one. */
  const choose = useCallback((c: Clip | null) => {
    setClip(c);
    setEdited({});
    setConsent(false);
    setViewing(null);
    setBefore(false);
    setNotice(null);
    useClipTime.setState({ t: 0 });
    const u = new URL(window.location.href);
    if (c) {
      u.searchParams.set("clip", c.url);
      u.searchParams.set("name", c.name);
    } else {
      u.searchParams.delete("clip");
      u.searchParams.delete("name");
    }
    window.history.replaceState(window.history.state, "", u);
  }, []);

  // ?clip=… (from the Library's "Change what they say", a reload, a take's "Edit further") opens that clip through
  // choose, so a page kept from an earlier visit doesn't carry the last clip's edits and consent over to it.
  const clipOnScreen = useRef<string | null>(null);
  useLayoutEffect(() => {
    clipOnScreen.current = clip?.url ?? null;
  });
  useEffect(() => {
    const u = new URL(window.location.href);
    const url = u.searchParams.get("clip");
    if (!url || url === clipOnScreen.current || !/^\/(api\/media\/(out|uploads|templates)|assets)\//.test(url)) return;
    const t = window.setTimeout(() => choose({ url, name: u.searchParams.get("name") || "Clip" }), 0);
    return () => window.clearTimeout(t);
  }, [choose]);

  // What the clip says: heard once on a GPU with speech to text (kept after that, so it's instant the next time).
  const url = clip?.url ?? null;
  const hearKey = url ? `${url}#${attempt}` : null;
  useEffect(() => {
    if (!url || !hearKey) return;
    const ctrl = new AbortController();
    void (async () => {
      try {
        const res = await fetch("/api/lipsync/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }), signal: ctrl.signal });
        const data = (await res.json().catch(() => ({}))) as { analysis?: LipAnalysis; error?: string };
        if (!res.ok || !data.analysis) throw new Error(data.error ?? "Couldn't hear what the clip says.");
        setEdited(readEdits(data.analysis.key));
        setHeard({ key: hearKey, analysis: data.analysis, error: null });
      } catch (err) {
        if (ctrl.signal.aborted) return;
        setHeard({ key: hearKey, analysis: null, error: (err as Error).message });
      }
    })();
    return () => ctrl.abort();
  }, [url, hearKey]);
  const now = heard && heard.key === hearKey ? heard : null;
  const analysis = now?.analysis ?? null;
  const hearError = now?.error ?? null;

  // Your edits stay with the clip for this tab (a reload keeps them).
  useEffect(() => {
    if (!analysis) return;
    try {
      sessionStorage.setItem(editsKey(analysis.key), JSON.stringify(edited));
    } catch {
      /* this tab only */
    }
  }, [analysis, edited]);

  const home = lipsyncHome(machines);
  // Best quality: HuMo 17B redraws LatentSync's mouths with their own teeth and lips, on a GPU that has it and the room.
  const bestRoom = Boolean(home && !home.unified && (home.gpuGb ?? 0) >= LIPSYNC_BEST_VRAM_GB);
  const bestHere = Boolean(home?.best && bestRoom);
  const best = quality === "best" && bestHere;
  const humoSeconds = home?.bestFast ? 245 : 345;
  const bestWhy = !home
    ? "Set Lip Sync up on a GPU first"
    : !bestRoom
      ? `Needs a GPU with 32 GB (${home.gpu ?? home.label}${home.gpuGb ? ` has ${Math.round(home.gpuGb)}` : ""})`
      : !bridgeHas(home.bridge, "lipsyncBest")
        ? "Needs Crackio's newer helper on it"
        : "Needs HuMo 17B on it (27 GB)";
  const m = voiceModel(model) ?? SPEAKERS[0];
  const speechOn = voiceMachines.filter((x) => x.online && x.engine && x.models.includes(m.id));
  const voiceCard = voice === "clone" ? null : ([...yours, ...ready].find((v) => v.id === voice) ?? null);
  const cloning = !voiceCard;
  const regions = useMemo(() => (analysis ? regionsOf(analysis, edited) : []), [analysis, edited]);
  const rate = analysis ? rateOf(analysis) : 2.6;
  const mine = clip ? takes.filter((g) => (g.params?.lipsync as LipsyncAsk | undefined)?.url === clip.url) : [];
  const live = mine.find(isLive) ?? null;
  const shown = viewing ? (mine.find((g) => g.id === viewing && g.status === "done") ?? null) : (mine.find((g) => g.status === "done") ?? null);
  const after = shown?.outputs[0]?.url ?? null;
  const failed = mine[0]?.status === "error" ? mine[0] : null;

  // Another voice says every line (the clone only the changed ones).
  const whole = Boolean(voiceCard);
  const sync = async () => {
    setNotice(null);
    if (!clip || !analysis) return;
    if (!regions.length && !whole) return setNotice("Change what they say, or pick another voice, first.");
    if (whole && !analysis.sentences.length) return setNotice("There are no words in this clip to say in another voice.");
    if (regions.length && !home) return setNotice(loaded ? "Set Lip Sync up on a GPU first: the note at the top does it." : "Looking for your GPUs…");
    if (!speechOn.length) return setNotice(voiceLoaded ? `${m.name} isn't on your GPUs yet: set it up in Voice.` : "Looking for your GPUs…");
    if (cloning && !consent) return setNotice("Tick that you may use their voice first.");
    setBusy(true);
    try {
      const ask: LipsyncAsk = {
        url: clip.url,
        name: clip.name,
        analysis: analysis.key,
        regions,
        voice: cloning ? { kind: "clone", consent: true } : { kind: "voice", id: voiceCard.id },
        model: m.id,
        ...(whole ? { whole: true } : {}),
        ...(best && regions.length ? { tuning: { refine: {} } } : {}),
      };
      await submit({
        tool: "lipsync",
        prompt: [...regions.map((r) => r.text || "…"), ...(voiceCard ? [`Every line in ${voiceCard.name}`] : [])].join(" · "),
        aspect: shotFor(analysis.width / analysis.height),
        count: 1,
        model: m.id,
        refine: false,
        params: { kind: "lipsync", lipsync: ask },
      });
      setViewing(null);
      setBefore(false);
    } catch (err) {
      setNotice((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const showTake = (g: Generation) => {
    const ask = g.params?.lipsync as LipsyncAsk | undefined;
    if (!ask) return;
    if (clip?.url !== ask.url) choose({ url: ask.url, name: ask.name ?? "Clip" });
    setViewing(g.id);
    setBefore(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const editFurther = (g: Generation) => {
    const out = g.outputs[0];
    const ask = g.params?.lipsync as LipsyncAsk | undefined;
    if (!out) return;
    choose({ url: out.url, name: `${ask?.name ?? "Clip"} · edited` });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <div className="mx-auto max-w-[1680px] px-3 pb-24 pt-3 sm:px-4 sm:pt-4">
      <section className="relative">
        <LipsyncSetupBar />

        {clip ? (
          <div className="grid w-full grid-cols-1 gap-3 lg:h-[calc(100svh-2rem)] lg:min-h-[560px] lg:grid-cols-[minmax(0,1fr)_minmax(380px,480px)]">
            <Player
              key={clip.url}
              apiRef={player}
              clip={clip}
              after={after}
              before={before}
              setBefore={setBefore}
              live={live}
              onCancel={() => live && void cancel(live.id)}
              onClose={() => choose(null)}
              onTime={(t) => useClipTime.setState({ t })}
            />
            <div className="squircle flex min-h-[420px] flex-col rounded-[24px] bg-white/[0.03] shadow-[inset_0_0_0_1px_var(--color-line)] lg:min-h-0">
              <div className="flex items-baseline justify-between gap-3 px-4 pb-2 pt-4">
                <h2 className="font-display text-[22px]">What they say</h2>
                {analysis && regions.length ? (
                  <button type="button" onClick={() => setEdited({})} className="press inline-flex items-center gap-1 rounded-full px-2 py-1 text-[12px] font-semibold text-haze hover:text-paper">
                    <Undo2 size={12} /> Undo all
                  </button>
                ) : analysis ? (
                  <span className="text-[12px] text-haze">Click a sentence to change it</span>
                ) : null}
              </div>
              <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 pb-2">
                {analysis ? (
                  <Transcript analysis={analysis} edited={edited} setEdited={setEdited} regions={regions} rate={rate} onPlay={(s) => player.current?.playStretch(s.start, s.end)} onSubmit={() => void sync()} />
                ) : hearError ? (
                  <div className="flex flex-col items-start gap-2 px-2 py-4 text-[13.5px] leading-relaxed">
                    <span className="flex items-start gap-1.5 text-tally">
                      <TriangleAlert size={15} className="mt-0.5 shrink-0" /> {hearError}
                    </span>
                    <button type="button" onClick={() => setAttempt((a) => a + 1)} className="press rounded-full bg-white/[0.08] px-3 py-1.5 text-[12.5px] font-semibold text-paper hover:bg-white/[0.14]">
                      Try again
                    </button>
                  </div>
                ) : (
                  <Listening />
                )}
              </div>

              <div className="border-t border-white/[0.07] p-2.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span ref={setVoiceAnchor} className="inline-flex shrink-0">
                    <Popover
                      placement="top-start"
                      panelClassName="p-0"
                      trigger={({ toggle, open, id }) => (
                        <ChipButton onClick={toggle} aria-expanded={open} aria-controls={id} aria-haspopup="dialog" title="Who speaks" className="pl-1.5">
                          {voiceCard ? (
                            <Orb hues={voiceCard.hues} size={22} />
                          ) : (
                            <span className="grid size-[22px] place-items-center rounded-full bg-[color-mix(in_oklab,var(--color-tool-lipsync)_22%,transparent)] text-[var(--color-tool-lipsync)]">
                              <Mic size={12} />
                            </span>
                          )}
                          {voiceCard ? voiceCard.name : "Their own voice"}
                          <ChevronDown size={13} className="text-haze" />
                        </ChipButton>
                      )}
                    >
                      {(close) => (
                        <div className="flex w-[290px] flex-col gap-1 p-2">
                          <p className="label px-1.5 pb-1 pt-1">Who speaks</p>
                          <button
                            type="button"
                            onClick={() => (setPrefs({ voice: "clone" }), close())}
                            className={cn("press squircle flex items-center gap-2.5 rounded-[14px] p-2 text-left hover:bg-white/[0.05]", cloning && "bg-white/[0.06]")}
                          >
                            <span className="grid size-8 shrink-0 place-items-center rounded-full bg-[color-mix(in_oklab,var(--color-tool-lipsync)_22%,transparent)] text-[var(--color-tool-lipsync)]">
                              <Mic size={15} />
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block text-[13.5px] font-semibold text-paper">Their own voice</span>
                              <span className="block text-[11.5px] leading-snug text-haze">Only the lines you change, cloned from the clip with your permission</span>
                            </span>
                            {cloning ? <Check size={14} className="shrink-0 text-paper" /> : null}
                          </button>
                          <button type="button" onClick={() => (setVoicesOpen(true), close())} className="press squircle flex items-center gap-2.5 rounded-[14px] p-2 text-left hover:bg-white/[0.05]">
                            <Orb hues={voiceCard?.hues ?? FALLBACK} size={32} />
                            <span className="min-w-0 flex-1">
                              <span className="block text-[13.5px] font-semibold text-paper">{voiceCard ? voiceCard.name : "Another voice…"}</span>
                              <span className="block text-[11.5px] leading-snug text-haze">{voiceCard ? "Every line, timed to their lips · pick another" : "Every line in it, timed to their lips"}</span>
                            </span>
                            {voiceCard ? <Check size={14} className="shrink-0 text-paper" /> : null}
                          </button>
                        </div>
                      )}
                    </Popover>
                  </span>
                  <Popover
                    placement="top-start"
                    panelClassName="p-0"
                    trigger={({ toggle, open, id }) => (
                      <ChipButton onClick={toggle} aria-expanded={open} aria-controls={id} aria-haspopup="dialog" title="The speech model" className="pr-2.5">
                        <VoiceModelMark model={m} size={15} variant="bare" />
                        {m.name}
                        {!speechOn.length && voiceLoaded ? <span className="font-medium text-tungsten">· get it</span> : null}
                        <ChevronDown size={13} className="shrink-0 text-haze" />
                      </ChipButton>
                    )}
                  >
                    {(close) => (
                      <div className="flex w-[300px] flex-col gap-1 p-2">
                        <p className="label px-1.5 pb-1 pt-1">Says the new words</p>
                        {SPEAKERS.map((x) => {
                          const on = voiceMachines.filter((v) => v.online && v.engine && v.models.includes(x.id));
                          return (
                            <button
                              key={x.id}
                              type="button"
                              onClick={() => (setPrefs({ model: x.id }), close())}
                              className={cn("press squircle flex items-center gap-2.5 rounded-[14px] p-2 text-left hover:bg-white/[0.05]", x.id === m.id && "bg-white/[0.06]")}
                            >
                              <VoiceModelMark model={x} size={30} />
                              <span className="min-w-0 flex-1">
                                <span className="block text-[13.5px] font-semibold text-paper">{x.name}</span>
                                <span className={cn("block truncate text-[11.5px]", on.length ? "text-haze" : "text-tungsten")}>{on.length ? `On ${on.map((v) => v.gpu ?? v.label).join(", ")}` : "Not on your GPUs yet"}</span>
                              </span>
                              {x.id === m.id ? <Check size={14} className="shrink-0 text-paper" /> : null}
                            </button>
                          );
                        })}
                        <Link href="/tools/voice" className="press mt-0.5 inline-flex h-8 items-center justify-center gap-1 rounded-[12px] text-[12.5px] font-semibold text-fog hover:bg-white/[0.05] hover:text-paper">
                          Voice models <ArrowUpRight size={12} />
                        </Link>
                      </div>
                    )}
                  </Popover>
                  <Popover
                    placement="top-start"
                    panelClassName="p-0"
                    trigger={({ toggle, open, id }) => (
                      <ChipButton onClick={toggle} aria-expanded={open} aria-controls={id} aria-haspopup="dialog" title="How the new mouth is drawn" className="pr-2.5">
                        <Sparkles size={14} className={cn("shrink-0", best ? "text-[var(--color-tool-lipsync)]" : "text-haze")} />
                        {best ? "Best quality" : "Standard"}
                        <ChevronDown size={13} className="shrink-0 text-haze" />
                      </ChipButton>
                    )}
                  >
                    {(close) => (
                      <div className="flex w-[300px] flex-col gap-1 p-2">
                        <p className="label px-1.5 pb-1 pt-1">The new mouth</p>
                        <button
                          type="button"
                          onClick={() => (setPrefs({ quality: "standard" }), close())}
                          className={cn("press squircle flex items-center gap-2.5 rounded-[14px] p-2 text-left hover:bg-white/[0.05]", !best && "bg-white/[0.06]")}
                        >
                          <span className="min-w-0 flex-1">
                            <span className="block text-[13.5px] font-semibold text-paper">Standard</span>
                            <span className="block text-[11.5px] leading-snug text-haze">
                              LatentSync redraws the mouth{analysis && regions.length ? ` · about ${minutesFor(regions, analysis, whole)} min` : ""}
                            </span>
                          </span>
                          {!best ? <Check size={14} className="shrink-0 text-paper" /> : null}
                        </button>
                        <button
                          type="button"
                          disabled={!bestHere}
                          onClick={() => (setPrefs({ quality: "best" }), close())}
                          className={cn("press squircle flex items-center gap-2.5 rounded-[14px] p-2 text-left enabled:hover:bg-white/[0.05] disabled:cursor-not-allowed", best && "bg-white/[0.06]")}
                        >
                          <span className="min-w-0 flex-1">
                            <span className={cn("block text-[13.5px] font-semibold", bestHere ? "text-paper" : "text-haze")}>Best quality</span>
                            <span className={cn("block text-[11.5px] leading-snug", bestHere ? "text-haze" : "text-tungsten")}>
                              {bestHere ? `Then HuMo 17B makes the teeth and lips their own${analysis && regions.length ? ` · about ${minutesFor(regions, analysis, whole, humoSeconds)} min` : ""}` : bestWhy}
                            </span>
                          </span>
                          {best ? <Check size={14} className="shrink-0 text-paper" /> : null}
                        </button>
                        {!bestHere && home && bestRoom ? (
                          <Link href="/settings/tools?tool=lipsync" className="press mt-0.5 inline-flex h-8 items-center justify-center gap-1 rounded-[12px] text-[12.5px] font-semibold text-fog hover:bg-white/[0.05] hover:text-paper">
                            {bridgeHas(home.bridge, "lipsyncBest") ? "Get HuMo 17B" : "Update it in Settings"} <ArrowUpRight size={12} />
                          </Link>
                        ) : null}
                      </div>
                    )}
                  </Popover>
                </div>

                {cloning ? (
                  <label className="mt-2 flex cursor-pointer items-start gap-2 px-1 text-[12.5px] leading-snug text-fog">
                    <input type="checkbox" checked={consent} onChange={(e) => (setConsent(e.target.checked), setNotice(null))} className="mt-[1px] size-4 shrink-0 accent-[var(--color-tool-lipsync)]" />
                    <span>I may use this person&rsquo;s voice: it&rsquo;s mine, or they agreed to it.</span>
                  </label>
                ) : null}

                <div className="mt-2.5 flex items-center gap-2">
                  <div className="min-w-0 flex-1 text-[12.5px] leading-snug" aria-live="polite">
                    {notice ? (
                      <span className="text-tally">{notice}</span>
                    ) : failed && !live ? (
                      <span className="line-clamp-2 text-tally" title={failed.error}>
                        {failed.error}
                      </span>
                    ) : analysis ? (
                      <span className="text-haze">
                        {regions.length || whole
                          ? [
                              regions.length ? `${regions.length} ${regions.length === 1 ? "stretch" : "stretches"} to redo` : null,
                              voiceCard ? `${regions.length ? "every" : "Every"} line in ${voiceCard.name}${regions.length ? "" : ", timed to their lips"}` : null,
                              `about ${minutesFor(regions, analysis, whole, best && regions.length > 0 ? humoSeconds : 0)} min`,
                            ]
                              .filter(Boolean)
                              .join(" · ")
                          : "Nothing changed yet"}
                        {regions.length && home ? ` on ${home.gpu ?? home.label}` : !regions.length && whole && speechOn[0] ? ` on ${speechOn[0].gpu ?? speechOn[0].label}` : ""}
                      </span>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    onClick={() => void sync()}
                    disabled={busy || !analysis}
                    className="lip squircle flex h-12 shrink-0 items-center justify-center gap-2 rounded-[16px] bg-spike px-5 text-spike-ink transition-[background-color,transform,box-shadow] duration-150 [--lip:var(--color-spike-lip)] hover:bg-spike-hi disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {busy ? <LoaderCircle size={17} className="animate-spin" /> : null}
                    <span className="font-display text-[19px] leading-none">{!regions.length && whole ? "Change voice" : "Sync lips"}</span>
                    <CornerDownLeft size={12} className="hidden opacity-60 sm:block" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <Start onPick={choose} />
        )}
      </section>

      <Takes takes={takes} current={shown?.id ?? null} onShow={showTake} onEdit={editFurther} onCancel={(g) => void cancel(g.id)} />

      {drawerIn || voicesOpen ? <VoiceDrawer open={voicesOpen} onClose={() => setVoicesOpen(false)} anchor={voiceAnchor} current={voiceCard?.id ?? null} onPick={(v) => setPrefs({ voice: v.id })} /> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ start: a clip */

/** No clip yet: drop one (or browse), or pick a clip you made. */
function Start({ onPick }: { onPick: (c: Clip) => void }) {
  // Your finished clips, followed on their own: a job running elsewhere doesn't redraw this.
  const items = useGenerations(useShallow((s) => s.items.filter((g) => g.status === "done" && g.tool !== "voice" && g.outputs.some((o) => o.kind === "video"))));
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recent = useMemo(
    () =>
      items
        .filter((g) => g.status === "done" && g.tool !== "voice")
        .flatMap((g) => g.outputs.filter((o) => o.kind === "video").map((o) => ({ url: o.url, name: (g.params?.lipsync as LipsyncAsk | undefined)?.name ?? (g.prompt.slice(0, 48) || "Clip"), w: o.width ?? 9, h: o.height ?? 16 })))
        .slice(0, 14),
    [items],
  );

  async function upload(file?: File) {
    if (!file) return;
    if (!file.type.startsWith("video/")) return setError("Pick a video file (MP4, MOV or WebM).");
    setError(null);
    setUploading(true);
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch("/api/uploads", { method: "POST", body });
      const data = (await res.json()) as { items?: { url: string }[]; error?: string };
      if (!res.ok || !data.items?.[0]) throw new Error(data.error ?? "Upload failed.");
      onPick({ url: data.items[0].url, name: file.name.replace(/\.[^.]+$/, "") });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-[calc(100svh-2rem)] w-full max-w-[1000px] flex-col justify-center px-4 py-16 sm:px-8">
      <div className="flex justify-center">
        <LipsMark />
      </div>
      <h1 className="mt-6 text-center font-display text-[42px] sm:text-[60px] lg:text-[74px]">Change what they say</h1>
      <p className="mx-auto mt-3 max-w-[60ch] text-center text-[15px] leading-relaxed text-fog sm:text-base">
        Drop a clip of someone talking and edit their words. The new ones are said in their own voice, and only the mouth is redrawn, only where the words changed. Or give them another voice: every line is said again in it, timed to their lips.
      </p>

      <button
        type="button"
        onClick={() => input.current?.click()}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void upload(e.dataTransfer.files[0]);
        }}
        className={cn(
          "squircle press mt-8 flex h-40 w-full flex-col items-center justify-center gap-2 rounded-[26px] bg-white/[0.03] text-fog shadow-[inset_0_0_0_1px_var(--color-line-strong)] hover:bg-white/[0.05] hover:text-paper",
          dragging && "shadow-[inset_0_0_0_2px_var(--color-tool-lipsync)]",
        )}
      >
        {uploading ? <LoaderCircle size={22} className="animate-spin" /> : <Upload size={22} />}
        <span className="text-[15px] font-semibold text-paper">{uploading ? "Uploading…" : "Drop a clip or browse"}</span>
        <span className="text-[12.5px] text-haze">MP4, MOV or WebM · someone talking, their face in view</span>
      </button>
      <input
        ref={input}
        type="file"
        accept="video/*"
        hidden
        onChange={(e) => {
          void upload(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      {error ? <p className="mt-3 text-center text-[13px] text-tally">{error}</p> : null}

      {recent.length ? (
        <div className="mt-7">
          <p className="px-1 text-[12px] font-semibold uppercase tracking-[0.12em] text-haze">Or a clip you made</p>
          <div className="scrollbar-none strip-fade -mx-1 mt-2 flex gap-2 overflow-x-auto p-1 pr-9">
            {recent.map((c) => (
              <button
                key={c.url}
                type="button"
                onClick={() => onPick({ url: c.url, name: c.name })}
                title={c.name}
                className="press squircle relative h-28 shrink-0 overflow-hidden rounded-[14px] bg-black shadow-[0_0_0_1px_var(--color-line)] hover:shadow-[0_0_0_1px_var(--color-line-strong)] hover:brightness-110"
                style={{ aspectRatio: `${c.w} / ${c.h}` }}
              >
                <Poster url={c.url} />
                <Film size={12} className="absolute bottom-1.5 left-1.5 text-white/80 drop-shadow" />
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Two lips, drawn: the tool's mark on its first screen. */
function LipsMark() {
  return (
    <span className="grid size-[92px] place-items-center rounded-[30px] bg-[color-mix(in_oklab,var(--color-tool-lipsync)_14%,transparent)] shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-tool-lipsync)_30%,transparent)]">
      <svg width="54" height="54" viewBox="0 0 100 100" aria-hidden="true" fill="var(--color-tool-lipsync)">
        <path d="M6 50C14 41 24 29 34 29c7 0 11 5 16 8 5-3 9-8 16-8 10 0 20 12 28 21-14 0-28-3-44-3S20 50 6 50Z" />
        <path d="M10 56c13 1 26-2 40-2s27 3 40 2C82 70 68 80 50 80S18 70 10 56Z" />
      </svg>
    </span>
  );
}

/** While speech to text writes out the clip: a few lines being written. */
function Listening() {
  return (
    <div className="flex flex-col gap-3 px-2 py-3" aria-live="polite">
      <p className="flex items-center gap-2 text-[13px] text-fog">
        <LoaderCircle size={14} className="animate-spin" /> Listening to what they say…
      </p>
      {[86, 64, 92, 48].map((w, i) => (
        <span key={i} className="block h-3.5 animate-pulse rounded-full bg-white/[0.06]" style={{ width: `${w}%`, animationDelay: `${i * 120}ms` }} />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ the player */

type PlayerApi = { playStretch: (from: number, to: number) => void };

/**
 * The clip, or the take made from it (Before and After keep the moment and whether it plays), as tall as the page, with
 * the dot field over it while a take is on its way. Nothing else: the sentences and their times are on the right.
 */
function Player({
  apiRef,
  clip,
  after,
  before,
  setBefore,
  live,
  onCancel,
  onClose,
  onTime,
}: {
  apiRef: React.RefObject<PlayerApi | null>;
  clip: Clip;
  after: string | null;
  before: boolean;
  setBefore: (v: boolean) => void;
  live: Generation | null;
  onCancel: () => void;
  onClose: () => void;
  onTime: (t: number) => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const keep = useRef<{ t: number; playing: boolean } | null>(null);
  const stopAt = useRef<number | null>(null);
  const raf = useRef(0);
  const src = before || !after ? clip.url : after;

  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  // Plays one sentence: from just before it to just after, stopping right there (watched every frame while it plays).
  useEffect(() => {
    apiRef.current = {
      playStretch: (from, to) => {
        const v = video.current;
        if (!v) return;
        v.currentTime = Math.max(0, from - 0.12);
        stopAt.current = to + 0.2;
        void v.play().catch(() => {});
        cancelAnimationFrame(raf.current);
        const tick = () => {
          if (stopAt.current == null) return;
          if (v.currentTime >= stopAt.current || v.paused) {
            if (!v.paused) v.pause();
            stopAt.current = null;
            return;
          }
          raf.current = requestAnimationFrame(tick);
        };
        raf.current = requestAnimationFrame(tick);
      },
    };
  }, [apiRef]);

  const swap = (b: boolean) => {
    const v = video.current;
    if (v) keep.current = { t: v.currentTime, playing: !v.paused };
    setBefore(b);
  };

  return (
    <div className="flex min-h-[320px] min-w-0 items-center justify-center lg:h-full lg:min-h-0">
      <div className="relative max-h-full max-w-full overflow-hidden rounded-[22px] bg-black">
        <video
          ref={video}
          key={src}
          src={src}
          controls
          playsInline
          preload="auto"
          className="block max-h-[70svh] max-w-full lg:max-h-[calc(100svh-2rem)]"
          onLoadedMetadata={(e) => {
            const v = e.currentTarget;
            const k = keep.current;
            keep.current = null;
            if (k) {
              v.currentTime = Math.min(k.t, Math.max(0, (v.duration || k.t) - 0.05));
              if (k.playing) void v.play().catch(() => {});
            }
          }}
          onTimeUpdate={(e) => onTime(e.currentTarget.currentTime)}
        />
        <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-2 p-2.5">
          <button
            type="button"
            onClick={onClose}
            aria-label="Choose another clip"
            title={`${clip.name} · choose another clip`}
            className="press pointer-events-auto grid size-8 place-items-center rounded-full bg-black/55 text-fog ring-1 ring-white/[0.08] hover:text-paper"
          >
            <X size={14} />
          </button>
          {after ? (
            <div className="pointer-events-auto flex items-center gap-0.5 rounded-full bg-black/55 p-0.5 text-[12px] font-semibold ring-1 ring-white/[0.08]">
              {(["Before", "After"] as const).map((v) => {
                const on = (v === "Before") === before;
                return (
                  <button key={v} type="button" aria-pressed={on} onClick={() => swap(v === "Before")} className={cn("press rounded-full px-3 py-1", on ? "bg-paper text-[#16131b]" : "text-fog hover:text-paper")}>
                    {v}
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
        {live ? <GeneratingField stage={live.stage} progress={live.progress} prompt={live.prompt} since={live.createdAt} onCancel={onCancel} /> : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ the words */

/**
 * The clip's sentences, each editable where it stands: a changed one shows what was said under it and whether the new
 * words fit their time. Enter goes to the next sentence; Ctrl or ⌘ Enter syncs. The time plays that sentence.
 */
function Transcript({
  analysis,
  edited,
  setEdited,
  regions,
  rate,
  onPlay,
  onSubmit,
}: {
  analysis: LipAnalysis;
  edited: Record<number, string>;
  setEdited: (fn: (e: Record<number, string>) => Record<number, string>) => void;
  regions: LipRegion[];
  rate: number;
  onPlay: (s: LipSentence) => void;
  onSubmit: () => void;
}) {
  const list = useRef<HTMLOListElement>(null);
  // The sentence(s) being said right now; this redraws only when that changes, not with every tick of the clip.
  const saying = useClipTime((c) =>
    analysis.sentences
      .filter((s) => c.t >= s.start - 0.05 && c.t < s.end + 0.1)
      .map((s) => s.id)
      .join(","),
  );
  // Each stretch's fit, shown under its last sentence.
  const fits = useMemo(() => {
    const out = new Map<number, Fit>();
    for (const r of regions) out.set(r.sentences[r.sentences.length - 1], fitOf(r, rate));
    return out;
  }, [regions, rate]);

  if (!analysis.audio) return <p className="px-2 py-4 text-[13.5px] text-fog">This clip has no sound: there&rsquo;s nothing said to change.</p>;
  if (!analysis.sentences.length) return <p className="px-2 py-4 text-[13.5px] text-fog">No one speaks in this clip, as far as speech to text can hear.</p>;

  const focus = (i: number) => list.current?.querySelector<HTMLTextAreaElement>(`[data-line="${i}"]`)?.focus();
  return (
    <ol ref={list} className="flex flex-col gap-1">
      {analysis.sentences.map((s, i) => {
        const value = edited[s.id] ?? s.text;
        const changed = edited[s.id] !== undefined && !sameWords(edited[s.id], s.text);
        const fit = fits.get(s.id);
        const now = saying.split(",").includes(String(s.id));
        return (
          <li
            key={s.id}
            className={cn(
              "group squircle relative rounded-[16px] px-2 py-1.5 transition-colors",
              changed ? "bg-[color-mix(in_oklab,var(--color-tool-lipsync)_9%,transparent)] shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-tool-lipsync)_28%,transparent)]" : "hover:bg-white/[0.03]",
            )}
          >
            <div className="flex items-start gap-2">
              <button
                type="button"
                onClick={() => onPlay(s)}
                title="Play this sentence"
                aria-label={`Play from ${clock(s.start)}`}
                className={cn("tabular press mt-[3px] shrink-0 rounded-full px-1.5 py-0.5 font-mono text-[11px]", now ? "bg-paper text-[#16131b]" : "text-haze hover:bg-white/[0.08] hover:text-paper")}
              >
                {clock(s.start)}
              </button>
              <AutoText
                value={value}
                line={i}
                label={`Sentence ${i + 1}`}
                onChange={(v) => setEdited((e) => ({ ...e, [s.id]: v }))}
                onEnter={(submit) => (submit ? onSubmit() : focus(i + 1))}
                className={cn("min-w-0 flex-1 py-0.5 text-[15.5px] leading-relaxed", changed ? "text-paper" : "text-paper/85")}
              />
              {changed ? (
                <button
                  type="button"
                  aria-label="Back to what they said"
                  title="Back to what they said"
                  onClick={() =>
                    setEdited((e) => {
                      const next = { ...e };
                      delete next[s.id];
                      return next;
                    })
                  }
                  className="press mt-0.5 grid size-7 shrink-0 place-items-center rounded-full text-haze hover:bg-white/[0.08] hover:text-paper"
                >
                  <Undo2 size={13} />
                </button>
              ) : (
                <Pencil size={12} aria-hidden="true" className="mt-2 shrink-0 text-haze opacity-0 transition-opacity group-hover:opacity-60" />
              )}
            </div>
            {changed ? <p className="ml-[52px] mt-0.5 text-[12.5px] leading-snug text-haze line-through decoration-white/25">{s.text}</p> : null}
            {fit ? (
              <p className={cn("ml-[52px] mt-1 text-[12px] font-medium", fit.tone === "bad" ? "text-tally" : fit.tone === "warn" ? "text-tungsten" : fit.tone === "quiet" ? "text-fog" : "text-chroma")}>
                {fit.text}
              </p>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

/** A sentence's text box: one line that grows as it wraps; Enter moves on (with Ctrl or ⌘: syncs) instead of breaking the line. */
function AutoText({ value, onChange, onEnter, label, line, className }: { value: string; onChange: (v: string) => void; onEnter: (submit: boolean) => void; label: string; line: number; className?: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fit = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${el.scrollHeight}px`;
  }, []);
  useLayoutEffect(fit, [value, fit]);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let w = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth !== w) {
        w = el.clientWidth;
        fit();
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit]);
  return (
    <textarea
      ref={ref}
      rows={1}
      value={value}
      data-line={line}
      aria-label={label}
      spellCheck
      onChange={(e) => onChange(e.target.value.replace(/\s*\n\s*/g, " "))}
      onKeyDown={(e) => {
        if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
        e.preventDefault();
        onEnter(e.ctrlKey || e.metaKey);
      }}
      className={cn("block resize-none overflow-hidden bg-transparent outline-none placeholder:text-haze", className)}
    />
  );
}

/* ------------------------------------------------------------------ the takes */

/** Every Lip Sync take, newest first: the new words over the old, how well the mouth follows them, and what to do next. */
function Takes({ takes, current, onShow, onEdit, onCancel }: { takes: Generation[]; current: string | null; onShow: (g: Generation) => void; onEdit: (g: Generation) => void; onCancel: (g: Generation) => void }) {
  return (
    <section aria-labelledby="lip-takes" className="mx-auto mt-12 max-w-[1080px] px-1 sm:mt-16">
      <div className="mb-3 flex items-baseline justify-between gap-3 px-2.5">
        <h2 id="lip-takes" className="font-display text-[24px] sm:text-[28px]">
          Takes {takes.length ? <span className="tabular ml-1 align-middle font-sans text-[13px] font-medium text-haze">{takes.length}</span> : null}
        </h2>
        {takes.length ? (
          <Link href="/library" className="inline-flex items-center gap-1 text-[12.5px] font-semibold text-haze hover:text-paper">
            All in Library <ArrowUpRight size={13} />
          </Link>
        ) : null}
      </div>
      {takes.length ? (
        <ul className="flex flex-col gap-2">
          {takes.map((g) => (
            <TakeRow key={g.id} g={g} active={g.id === current} onShow={() => onShow(g)} onEdit={() => onEdit(g)} onCancel={() => onCancel(g)} />
          ))}
        </ul>
      ) : (
        <div className="squircle grid place-items-center gap-1.5 rounded-[22px] px-6 py-14 text-center shadow-[inset_0_0_0_1px_var(--color-line)]">
          <p className="font-display text-[19px]">Your takes show here</p>
          <p className="text-[13.5px] text-haze">Pick a clip, change a sentence, press Sync lips.</p>
        </div>
      )}
    </section>
  );
}

function TakeRow({ g, active, onShow, onEdit, onCancel }: { g: Generation; active: boolean; onShow: () => void; onEdit: () => void; onCancel: () => void }) {
  const ask = g.params?.lipsync as LipsyncAsk | undefined;
  const report = g.params?.lipsyncReport as LipsyncReport | undefined;
  const out = g.outputs[0];
  const going = isLive(g);
  const scores = (report?.regions ?? []).map((r) => r.sync?.new).filter((x): x is number => typeof x === "number");
  const was = (report?.regions ?? []).map((r) => r.sync?.original).filter((x): x is number => typeof x === "number");
  const low = report?.regions.some((r) => r.low);
  const sync = scores.length ? Math.min(...scores) : null;
  return (
    <li className={cn("squircle flex items-center gap-3 rounded-[18px] p-2 pr-3", active ? "bg-white/[0.05] shadow-[inset_0_0_0_1.5px_var(--color-tool-lipsync)]" : "shadow-[inset_0_0_0_1px_var(--color-line)] hover:bg-white/[0.02]")}>
      <button type="button" onClick={onShow} disabled={!ask} aria-label="Show this take" className="press relative size-[76px] shrink-0 overflow-hidden rounded-[13px] bg-black">
        {out ? (
          <Poster url={out.url} />
        ) : going ? (
          <GeneratingField bare progress={g.progress} stage={g.stage} />
        ) : (
          <span className="grid size-full place-items-center text-tally">
            <TriangleAlert size={18} />
          </span>
        )}
      </button>
      <div className="min-w-0 flex-1">
        {(ask?.regions ?? []).slice(0, 2).map((r, i) => (
          <p key={i} className="truncate text-[14px] leading-snug">
            <span className="text-paper">“{r.text || "…"}”</span> <span className="text-[12.5px] text-haze line-through decoration-white/25">{r.was}</span>
          </p>
        ))}
        {ask?.whole ? <p className="truncate text-[14px] leading-snug text-paper">Every line in {report?.voice?.name ?? "another voice"}</p> : null}
        <p className="mt-1 truncate text-[12px] text-haze">
          {going ? (
            <>
              <RecDot className="mr-1 inline-block align-middle" /> {g.stage ?? "Queued"} · {Math.round((g.progress ?? 0) * 100)}%
            </>
          ) : g.status === "error" ? (
            <span className="text-tally" title={g.error}>
              {g.error ?? "Failed"}
            </span>
          ) : (
            [ask?.name, report?.machine, report?.seconds != null ? `${report.seconds} s` : null].filter(Boolean).join(" · ")
          )}
        </p>
      </div>
      {sync != null ? (
        <span
          title={`How closely the mouth follows the new words (SyncNet, 0 to 1)${was.length ? `; the clip's own mouth with its own words: ${Math.min(...was).toFixed(2)}` : ""}.${low ? " Under 0.5 even after a second try: rephrase, or try again." : ""}`}
          className={cn("tabular hidden shrink-0 rounded-full px-2 py-0.5 text-[11.5px] font-semibold sm:inline", low ? "bg-tally/15 text-tally" : sync >= 0.7 ? "bg-chroma/15 text-chroma" : "bg-tungsten/15 text-tungsten")}
        >
          In sync {sync.toFixed(2)}
        </span>
      ) : null}
      <div className="flex shrink-0 items-center gap-0.5">
        {going ? (
          <Act onClick={onCancel} label="Stop">
            <X size={14} />
          </Act>
        ) : out ? (
          <>
            <Act onClick={onShow} label="Show it">
              <Film size={14} />
            </Act>
            <Act onClick={onEdit} label="Change more words in this take">
              <Pencil size={14} />
            </Act>
            <a href={out.url} download className="press grid size-8 place-items-center rounded-full text-haze hover:bg-white/[0.08] hover:text-paper" aria-label="Download" title="Download">
              <Download size={14} />
            </a>
            <Link href={`/library?view=${g.id}:0`} className="press grid size-8 place-items-center rounded-full text-haze hover:bg-white/[0.08] hover:text-paper" aria-label="Open in Library" title="Open in Library">
              <ArrowUpRight size={14} />
            </Link>
          </>
        ) : null}
      </div>
    </li>
  );
}

/**
 * A clip's still: its opening frame at the width Crackio makes ahead for every clip (640), so it's usually there. One
 * that isn't yet answers "not found" while it's being made; it's asked for again a moment later.
 */
function Poster({ url }: { url: string }) {
  const [tries, setTries] = useState(0);
  const src = posterUrl(url, 640);
  if (!src || tries > 3)
    return (
      <span className="grid size-full place-items-center text-haze">
        <Film size={18} />
      </span>
    );
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      key={tries}
      src={tries ? `${src}&again=${tries}` : src}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => window.setTimeout(() => setTries((t) => t + 1), 1500 * (tries + 1))}
      className="size-full object-cover"
    />
  );
}

function Act({ onClick, label, children }: { onClick: () => void; label: string; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} title={label} className="press grid size-8 place-items-center rounded-full text-haze hover:bg-white/[0.08] hover:text-paper">
      {children}
    </button>
  );
}

