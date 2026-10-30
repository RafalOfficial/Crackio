"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, ChevronLeft, Coins, Copy, Film, Flame, ImagePlus, LoaderCircle, Pause, Play, RotateCcw, Sparkles, TriangleAlert, Upload, Wand2, X } from "lucide-react";
import { Panel, Segmented } from "@/components/ui/Panel";
import { Slider } from "@/components/ui/Slider";
import { DurationRuler } from "@/components/ui/DurationRuler";
import { Media } from "@/components/ui/Media";
import { GeneratingField } from "@/components/ui/GeneratingField";
import { ModelPicker } from "@/components/models/ModelPicker";
import { CostLine } from "@/components/models/CostLine";
import { TargetPicker, targetOf } from "./TargetPicker";
import { useGenerations, useGenerationsStore } from "@/lib/hooks/use-generations";
import { useModelInfo } from "@/lib/hooks/use-custom-models";
import { resolveAutoId, useModels } from "@/lib/hooks/use-models";
import { useCast } from "@/lib/hooks/use-cast";
import { useNow } from "@/lib/hooks/use-now";
import { imageSlots, resolutionLabel, fitResolution, durationTicks, fitDuration, type Caps } from "@/lib/models/caps";
import { templateById } from "@/lib/templates/library";
import { heatBadge, heatOf, swapLabel } from "@/lib/templates/meta";
import { shotPrompt, swapPrompt, type SlotFill } from "@/lib/templates/prompt";
import { EFFECT_MODELS, SWAP_TAGS, clipFit, clipLimit, profileOf, swapModels } from "@/lib/templates/models";
import { LOCAL_RIPPLE_ID, LOCAL_SWAP_ID, LOCAL_SWAP_IDS } from "@/lib/models/catalog";
import { useCustomModels } from "@/lib/hooks/use-custom-models";
import { engineShortName } from "@/lib/providers/names";
import { copyText } from "@/lib/clipboard";
import type { Template, TemplateSlot } from "@/lib/templates/types";
import type { Generation } from "@/lib/generations/types";
import type { Thing } from "@/components/annotate/things";
import { cn } from "@/lib/cn";
import { DEMO, demoWords } from "@/lib/demo/config";
import { DEMO_CREDITS_HINT, demoSwapCredits } from "@/lib/demo/estimate";

type Pic = { url: string; width: number; height: number };
type SlotState = {
  photo?: Pic;
  cast?: { id: string; name: string };
  reading?: boolean;
  error?: string;
  noun: string;
  look: string;
  traits?: string;
  wearing: string;
  outfit?: "trend" | "own";
  /** Your own clip: who this replaces, picked in the frame or typed. */
  target?: string;
  picked?: Thing | null;
  /** Where it was clicked (seconds into the clip, 0–1 across and down): the swap on your own GPU outlines exactly that one. */
  pick?: Point[];
  /** The template's clip, several characters: its outline as shown (tinted in its colour). */
  overlay?: string;
};
type Clip = { url: string; name: string; duration: number };
type Point = { t: number; x: number; y: number };

const EMPTY: SlotState = { noun: "", look: "", wearing: "" };

/** Each character's colour when several are picked in the template's clip. */
const SLOT_COLORS = ["#ff7a45", "#38bdf8", "#a3e635", "#f472b6"];

/** A click as SAM 3.1's point: the same one the outline you saw came from, so the swap outlines the same thing. */
const pointsOf = (_thing: Thing, at: [number, number], t: number): Point[] => [{ t, x: at[0] / 1000, y: at[1] / 1000 }];

async function upload(file: File): Promise<{ url: string; width?: number; height?: number }> {
  const body = new FormData();
  body.append("file", file);
  const res = await fetch("/api/uploads", { method: "POST", body });
  const data = (await res.json()) as { items?: { url: string; width?: number; height?: number }[]; error?: string };
  if (!res.ok || !data.items?.[0]) throw new Error(data.error ?? "Upload failed.");
  return data.items[0];
}

async function describe(image: string, kind: TemplateSlot["kind"]) {
  const res = await fetch("/api/templates/describe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ image, kind }) });
  const data = (await res.json()) as { description?: { noun: string; look: string; traits?: string; wearing: string }; error?: string };
  if (!res.ok || !data.description) throw new Error(data.error ?? "Couldn't read the photo.");
  return data.description;
}

async function frameOf(source: string, t: number): Promise<Pic> {
  const res = await fetch("/api/recast/frame", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source, t }) });
  const data = (await res.json()) as { frame?: Pic; error?: string };
  if (!res.ok || !data.frame) throw new Error(data.error ?? "Couldn't read the clip.");
  return data.frame;
}

/** One template: add your photos, pick a model, see the exact prompt, make it. */
export function TemplateStudio({ id }: { id: string }) {
  const t = templateById(id)!;
  const { items } = useGenerations();
  const now = useNow();
  const swap = t.kind === "swap";
  const needsClip = swap && !t.base;

  const [slots, setSlots] = useState<Record<string, SlotState>>(() => Object.fromEntries(t.slots.map((s) => [s.id, { ...EMPTY, outfit: s.outfit?.default }])));
  const [fields, setFields] = useState<Record<string, string>>(() => Object.fromEntries((t.fields ?? []).map((f) => [f.id, ""])));
  const [useOwn, setUseOwn] = useState(needsClip);
  const [own, setOwn] = useState<Clip | null>(null);
  const [start, setStart] = useState(0);
  const [part, setPart] = useState<number | null>(null);
  const [frame, setFrame] = useState<Pic | null>(null);
  /** Where in your clip that frame is (seconds). */
  const [frameTime, setFrameTime] = useState(0);
  /** The template's own clip at the part used, to click who to replace. */
  const [tplFrame, setTplFrame] = useState<{ pic: Pic; t: number } | null>(null);
  // Several characters: whose turn it is to be clicked in the template's clip.
  const [turn, setTurn] = useState<string | null>(null);
  const [model, setModel] = useState<string>(swap ? LOCAL_RIPPLE_ID : "auto");
  // Until you pick one, a swap runs on the best model for it that can run here.
  const [picked, setPicked] = useState(false);
  const [consent, setConsent] = useState(false);
  const [resolution, setResolution] = useState<string | number | null>(null);
  const [duration, setDuration] = useState<number | "auto">(t.seconds ?? 6);
  const [extra, setExtra] = useState("");
  const [override, setOverride] = useState<string | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);

  const { models, defaults } = useModels();
  // What will run: the model you picked, or what Auto uses right now.
  const effective = model === "auto" ? resolveAutoId("video", models, defaults) : model;
  const info = useModelInfo(effective);
  const caps = info.caps;
  const takesPictures = Boolean(swap && caps && imageSlots(caps) > 0);
  const profile = profileOf(model, takesPictures);
  const featured = useMemo(() => (swap ? swapModels(t) : t.kind === "effect" ? EFFECT_MODELS : []), [swap, t]);
  const rows = useCustomModels((s) => s.rows);
  useEffect(() => {
    for (const id of featured) if (!useCustomModels.getState().rows[id]) void useCustomModels.getState().load(id);
  }, [featured]);
  // Auto: the first listed model that runs here and takes every photo (each connection's best value is listed first).
  const photos = Math.max(t.slots.filter((s) => !s.optional).length, t.slots.filter((s) => slots[s.id]?.photo || slots[s.id]?.cast).length);
  // Your own ComfyUI's swap comes first once it's installed: free, and it sees your photos. LTX-2.5 Ripple takes anyone or
  // anything (up to three); SCAIL-2 people and faces (up to two).
  const runs = (id: string) => models.some((m) => m.id === id && m.available);
  const localSwap = !swap
    ? null
    : runs(LOCAL_RIPPLE_ID) && photos <= 3
      ? LOCAL_RIPPLE_ID
      : runs(LOCAL_SWAP_ID) && t.slots.every((s) => s.optional || s.kind === "person" || s.kind === "face") && photos <= 2
        ? LOCAL_SWAP_ID
        : null;
  const best = swap ? (localSwap ?? featured.find((id) => rows[id]?.available && (!rows[id]?.caps || imageSlots(rows[id]!.caps!) >= photos))) : undefined;
  useEffect(() => {
    if (!picked && best && best !== model) void Promise.resolve().then(() => setModel(best));
  }, [picked, best, model]);
  const auto = swap && !picked && Boolean(best) && model === best;
  const people = t.slots.some((s) => s.kind === "person" || s.kind === "face");
  // LTX-2.5 Ripple outlines exactly who you click and swaps only them; with several characters, each is clicked in turn
  // and followed apart (who becomes whom), else they were swapped from the template's words and ran into each other.
  const roles = t.slots.filter((s) => !s.optional);
  const clickable = swap && model === LOCAL_RIPPLE_ID && roles.length >= 1 && roles.length <= 4;
  const many = clickable && roles.length > 1;
  const subject = t.slots.find((s) => !s.optional) ?? t.slots[0];
  const current = many ? (roles.find((s) => s.id === turn) ?? roles.find((s) => !slots[s.id]?.pick?.length) ?? roles[0]) : subject;
  const unpicked = many && !useOwn ? roles.filter((s) => !slots[s.id]?.pick?.length) : [];
  /** How many seconds of a clip the model edits. */
  const span = swap ? Math.max(1, (clipLimit(model, caps) ?? 30) - 0.1) : 0;
  // A template clip longer than that: the part you pick, else the template's best part.
  const baseSeconds = t.base?.seconds ?? 0;
  const partial = swap && !useOwn && baseSeconds > span + 0.05;
  const partStart = partial ? Math.min(Math.max(0, part ?? t.base?.focus ?? 0), Math.max(0, baseSeconds - span)) : 0;
  // In the model picker: how much of this clip each model takes.
  const clipLength = swap ? (useOwn ? (own ? Math.max(0, own.duration - start) : null) : baseSeconds || null) : null;
  const fit = useCallback((id: string, c: Caps | null) => clipFit(clipLimit(id, c), clipLength), [clipLength]);

  const filled = t.slots.filter((s) => slots[s.id]?.photo || slots[s.id]?.cast);
  const reading = t.slots.some((s) => slots[s.id]?.reading);
  const missing = t.slots.filter((s) => !s.optional && !slots[s.id]?.photo && !slots[s.id]?.cast);
  const room = caps ? imageSlots(caps) : Infinity;
  const tooMany = takesPictures && filled.length > room;

  // The fills the prompt is written from, in the order the photos go to the model.
  const fills: SlotFill[] = useMemo(() => {
    let n = 0;
    return t.slots.flatMap((s) => {
      const st = slots[s.id];
      if (!st?.photo && !st?.cast) return [];
      n++;
      return [
        {
          slot: s,
          noun: st.noun || (s.kind === "person" || s.kind === "face" ? "a person" : `the ${s.kind}`),
          look: st.look || "(reading the photo…)",
          traits: st.traits,
          wearing: st.wearing,
          outfit: st.outfit ?? s.outfit?.default ?? "own",
          name: st.cast?.name,
          picture: takesPictures ? n : undefined,
          target: useOwn ? st.target || undefined : undefined,
        },
      ];
    });
  }, [t.slots, slots, takesPictures, useOwn]);
  const written = swap ? swapPrompt(t, fills, profile, { ownClip: useOwn, extra }) : shotPrompt(t, fills, fields);
  const prompt = override ?? written;

  // Settings the model offers.
  const resChoices = caps?.resolution?.choices ?? [];
  // The template's resolution for this model (Genjutsu at 480p costs a fifth of 1080p), unless you pick one.
  const resValue = resChoices.length ? fitResolution(resChoices, resolution ?? profile.resolution ?? undefined, caps?.resolution?.default ?? null) : null;
  const ticks = !swap && caps?.duration ? durationTicks(caps.duration) : null;
  const lengthValue = !swap && caps?.duration ? fitDuration(caps.duration, duration) : duration;

  const takes = useMemo(() => items.filter((g) => g.tool === "templates" && g.params?.template === t.id), [items, t.id]);
  const live = takes.find((g) => g.status === "queued" || g.status === "running");
  const shownTake = takes.find((g) => g.id === viewing) ?? live ?? takes.find((g) => g.status === "done") ?? null;

  const clipReady = !swap || (useOwn ? Boolean(own) : Boolean(t.base));
  const ready = !missing.length && !reading && clipReady && !tooMany && !busy && !unpicked.length && (!people || consent) && (t.kind !== "kit" || (t.fields ?? []).every((f) => fields[f.id]?.trim() || f.examples[0]));

  // The template's clip at the part used, for clicking who to replace in it.
  const tplUrl = t.base?.url;
  useEffect(() => {
    if (!clickable || useOwn || !tplUrl) return;
    let live = true;
    void frameOf(tplUrl, partStart)
      .then((pic) => live && setTplFrame({ pic, t: partStart }))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [clickable, useOwn, tplUrl, partStart]);

  function patch(id: string, p: Partial<SlotState>) {
    setSlots((all) => ({ ...all, [id]: { ...(all[id] ?? EMPTY), ...p } }));
  }

  async function read(slot: TemplateSlot, image: string) {
    patch(slot.id, { reading: true, error: undefined });
    try {
      const d = await describe(image, slot.kind);
      patch(slot.id, { reading: false, noun: d.noun, look: d.look, traits: d.traits, wearing: d.wearing });
    } catch (err) {
      patch(slot.id, { reading: false, error: (err as Error).message });
    }
  }

  async function pickClip(file?: File) {
    if (!file) return;
    if (!file.type.startsWith("video/")) return setError("Pick a video file (MP4, MOV or WebM).");
    setError(null);
    try {
      const duration = await new Promise<number>((resolve) => {
        const v = document.createElement("video");
        v.preload = "metadata";
        v.onloadedmetadata = () => resolve(v.duration || 0);
        v.onerror = () => resolve(0);
        v.src = URL.createObjectURL(file);
      });
      const up = await upload(file);
      setOwn({ url: up.url, name: file.name, duration });
      setStart(0);
      setFrame(await frameOf(up.url, 0));
      setFrameTime(0);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function make() {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/templates/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          template: t.id,
          model,
          slots: Object.fromEntries(
            t.slots.flatMap((s) => {
              const st = slots[s.id];
              if (!st?.photo && !st?.cast) return [];
              const pick = clickable && st.pick?.length ? st.pick : undefined;
              return [[s.id, { image: st.photo?.url, cast: st.cast?.id, noun: st.noun || undefined, look: st.look || undefined, traits: st.traits || undefined, wearing: st.wearing || undefined, outfit: st.outfit, target: st.target || undefined, pick }]];
            }),
          ),
          fields,
          ...(swap && useOwn && own ? { clip: { url: own.url, start } } : {}),
          ...(partial ? { start: partStart } : {}),
          options: { ...(resValue !== null ? { resolution: String(resValue) } : {}), ...(!swap && typeof lengthValue === "number" ? { duration: lengthValue } : {}) },
          ...(override ? { prompt: override } : {}),
          ...(extra.trim() ? { extra } : {}),
          consent,
        }),
      });
      const data = (await res.json()) as { item?: Generation; error?: string };
      if (!res.ok || !data.item) throw new Error(data.error ?? "Couldn't start it.");
      const store = useGenerationsStore.getState();
      useGenerationsStore.setState({ items: [data.item, ...store.items] });
      void store.load();
      setViewing(data.item.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const heat = heatOf(t, now);
  const badge = heatBadge(t);
  const seconds = swap ? Math.min(span || 8, useOwn ? (own ? own.duration - start : span) : (t.base?.seconds ?? 8)) : typeof lengthValue === "number" ? lengthValue : (t.seconds ?? 6);

  return (
    <div className="mx-auto max-w-[1440px] px-4 pb-16 pt-6 sm:px-6 lg:px-10 lg:pt-8">
      <Link href="/templates" className="inline-flex items-center gap-1 text-[13px] font-semibold text-fog hover:text-paper">
        <ChevronLeft size={15} /> Templates
      </Link>

      <div className="mt-4 grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(380px,460px)]">
        <Stage
          t={t}
          take={shownTake}
          own={useOwn ? own : null}
          takes={takes}
          onView={setViewing}
        />

        <Panel className="flex flex-col">
          <div className="border-b border-line p-4">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="rounded-[7px] bg-white/[0.07] px-1.5 py-[3px] text-[10.5px] font-bold uppercase tracking-[0.05em] text-fog">{swapLabel(t)}</span>
              {heat >= 4 ? (
                <span className="inline-flex items-center gap-1 rounded-[7px] bg-spike px-1.5 py-[3px] text-[10.5px] font-bold uppercase tracking-[0.05em] text-spike-ink">
                  <Flame size={11} /> Hot
                </span>
              ) : null}
              <span className="text-[11.5px] text-haze">
                {swap ? (t.base ? `${t.base.seconds.toFixed(0)} s clip` : "Your clip") : `${t.seconds ?? 6} s`} · {t.aspect}
              </span>
              {badge ? <span className="text-[11.5px] font-semibold text-spike">· {badge}</span> : null}
            </div>
            <h1 className="mt-2 font-display text-[26px] uppercase leading-[1.02] tracking-[-0.01em] sm:text-[30px]">{t.title}</h1>
            <p className="mt-1.5 text-[14px] leading-relaxed text-fog">{t.line}</p>
            <p className="mt-2 flex items-start gap-1.5 text-[12px] leading-relaxed text-haze">
              <Flame size={12} className="mt-[3px] shrink-0" />
              <span>{t.trend.note}</span>
            </p>
            {swap && t.keep.length ? <p className="mt-1.5 text-[12px] leading-relaxed text-haze">Stays the same: {t.keep.join(", ")}, the camera and the sound.</p> : null}

          </div>

          <div className="space-y-6 p-4">
            {t.slots.map((s) => (
              <SlotCard
                key={s.id}
                slot={s}
                state={slots[s.id] ?? EMPTY}
                onPhoto={async (file) => {
                  try {
                    const up = await upload(file);
                    patch(s.id, { photo: { url: up.url, width: up.width ?? 1, height: up.height ?? 1 }, cast: undefined, noun: "", look: "", traits: undefined, wearing: "" });
                    void read(s, up.url);
                  } catch (err) {
                    setError((err as Error).message);
                  }
                }}
                onCast={(c) => {
                  patch(s.id, { cast: { id: c.id, name: c.name }, photo: { url: c.photo, width: 1, height: 1 }, noun: "", look: "", traits: undefined, wearing: "" });
                  void read(s, c.photo);
                }}
                onClear={() => patch(s.id, { ...EMPTY, outfit: s.outfit?.default })}
                onChange={(p) => patch(s.id, p)}
              />
            ))}

            {t.fields?.length ? (
              <Section title="Fill in the blanks">
                <div className="space-y-3">
                  {t.fields.map((f) => (
                    <label key={f.id} className="block">
                      <span className="mb-1 block text-[12.5px] font-semibold text-paper">{f.label}</span>
                      <input
                        value={fields[f.id] ?? ""}
                        onChange={(e) => setFields((all) => ({ ...all, [f.id]: e.target.value.slice(0, f.max ?? 120) }))}
                        placeholder={f.placeholder}
                        className="field-focus block h-10 w-full rounded-[12px] bg-white/[0.04] px-3 text-[13.5px] text-paper outline-none placeholder:text-haze"
                      />
                      <span className="scrollbar-none mt-1.5 flex gap-1 overflow-x-auto">
                        {f.examples.map((ex) => (
                          <button
                            key={ex}
                            type="button"
                            onClick={() => setFields((all) => ({ ...all, [f.id]: ex }))}
                            className="press h-6 shrink-0 rounded-full bg-white/[0.05] px-2 text-[11px] font-semibold text-fog hover:text-paper"
                          >
                            {ex}
                          </button>
                        ))}
                      </span>
                    </label>
                  ))}
                </div>
              </Section>
            ) : null}

            {swap ? (
              <Section
                title="Clip"
                hint={
                  useOwn
                    ? own
                      ? `${own.name} · ${own.duration.toFixed(1)} s`
                      : `Up to ${span} s is used`
                    : partial
                      ? `${Math.round(span)} of ${baseSeconds.toFixed(0)} s · motion, camera and sound stay`
                      : `${t.base?.seconds.toFixed(1)} s · motion, camera and sound stay`
                }
              >
                {!needsClip ? (
                  <Segmented
                    className="mb-2.5 w-full [&>button]:flex-1"
                    value={useOwn ? "own" : "template"}
                    onChange={(v) => setUseOwn(v === "own")}
                    options={[
                      { id: "template", label: "The template's clip" },
                      { id: "own", label: "My own clip" },
                    ]}
                  />
                ) : null}
                {useOwn ? (
                  <OwnClip
                    t={t}
                    own={own}
                    start={start}
                    span={span}
                    frame={frame}
                    slots={slots}
                    onPick={pickClip}
                    onClear={() => {
                      setOwn(null);
                      setFrame(null);
                      setSlots((all) => Object.fromEntries(Object.entries(all).map(([k, st]) => [k, { ...st, picked: null, pick: undefined }])));
                    }}
                    onStart={setStart}
                    onRescan={async (at) => {
                      const next = await frameOf(own!.url, at).catch(() => null);
                      if (!next) return;
                      setFrame(next);
                      setFrameTime(at);
                    }}
                    onTarget={(slotId, picked, at) => patch(slotId, { picked, target: targetOf(picked), pick: clickable ? pointsOf(picked, at, frameTime) : undefined })}
                    onTargetText={(slotId, target) => patch(slotId, { target, picked: null, pick: undefined })}
                    hint={clickable ? "Click who (or what) to swap: it's outlined through the whole clip" : undefined}
                  />
                ) : partial ? (
                  <>
                    <Slider
                      label="Swap the part"
                      value={partStart}
                      min={0}
                      max={Math.max(0.5, baseSeconds - span)}
                      step={0.5}
                      onChange={setPart}
                      format={(v) => `${v.toFixed(1)}–${Math.min(baseSeconds, v + span).toFixed(1)} s`}
                    />
                    <p className="mt-1.5 text-[11.5px] leading-relaxed text-haze">This model edits up to {Math.round(span)} s. H3 Recast and Genjutsu take the whole clip.</p>
                  </>
                ) : null}
                {clickable && !useOwn && current ? (
                  <div className={cn(partial && "mt-3")}>
                    <span className="label mb-1.5 block">{many ? "Who becomes who" : "Who to replace"}</span>
                    {many ? (
                      <div className="mb-2 flex flex-wrap gap-1.5">
                        {roles.map((s, i) => {
                          const name = slots[s.id]?.cast?.name ?? s.label;
                          const done = Boolean(slots[s.id]?.pick?.length);
                          return (
                            <button
                              key={s.id}
                              type="button"
                              onClick={() => setTurn(s.id)}
                              className={cn(
                                "press inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[12px] font-semibold",
                                s.id === current.id ? "bg-white/[0.12] text-paper" : "bg-white/[0.05] text-fog hover:text-paper",
                              )}
                            >
                              <span className="size-2.5 rounded-full" style={{ background: SLOT_COLORS[i] }} />
                              {name}
                              {done ? <Check size={12} className="text-haze" /> : null}
                            </button>
                          );
                        })}
                      </div>
                    ) : null}
                    {tplFrame ? (
                      <TargetPicker
                        key={`${tplFrame.pic.url}|${current.id}`}
                        frame={tplFrame.pic}
                        picked={slots[current.id]?.picked ?? null}
                        hint={
                          !many
                            ? "Click who (or what) to swap: it's outlined through the whole clip"
                            : slots[current.id]?.pick?.length
                              ? `The ${slots[current.id]?.picked?.label ?? "one"} becomes ${slots[current.id]?.cast?.name ?? current.label.toLowerCase()} · click someone else to change`
                              : `Click who becomes ${slots[current.id]?.cast?.name ?? current.label.toLowerCase()}`
                        }
                        outline
                        {...(many
                          ? {
                              tint: SLOT_COLORS[roles.indexOf(current)],
                              overlay: slots[current.id]?.overlay,
                              label: slots[current.id]?.cast?.name ?? current.label,
                              layers: roles.flatMap((s, i) => {
                                const st = slots[s.id];
                                return s.id !== current.id && st?.overlay && st.picked ? [{ overlay: st.overlay, label: st.cast?.name ?? s.label, color: SLOT_COLORS[i], box: st.picked.box }] : [];
                              }),
                            }
                          : {})}
                        onPick={(thing, at, overlay) => {
                          patch(current.id, { picked: thing, target: targetOf(thing), pick: pointsOf(thing, at, tplFrame.t), overlay });
                          // On to the next one not clicked yet.
                          if (many) setTurn(roles.find((s) => s.id !== current.id && !slots[s.id]?.pick?.length)?.id ?? current.id);
                        }}
                      />
                    ) : (
                      <div className="skeleton mx-auto aspect-[9/16] max-h-[420px] w-full rounded-[14px]" />
                    )}
                  </div>
                ) : null}
              </Section>
            ) : null}

            <Section
              title="Model"
              hint={
                swap
                  ? auto && LOCAL_SWAP_IDS.includes(model)
                    ? demoWords("Auto · free on your own GPU")
                    : auto && rows[model]
                    ? `Auto · ${SWAP_TAGS[model]?.toLowerCase() ?? "best fit"} on ${engineShortName(rows[model].provider)}`
                    : takesPictures
                      ? "Gets your photos"
                      : ""
                  : undefined
              }
            >
              {swap ? (
                <ModelPicker
                  kind="video"
                  task="video-swap"
                  only={LOCAL_SWAP_IDS}
                  featured={featured}
                  tags={SWAP_TAGS}
                  fit={fit}
                  noAuto
                  value={model}
                  onChange={(id) => {
                    setPicked(true);
                    setModel(id);
                  }}
                />
              ) : (
                <ModelPicker kind="video" task={t.kind === "effect" ? "animate" : "video"} featured={featured.length ? featured : undefined} value={model} onChange={setModel} />
              )}
              {tooMany ? (
                <p className="mt-2 flex items-start gap-2 text-[12.5px] leading-relaxed text-tungsten">
                  <TriangleAlert size={14} className="mt-0.5 shrink-0" /> This model takes {room} picture{room === 1 ? "" : "s"}; this template needs {filled.length}. Pick another one.
                </p>
              ) : null}
            </Section>

            {resChoices.length > 1 || (ticks && ticks.seconds.length > 1) ? (
              <Section title="Settings">
                <div className="flex flex-wrap items-center gap-2">
                  {ticks && ticks.seconds.length > 1 ? (
                    <DurationRuler className="min-w-[200px] flex-1" value={lengthValue} allowed={ticks.seconds} max={ticks.max} auto={ticks.auto} onChange={setDuration} />
                  ) : null}
                  {resChoices.length > 1 ? (
                    <Segmented value={String(resValue)} onChange={(v) => setResolution(v)} options={resChoices.map((c) => ({ id: String(c.value), label: resolutionLabel(c.value) }))} />
                  ) : null}
                </div>
              </Section>
            ) : null}

            {swap ? (
              <Section title="Anything else" hint="Optional">
                <input
                  value={extra}
                  onChange={(e) => setExtra(e.target.value.slice(0, 300))}
                  placeholder="Make the jersey red · add sunglasses"
                  className="field-focus block h-10 w-full rounded-[12px] bg-white/[0.04] px-3 text-[13.5px] text-paper outline-none placeholder:text-haze"
                />
              </Section>
            ) : null}

            <PromptBox prompt={prompt} edited={override !== null} open={showPrompt} setOpen={setShowPrompt} onEdit={setOverride} />

            {people ? (
              <label className="flex cursor-pointer items-start gap-2.5 text-[12.5px] leading-relaxed text-fog">
                <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-[3px] size-4 shrink-0 accent-[var(--color-spike)]" />
                <span>Everyone in these photos is an adult and agreed to be put in this clip.</span>
              </label>
            ) : null}
          </div>

          <div className="mt-auto space-y-2 border-t border-line p-4">
            {error ? (
              <p className="flex items-start gap-1.5 text-[12.5px] leading-relaxed text-tally">
                <TriangleAlert size={14} className="mt-0.5 shrink-0" /> {error}
              </p>
            ) : null}
            {shownTake?.status === "error" && !error ? (
              <p className="flex items-start gap-1.5 text-[12.5px] leading-relaxed text-tally">
                <TriangleAlert size={14} className="mt-0.5 shrink-0" />
                <span>
                  {shownTake.error} {shownTake.stage ? <span className="text-paper">{shownTake.stage}</span> : null}
                </span>
              </p>
            ) : null}
            {/* The live demo: what a swap on its own GPU holds (a cloud model on your own key says so in its cost line). */}
            {DEMO && LOCAL_SWAP_IDS.includes(model) ? (
              <p className="flex items-center gap-1.5 px-1 text-[12px] text-haze" title={DEMO_CREDITS_HINT}>
                <Coins size={13} className="shrink-0" />
                About <span className="tabular font-semibold text-paper">{demoSwapCredits()}</span> credits for this remix
              </p>
            ) : null}
            <CostLine
              modelId={effective ?? null}
              noun="this remix"
              input={{ output: "video", seconds: Math.max(1, Math.round(seconds)), resolution: resValue, count: 1 }}
              quote={{ output: "video", seconds: Math.max(1, Math.round(seconds)), resolution: resValue !== null ? String(resValue) : null, aspect: t.aspect, count: 1, images: takesPictures ? filled.length : 0 }}
            />
            <button
              onClick={() => void make()}
              disabled={!ready}
              className="lip press flex h-12 w-full items-center justify-center gap-2 rounded-full bg-spike text-[14px] font-bold uppercase tracking-[0.05em] text-spike-ink [--lip:var(--color-spike-lip)] hover:bg-spike-hi disabled:cursor-not-allowed disabled:bg-white/[0.06] disabled:text-haze disabled:shadow-none"
            >
              {busy || reading ? <LoaderCircle size={17} className="animate-spin" /> : <Wand2 size={16} />}
              {missing.length
                ? `Add ${missing[0].label.toLowerCase() === "you" ? "your photo" : missing[0].label.toLowerCase()}`
                : reading
                  ? "Reading your photo…"
                  : swap && useOwn && !own
                    ? "Add your clip"
                    : unpicked.length
                      ? `Click who becomes ${slots[unpicked[0].id]?.cast?.name ?? unpicked[0].label.toLowerCase()}`
                      : people && !consent
                        ? "Confirm the photos are OK to use"
                        : "Make it"}
            </button>
            <p className="px-1 text-[11.5px] leading-relaxed text-haze">
              {!swap
                ? t.kind === "effect"
                  ? "Your photo is the clip's first frame; the template writes the transformation."
                  : "The template writes the shot from your answers."
                : takesPictures
                  ? "Your photos go to the model as references, bound to who they replace; the motion, camera and sound stay."
                  : "Grok's clip editor takes words only, so Crackio describes your photo in detail. For the closest likeness, pick a model that takes your photo."}
            </p>
          </div>
        </Panel>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ stage */

function Stage({
  t,
  take,
  own,
  takes,
  onView,
}: {
  t: Template;
  take: Generation | null;
  own: Clip | null;
  takes: Generation[];
  onView: (id: string) => void;
}) {
  const [tab, setTab] = useState<"yours" | "original">("yours");
  const before = useRef<HTMLVideoElement>(null);
  const after = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const result = take?.outputs[0];
  const shown = t.poster ? { poster: t.poster, clip: t.clip } : null;
  const original = own?.url ?? t.base?.url ?? t.clip;
  const poster = own ? undefined : shown?.poster;
  const showing = tab === "original" || !take ? "original" : "yours";
  const ratio = result?.width && result?.height ? result.width / result.height : 9 / 16;
  const liveTake = take && (take.status === "queued" || take.status === "running");

  const both = () => {
    const vids = [before.current, after.current].filter((v): v is HTMLVideoElement => Boolean(v));
    if (playing) vids.forEach((v) => v.pause());
    else {
      vids.forEach((v) => (v.currentTime = 0));
      void Promise.all(vids.map((v) => v.play().catch(() => {})));
    }
    setPlaying(!playing);
  };

  return (
    <section className="min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Segmented
          value={showing}
          onChange={setTab}
          options={[
            { id: "yours", label: "Yours", disabled: !take },
            { id: "original", label: t.kind === "swap" ? (own ? "Your clip" : "Original") : "Example" },
          ]}
        />
        {result && t.kind === "swap" ? (
          <button type="button" onClick={both} className="press inline-flex h-8 items-center gap-1.5 rounded-full bg-white/[0.06] px-3 text-[12.5px] font-semibold text-fog hover:text-paper">
            {playing ? <Pause size={13} /> : <Play size={13} />} {playing ? "Pause" : "Side by side"}
          </button>
        ) : null}
      </div>

      <div className={cn("mt-3 grid gap-3", playing && result ? "sm:grid-cols-2" : "")}>
        {((playing && result) || showing === "original") && !original ? (
          <div className="mx-auto grid w-full max-w-[460px] place-items-center rounded-[18px] p-8 text-center shadow-[inset_0_0_0_1.5px_var(--color-line-strong)]" style={{ aspectRatio: 9 / 16 }}>
            <p className="max-w-[26ch] text-[13.5px] leading-relaxed text-fog">Drop the trend&rsquo;s clip on the right, then click who to replace.</p>
          </div>
        ) : (playing && result) || showing === "original" ? (
          <div className="mx-auto w-full max-w-[460px] overflow-hidden rounded-[18px] bg-black" style={{ aspectRatio: 9 / 16 }}>
            <video ref={before} key={original} src={`${original}#t=0.1`} poster={poster} className="size-full object-contain" playsInline loop muted={playing} controls={!playing} preload="metadata" />
          </div>
        ) : null}
        {showing === "yours" && take ? (
          <div className="relative mx-auto w-full max-w-[460px] overflow-hidden rounded-[18px] bg-black" style={{ aspectRatio: ratio }}>
            {result ? <video ref={after} key={result.url} src={`${result.url}#t=0.1`} className="size-full object-contain" playsInline loop controls={!playing} preload="auto" /> : null}
            {liveTake ? (
              <GeneratingField
                stage={take.stage}
                progress={take.progress}
                prompt={take.prompt}
                since={take.createdAt}
                backdrop={shown?.poster}
                onCancel={() => void useGenerationsStore.getState().cancel(take.id)}
              />
            ) : null}
            {take.status === "error" ? <div className="absolute inset-0 grid place-items-center p-6 text-center text-[13px] leading-relaxed text-tally">{take.error}</div> : null}
          </div>
        ) : null}
      </div>

      {takes.length ? (
        <div className="mt-4">
          <h2 className="label mb-2">Your remixes</h2>
          <div className="scrollbar-none flex gap-2 overflow-x-auto pb-1">
            {takes.map((g) => (
              <button
                key={g.id}
                type="button"
                onClick={() => {
                  onView(g.id);
                  setTab("yours");
                }}
                className={cn("relative aspect-[9/16] w-20 shrink-0 overflow-hidden rounded-[10px] bg-apple", g.id === take?.id ? "shadow-[0_0_0_2px_var(--color-spike)]" : "shadow-[0_0_0_1px_var(--color-line)]")}
                title={g.status === "error" ? g.error : g.prompt}
              >
                {g.outputs[0] ? <Media media={g.outputs[0]} slot="chip" className="size-full object-cover" /> : null}
                {g.status === "queued" || g.status === "running" ? <GeneratingField bare progress={g.progress} /> : null}
                {g.status === "error" ? (
                  <span className="absolute inset-0 grid place-items-center text-tally">
                    <TriangleAlert size={15} />
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------------ slots */

function SlotCard({
  slot,
  state,
  onPhoto,
  onCast,
  onClear,
  onChange,
}: {
  slot: TemplateSlot;
  state: SlotState;
  onPhoto: (file: File) => void;
  onCast: (c: { id: string; name: string; photo: string }) => void;
  onClear: () => void;
  onChange: (p: Partial<SlotState>) => void;
}) {
  const { items: cast } = useCast();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [editing, setEditing] = useState(false);
  const people = slot.kind === "person" || slot.kind === "face";
  // People and characters first for a person's slot: objects can play one too, but they're rarely who you meant.
  const ready = cast
    .filter((c) => c.status === "ready" && (c.portrait || c.photos[0]) && (people ? c.kind !== "pet" : slot.kind === "pet" ? c.kind === "pet" : false))
    .sort((a, b) => Number(a.kind === "object") - Number(b.kind === "object"));
  const has = Boolean(state.photo || state.cast);

  return (
    <Section title={slot.label} hint={slot.optional ? "Optional" : slot.hint}>
      {has ? (
        <div className="rounded-[14px] bg-white/[0.03] p-2 shadow-[inset_0_0_0_1px_var(--color-line)]">
          <div className="flex items-start gap-3">
            <span className="relative h-[84px] w-[68px] shrink-0 overflow-hidden rounded-[10px] bg-black">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={state.photo?.url} alt="" className="size-full object-cover" />
            </span>
            <div className="min-w-0 flex-1 py-0.5">
              <div className="flex items-start justify-between gap-2">
                <p className="truncate text-[13px] font-semibold text-paper">{state.cast?.name ?? (state.noun ? state.noun.charAt(0).toUpperCase() + state.noun.slice(1) : "Your photo")}</p>
                <button type="button" onClick={onClear} className="grid size-6 shrink-0 place-items-center rounded-full text-haze hover:bg-white/[0.06] hover:text-paper" aria-label={`Remove ${slot.label}`}>
                  <X size={13} />
                </button>
              </div>
              {state.reading ? (
                <p className="mt-1 flex items-center gap-1.5 text-[12px] text-haze">
                  <LoaderCircle size={12} className="animate-spin" /> Reading the photo…
                </p>
              ) : state.error ? (
                <p className="mt-1 text-[12px] leading-snug text-tungsten">{state.error}</p>
              ) : (
                <button type="button" onClick={() => setEditing((e) => !e)} className="mt-1 line-clamp-2 text-left text-[12px] leading-snug text-fog hover:text-paper" title="What the model is told about them">
                  {state.look || "Describe them"} <ChevronDown size={11} className={cn("inline transition-transform", editing && "rotate-180")} />
                </button>
              )}
              {slot.kind === "person" && slot.outfit ? (
                <Segmented
                  className="mt-2"
                  value={state.outfit ?? slot.outfit.default}
                  onChange={(v) => onChange({ outfit: v })}
                  options={[
                    { id: "trend", label: "Trend outfit", title: slot.outfit.trend },
                    { id: "own", label: "Own clothes", title: state.wearing || "What they wear in the photo" },
                  ]}
                />
              ) : null}
            </div>
          </div>
          {editing && !state.reading ? (
            <div className="mt-2 space-y-2">
              <label className="block">
                <span className="label mb-1 block">{people ? "Who they are" : "What it looks like"}</span>
                <textarea
                  value={state.look}
                  onChange={(e) => onChange({ look: e.target.value })}
                  rows={4}
                  className="field-focus block w-full resize-none rounded-[10px] bg-white/[0.04] px-2.5 py-2 text-[12.5px] leading-relaxed text-paper outline-none"
                />
              </label>
              {slot.kind === "person" ? (
                <label className="block">
                  <span className="label mb-1 block">What they wear in the photo</span>
                  <textarea
                    value={state.wearing}
                    onChange={(e) => onChange({ wearing: e.target.value })}
                    rows={2}
                    className="field-focus block w-full resize-none rounded-[10px] bg-white/[0.04] px-2.5 py-2 text-[12.5px] leading-relaxed text-paper outline-none"
                  />
                </label>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="space-y-2">
          <button
            type="button"
            onClick={() => input.current?.click()}
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes("Files")) return;
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(false);
              const f = e.dataTransfer.files[0];
              if (f) onPhoto(f);
            }}
            className={cn(
              "press flex h-24 w-full items-center gap-3 rounded-[14px] bg-white/[0.03] px-4 text-left text-fog shadow-[inset_0_0_0_1px_var(--color-line-strong)] hover:bg-white/[0.05] hover:text-paper",
              over && "shadow-[inset_0_0_0_2px_var(--color-spike)]",
            )}
          >
            <span className="grid size-10 shrink-0 place-items-center rounded-full bg-white/[0.06]">
              <ImagePlus size={17} />
            </span>
            <span>
              <span className="block text-[13.5px] font-semibold text-paper">{people ? "Add a photo" : slot.kind === "pet" ? "Add a photo of your pet" : slot.kind === "object" ? "Add a product photo" : "Add a photo of the place"}</span>
              <span className="mt-0.5 block text-[12px] leading-snug text-haze">{slot.hint}</span>
            </span>
          </button>
          {ready.length ? (
            <div className="flex items-center gap-2">
              <span className="text-[11.5px] text-haze">Or from your Cast:</span>
              <div className="scrollbar-none flex gap-1.5 overflow-x-auto">
                {ready.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => onCast({ id: c.id, name: c.name, photo: (c.portrait ?? c.photos[0])! })}
                    title={`${c.name} (@${c.handle})`}
                    className="press inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-white/[0.05] pl-0.5 pr-2.5 text-[12px] font-semibold text-fog hover:text-paper"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={c.portrait ?? c.photos[0]} alt="" className="size-7 rounded-full object-cover" />
                    {c.name}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          <input
            ref={input}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onPhoto(f);
              e.target.value = "";
            }}
          />
        </div>
      )}
    </Section>
  );
}

/* ------------------------------------------------------------------ your clip */

function OwnClip({
  t,
  own,
  start,
  span,
  frame,
  slots,
  onPick,
  onClear,
  onStart,
  onRescan,
  onTarget,
  onTargetText,
  hint,
}: {
  t: Template;
  own: Clip | null;
  start: number;
  span: number;
  frame: Pic | null;
  slots: Record<string, SlotState>;
  onPick: (file?: File) => void;
  onClear: () => void;
  onStart: (v: number) => void;
  onRescan: (at: number) => void;
  onTarget: (slotId: string, t: Thing, at: [number, number]) => void;
  onTargetText: (slotId: string, text: string) => void;
  hint?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState(t.slots[0]?.id ?? "");
  const long = own ? own.duration > span + 0.2 : false;

  if (!own) {
    return (
      <>
        <button
          type="button"
          onClick={() => input.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={async (e) => {
            e.preventDefault();
            setBusy(true);
            await onPick(e.dataTransfer.files[0]);
            setBusy(false);
          }}
          className="press flex h-28 w-full flex-col items-center justify-center gap-1.5 rounded-[14px] bg-white/[0.03] text-fog shadow-[inset_0_0_0_1px_var(--color-line-strong)] hover:bg-white/[0.05] hover:text-paper"
        >
          {busy ? <LoaderCircle size={18} className="animate-spin" /> : <Upload size={18} />}
          <span className="text-[13px] font-semibold">Drop the trend&rsquo;s clip or browse</span>
          <span className="text-[11.5px] text-haze">MP4, MOV or WebM · up to {span} s is used</span>
        </button>
        <input
          ref={input}
          type="file"
          accept="video/*"
          hidden
          onChange={async (e) => {
            setBusy(true);
            await onPick(e.target.files?.[0]);
            setBusy(false);
            e.target.value = "";
          }}
        />
      </>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2 rounded-[12px] bg-white/[0.04] px-3 py-2 text-[12.5px] text-fog">
        <span className="inline-flex min-w-0 items-center gap-2">
          <Film size={14} className="shrink-0" /> <span className="truncate">{own.name}</span>
        </span>
        <button type="button" onClick={onClear} className="text-haze hover:text-paper" aria-label="Remove the clip">
          <X size={14} />
        </button>
      </div>
      {long ? (
        <Slider label="Use from" value={start} min={0} max={Math.max(0.1, own.duration - span)} step={0.1} onChange={onStart} format={(v) => `${v.toFixed(1)}–${Math.min(own.duration, v + span).toFixed(1)} s`} />
      ) : null}
      {t.slots.length > 1 ? (
        <Segmented value={active} onChange={setActive} options={t.slots.map((s) => ({ id: s.id, label: `Pick: ${s.label}` }))} />
      ) : null}
      {frame ? (
        <TargetPicker key={frame.url} frame={frame} picked={slots[active]?.picked ?? null} hint={hint} outline={Boolean(hint)} onPick={(thing, at) => onTarget(active, thing, at)} />
      ) : (
        <div className="skeleton aspect-video w-full rounded-[14px]" />
      )}
      {long ? (
        <button type="button" onClick={() => onRescan(start)} className="press inline-flex h-7 items-center gap-1.5 rounded-full bg-white/[0.05] px-2.5 text-[11.5px] font-semibold text-fog hover:text-paper">
          <RotateCcw size={12} /> Show the frame at {start.toFixed(1)} s
        </button>
      ) : null}
      <label className="block">
        <span className="label mb-1 block">Who {t.slots.find((s) => s.id === active)?.label === "You" ? "you replace" : "gets replaced"}</span>
        <input
          value={slots[active]?.target ?? ""}
          onChange={(e) => onTargetText(active, e.target.value)}
          placeholder="the woman in the red jacket on the left"
          className="field-focus block h-10 w-full rounded-[12px] bg-white/[0.04] px-3 text-[13px] text-paper outline-none placeholder:text-haze"
        />
      </label>
    </div>
  );
}

/* ------------------------------------------------------------------ prompt */

function PromptBox({ prompt, edited, open, setOpen, onEdit }: { prompt: string; edited: boolean; open: boolean; setOpen: (v: boolean) => void; onEdit: (v: string | null) => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <section className="rounded-[14px] bg-white/[0.025] shadow-[inset_0_0_0_1px_var(--color-line)]">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left">
        <span className="flex items-center gap-2 text-[12.5px] font-semibold text-paper">
          <Sparkles size={13} className="text-spike" /> The exact prompt {edited ? <span className="font-normal text-tungsten">· edited</span> : null}
        </span>
        <ChevronDown size={14} className={cn("text-haze transition-transform", open && "rotate-180")} />
      </button>
      {open ? (
        <div className="px-3 pb-3">
          <textarea
            value={prompt}
            onChange={(e) => onEdit(e.target.value)}
            rows={10}
            spellCheck={false}
            className="field-focus block w-full resize-y rounded-[10px] bg-black/30 px-2.5 py-2 font-mono text-[11.5px] leading-relaxed text-fog outline-none"
          />
          <div className="mt-1.5 flex items-center gap-3 text-[11.5px]">
            <button
              type="button"
              onClick={async () => {
                if (await copyText(prompt)) {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1200);
                }
              }}
              className="inline-flex items-center gap-1 font-semibold text-fog hover:text-paper"
            >
              <Copy size={11} /> {copied ? "Copied" : "Copy"}
            </button>
            {edited ? (
              <button type="button" onClick={() => onEdit(null)} className="inline-flex items-center gap-1 font-semibold text-fog hover:text-paper">
                <RotateCcw size={11} /> Back to the template&rsquo;s words
              </button>
            ) : (
              <span className="text-haze">
                {prompt.includes("{script}") ? "{script} becomes the beats and voiceover a text model writes from your answers." : "Edit it if you like; it updates as you add photos."}
              </span>
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}

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
