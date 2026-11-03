"use client";

import Link from "next/link";
import { useDeferredValue, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { ArrowUpRight, AudioLines, Cpu, Download, LoaderCircle, Pause, Play, Search, Sparkles, TriangleAlert, X } from "lucide-react";
import { Banner, CardGrid, Empty, LibraryCard, LibraryDrawer, Section, TabButton, useLibraryClose, useTouch, type Card, type Tab, type TabItem } from "@/components/models/ModelLibrary";
import { ScrollRow } from "@/components/ui/ScrollRow";
import { useNow } from "@/lib/hooks/use-now";
import { useVoiceStore } from "@/lib/hooks/use-voice";
import { HEARING, VOICE_MODELS, gbOf, variantFor, type VoiceModel, type VoiceModelId } from "@/lib/voice/models";
import type { VoiceMachine } from "@/lib/voice/types";
import { Sky } from "./Orb";
import { usePlayer } from "./player";
import { cn } from "@/lib/cn";

/**
 * Voice's models in the model library everyone knows (components/models/ModelLibrary): the same sheet, tabs and cards.
 * A card's art is the model's sky with a take it made: play it to hear it. Tabs are where they run: everything ready,
 * then each of your GPUs with what's on it and what fits; Get models puts one on the GPU you pick, audio.cpp and speech
 * to text with the first.
 */
export function VoiceModelLibrary({
  open,
  onClose,
  anchor,
  value,
  onChange,
  glass,
}: {
  open: boolean;
  onClose: () => void;
  anchor: HTMLElement | null;
  value: VoiceModelId;
  onChange: (id: VoiceModelId) => void;
  glass?: boolean;
}) {
  // Your machines, fresh once it has slid in (and every few seconds while something downloads: useVoiceSetup).
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => void useVoiceStore.getState().loadMachines(true), 700);
    return () => clearTimeout(t);
  }, [open]);
  return (
    <LibraryDrawer open={open} onClose={onClose} anchor={anchor} glass={glass} label="Choose a voice model">
      <VoiceModels value={value} onChange={onChange} />
    </LibraryDrawer>
  );
}

/**
 * A voice model's mark: the same plain sound mark for every one, its maker named in text beside it (no makers' logos:
 * Drama 3's licence allows Fish Audio's name but forbids its logo, and Crackio carries no other brands either).
 */
export function VoiceModelMark({ model, size = 20, variant = "tile" }: { model: VoiceModel; size?: number; variant?: "tile" | "bare" }) {
  const radius = Math.round(size * 0.28);
  if (model.card.logo) {
    return (
      // A small logo; a plain img keeps it crisp and cheap.
      // eslint-disable-next-line @next/next/no-img-element
      <img src={model.card.logo} alt="" aria-hidden="true" draggable={false} className="squircle shrink-0 object-cover shadow-[0_0_0_1px_rgb(255_255_255/0.1)]" style={{ width: size, height: size, borderRadius: radius }} />
    );
  }
  const glyph = <AudioLines size={Math.round(size * (variant === "bare" ? 0.9 : 0.52))} strokeWidth={2.3} />;
  return variant === "bare" ? (
    <span className="inline-grid shrink-0 place-items-center text-paper" style={{ width: size, height: size }} aria-hidden="true">
      {glyph}
    </span>
  ) : (
    <span className="squircle inline-grid shrink-0 place-items-center bg-paper text-[#16131b] shadow-[0_0_0_1px_rgb(255_255_255/0.1)]" style={{ width: size, height: size, borderRadius: radius }} aria-hidden="true">
      {glyph}
    </span>
  );
}

const LICENCE = { yes: "Commercial OK", limited: "Commercial, with limits", no: "Non-commercial" } as const;

type Where = { machine: VoiceMachine; fit: NonNullable<ReturnType<typeof variantFor>> };

/** Where a model is, is coming, or would fit. */
function placesOf(model: VoiceModel, machines: VoiceMachine[]) {
  const usable = machines.filter((m) => m.online && m.voiceReady);
  // Ready means the model AND audio.cpp are there; a file without the engine still needs its one-click setup.
  const on = usable.filter((m) => m.engine && m.models.includes(model.id));
  const coming = usable.filter((m) => !m.models.includes(model.id) && m.downloads.some((d) => model.variants.some((v) => v.file.name === d.file)));
  const fits: Where[] = usable
    .filter((m) => !on.includes(m))
    .map((m) => ({ machine: m, fit: variantFor(model, m.gpuGb, m.ramGb, m.unified) }))
    .filter((x): x is Where => Boolean(x.fit))
    .sort((a, b) => Number(a.fit.offload) - Number(b.fit.offload) || Number(b.machine.runOn) - Number(a.machine.runOn) || (b.machine.gpuGb ?? 0) - (a.machine.gpuGb ?? 0));
  return { on, coming, fits };
}

const gpuName = (m: VoiceMachine) => m.gpu ?? m.label;

function VoiceModels({ value, onChange }: { value: VoiceModelId; onChange: (id: VoiceModelId) => void }) {
  const onClose = useLibraryClose();
  const all = useVoiceStore((s) => s.machines);
  const loaded = useVoiceStore((s) => s.machinesLoaded);
  const machines = useMemo(() => all.filter((m) => m.online && m.voiceReady), [all]);
  const now = useNow();
  const touch = useTouch();
  const tabsId = useId();
  const [tab, setTab] = useState<Tab>("all");
  const [getOn, setGetOn] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const search = useDeferredValue(query.trim().toLowerCase());

  const card = (model: VoiceModel, here?: VoiceMachine): Card => {
    const { on, coming, fits } = placesOf(model, machines);
    const where = here ? (on.includes(here) ? here : null) : (on.find((m) => m.runOn) ?? on[0] ?? null);
    const target = here ? (fits.find((f) => f.machine.id === here.id) ?? null) : (fits[0] ?? null);
    const comingHere = here ? coming.find((m) => m.id === here.id) : coming[0];
    const v = target?.fit.variant ?? model.variants[0];
    return {
      key: `${here?.id ?? "any"}:${model.id}`,
      id: model.id,
      name: model.name,
      maker: model.maker,
      preview: { node: <VoiceModelArt model={model} /> },
      extra: <HearButton model={model} />,
      home: "local",
      badge: where
        ? { text: gpuName(where) }
        : comingHere
          ? { text: "Downloading", tone: "ok" }
          : target
            ? target.fit.offload
              ? { text: "Runs, part in RAM", tone: "slow" }
              : { text: "Runs great", tone: "good" }
            : { text: here ? "Too big here" : "Needs a bigger GPU", tone: "no" },
      blurb: model.blurb,
      quality: model.card.score,
      rank: model.card.rank,
      says: model.card.says,
      released: model.card.released,
      facts: [model.licence.commercial ? LICENCE[model.licence.commercial] : "", `${v.label} · ${gbOf(v.file.bytes)}`, `${model.languages.split(",")[0]} languages`].filter(Boolean),
      ready: Boolean(where),
      reason: where ? undefined : target || comingHere ? "Not on this GPU yet" : here ? `Too big for ${gpuName(here)}` : "None of your GPUs has room for it",
      // Not on a GPU yet: getting it, with Hear it beside (the details row Use sits in is for models that are there).
      actions: where ? undefined : (
        <div className="flex items-center gap-1.5">
          <div className="min-w-0 flex-1">{comingHere ? <Getting model={model} machine={comingHere} /> : target ? <GetIt model={model} spot={target} /> : null}</div>
          <HearButton model={model} />
        </div>
      ),
    };
  };

  const matches = (c: Card) => !search || `${c.name} ${c.maker} ${c.blurb} ${c.says ?? ""} ${c.facts.join(" ")}`.toLowerCase().includes(search);
  const pick = (c: Card) => {
    if (!c.id || !c.ready) return;
    onChange(c.id as VoiceModelId);
    onClose();
  };
  const grid = (items: Card[]) =>
    items.filter(matches).length ? (
      <CardGrid>
        {items.filter(matches).map((c) => (
          <LibraryCard key={c.key} card={c} selected={c.id === value && c.ready} now={now} touch={touch} onPick={() => pick(c)} onUseInstalled={() => pick(c)} />
        ))}
      </CardGrid>
    ) : null;

  const everywhere = VOICE_MODELS.map((m) => card(m));
  const ready = everywhere.filter((c) => c.ready);
  const toGet = everywhere.filter((c) => !c.ready);
  const getGpu = machines.find((m) => m.id === getOn) ?? machines.find((m) => m.runOn) ?? [...machines].sort((a, b) => (b.gpuGb ?? 0) - (a.gpuGb ?? 0))[0] ?? null;

  let body: ReactNode;
  if (!loaded) {
    body = (
      <CardGrid>
        {[0, 1, 2].map((i) => (
          <div key={i} className="squircle aspect-[4/5] rounded-[18px] bg-white/[0.035]" />
        ))}
      </CardGrid>
    );
  } else if (tab === "all") {
    body = (
      <>
        <Section title="On your GPUs" items={ready} search={search} render={grid} />
        {!ready.length && !search ? <Empty title="No voice model on your GPUs yet" body="Get one below: it's free, it stays, and audio.cpp and speech to text come with the first." /> : null}
        <Section title={ready.length ? "Get more" : "Get one"} hint="Free, on your own GPU" items={toGet} search={search} render={grid} />
      </>
    );
  } else if (tab.startsWith("gpu:")) {
    const m = machines.find((x) => `gpu:${x.id}` === tab);
    if (!m) body = null;
    else {
      const cards = VOICE_MODELS.map((model) => card(model, m));
      const here = cards.filter((c) => c.ready);
      const fit = cards.filter((c) => !c.ready && c.badge?.tone !== "no");
      const big = cards.filter((c) => !c.ready && c.badge?.tone === "no");
      body = (
        <>
          <MachineLine m={m} />
          <Section title={`Installed on ${gpuName(m)}`} hint="Voice jobs go to the GPU that has the model" items={here} search={search} render={grid} />
          {!here.length && !search ? <Empty title={`No voice model on ${gpuName(m)} yet`} body="These run on it. Get one: it's free, and it stays." /> : null}
          <Section title={`Runs on ${gpuName(m)}`} items={fit} search={search} render={grid} />
          <Section title="Too big here" items={big} search={search} render={grid} />
        </>
      );
    }
  } else {
    // Get models: every model not yet on the GPU you pick.
    const cards = getGpu ? VOICE_MODELS.filter((model) => !getGpu.models.includes(model.id)).map((model) => card(model, getGpu)) : [];
    body = (
      <>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="flex items-center gap-2">
            <span className="text-[12.5px] text-haze">Install on</span>
            {machines.length ? (
              <div role="radiogroup" aria-label="Install on" className="flex rounded-[12px] bg-white/[0.05] p-[3px]">
                {machines.map((m) => {
                  const on = m.id === getGpu?.id;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      onClick={() => setGetOn(m.id)}
                      className={cn(
                        "press squircle h-8 rounded-[9px] px-3 text-[12.5px] font-semibold",
                        on ? "bg-white/[0.13] text-paper shadow-[inset_0_1px_0_rgb(255_255_255/0.08),0_1px_2px_rgb(0_0_0/0.25)]" : "text-fog hover:text-paper",
                      )}
                    >
                      {gpuName(m)}
                      <span className="ml-1.5 font-medium text-haze">{m.label === gpuName(m) ? "" : m.label.replace(/^RTX \d+ · /, "")}</span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <span className="text-[12.5px] text-fog">a computer with ComfyUI</span>
            )}
          </div>
        </div>
        {!machines.length ? (
          <Banner icon={<Cpu size={16} />} action={<GhostLinkOut href="/settings/machines?add=1">Set up ComfyUI</GhostLinkOut>}>
            Voice models run in ComfyUI through the Crackio bridge. Crackio installs it for you in Settings → Machines.
          </Banner>
        ) : null}
        {grid(cards) ?? <Empty title={search ? `Nothing to get matches “${query.trim()}”` : `Every voice model is on ${getGpu ? gpuName(getGpu) : "it"}`} body="Pick another GPU above, or use what's there." />}
      </>
    );
  }

  const tabs: TabItem[] = [
    { id: "all", label: "All voice models", caption: `${ready.length} ready`, icon: <Sparkles size={15} /> },
    ...machines.map(
      (m): TabItem => ({
        id: `gpu:${m.id}`,
        label: gpuName(m),
        caption: [m.gpuGb ? `${Math.round(m.gpuGb)} GB` : null, m.label === gpuName(m) ? null : m.label.replace(/^RTX \d+ · /, "")].filter(Boolean).join(" · ") || m.label,
        count: m.models.length,
        icon: <Cpu size={15} />,
        dot: "on",
      }),
    ),
  ];

  return (
    <div data-sheet tabIndex={-1} className="@container flex h-full min-h-0 flex-col outline-none">
      <header className="shrink-0 px-4 pt-4 sm:px-6 sm:pt-6">
        <div className="flex items-center gap-2.5">
          <div className="min-w-0 flex-1">
            <h2 className="truncate font-display text-[22px] leading-[1.2] sm:text-[24px]">{tab === "get" ? "Get voice models" : "Voice models"}</h2>
            <p className="mt-0.5 truncate text-[12.5px] text-haze">
              {tab === "get" ? "Open models in the version that fits your GPU, set up in one click" : touch ? "Tap a card for what it's like, ▶ to hear it" : "Hover a card for what it's like, ▶ to hear it"}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setTab(tab === "get" ? "all" : "get")}
            aria-pressed={tab === "get"}
            className={cn(
              "press inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-bold outline-none focus-visible:outline-none",
              tab === "get" ? "bg-spike text-spike-ink focus-visible:bg-spike-hi" : "bg-spike/[0.13] text-spike hover:bg-spike/[0.2] focus-visible:bg-spike/[0.24]",
            )}
          >
            <Download size={15} strokeWidth={2.4} />
            <span className="hidden @min-[440px]:inline @min-[640px]:hidden @min-[760px]:inline">Get models</span>
          </button>
          <label className="field-focus hidden h-10 w-[min(260px,30vw)] items-center gap-2 rounded-full bg-white/[0.06] px-3.5 sm:flex">
            <Search size={15} className="shrink-0 text-haze" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search voice models"
              aria-label="Search voice models"
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
        <div className="relative mt-3.5">
          <ScrollRow trackClassName="gap-1">
            {tabs.map((t) => (
              <TabButton key={t.id} item={t} on={tab === t.id} layout={tabsId} onClick={() => setTab(t.id)} />
            ))}
          </ScrollRow>
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-line" />
        </div>
      </header>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-6 pt-4 sm:px-6">
        <div className="space-y-5">{body}</div>
        <footer className="mt-8 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3 text-[12px] leading-relaxed text-haze">
          <span className="max-w-[56ch]">Every voice model runs on your own GPU through the Crackio bridge&rsquo;s Voice node and audio.cpp (Apache-2.0). Nothing is uploaded.</span>
          <Link href="/settings/tools?tool=voice" onClick={onClose} className="inline-flex items-center gap-1 text-[12.5px] font-semibold text-haze hover:text-paper">
            Machines and installs <ArrowUpRight size={13} />
          </Link>
        </footer>
      </div>
    </div>
  );
}

/**
 * A model's card art: its sky, its maker's logo up top, and the take it made laid into the picture right above its
 * name (its waveform lights up as it plays). The card's details cover it on hover, where "Hear it" plays it.
 */
function VoiceModelArt({ model }: { model: VoiceModel }) {
  const key = `model:${model.id}`;
  const playing = usePlayer((s) => s.key === key && s.playing);
  const share = usePlayer((s) => (s.key === key && s.duration ? s.time / s.duration : 0));
  const peaks = model.card.peaks;
  return (
    <div className="absolute inset-0">
      <Sky hues={model.card.hues} />
      <span className="absolute left-1/2 top-[25%] -translate-x-1/2 -translate-y-1/2 drop-shadow-[0_8px_22px_rgb(0_0_0/0.35)]">
        <VoiceModelMark model={model} size={54} />
      </span>
      <div aria-hidden="true" className="absolute inset-x-3 bottom-[66px] flex h-9 items-center gap-2">
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-paper text-[#16131b] shadow-[0_6px_18px_rgb(0_0_0/0.3)]">
          {playing ? <Pause size={14} fill="currentColor" strokeWidth={0} /> : <Play size={14} fill="currentColor" strokeWidth={0} className="translate-x-px" />}
        </span>
        <svg viewBox={`0 0 ${peaks.length * 3} 40`} preserveAspectRatio="none" className="h-9 min-w-0 flex-1 rounded-full bg-[#0d0c11]/45 px-2.5 py-1.5 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)]">
          {peaks.map((p, i) => {
            const h = Math.max(2, p * 36);
            return <rect key={i} x={i * 3} y={20 - h / 2} width={1.8} height={h} rx={0.9} fill={i / peaks.length < share ? "#ffffff" : "rgb(255 255 255 / 0.5)"} />;
          })}
        </svg>
      </div>
    </div>
  );
}

/** "Hear it", beside Use in a card's details: plays the take its art shows. */
function HearButton({ model }: { model: VoiceModel }) {
  const key = `model:${model.id}`;
  const playing = usePlayer((s) => s.key === key && s.playing);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        usePlayer.getState().toggle(key, model.card.sample);
      }}
      title={playing ? "Pause" : "Hear it"}
      aria-label={playing ? `Pause ${model.name}'s sample` : `Hear ${model.name}`}
      className="press pointer-events-auto grid size-8 shrink-0 place-items-center rounded-full bg-white/[0.12] text-paper hover:bg-white/[0.2]"
    >
      {playing ? <Pause size={13} fill="currentColor" strokeWidth={0} /> : <Play size={13} fill="currentColor" strokeWidth={0} className="translate-x-px" />}
    </button>
  );
}

/** "Get it on RTX 5090 · 27 GB": the model, audio.cpp and speech to text if the machine lacks them. */
function GetIt({ model, spot }: { model: VoiceModel; spot: Where }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const m = spot.machine;
  // What it still lacks there: the model file (unless it's there already) and speech to text; audio.cpp comes with it.
  const has = m.files.includes(spot.fit.variant.file.name);
  const bytes = (has ? 0 : spot.fit.variant.file.bytes) + (m.hearing ? 0 : HEARING.reduce((s, f) => s + f.bytes, 0));
  const room = m.diskGb == null || m.diskGb > bytes / 1e9 + (m.engine ? 1 : 4);
  const get = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/voice/install", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: model.id, machine: m.id }) });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Couldn't start it.");
      await useVoiceStore.getState().loadMachines(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      {room ? (
        <button
          type="button"
          onClick={() => void get()}
          disabled={busy}
          className="lip press inline-flex h-8 max-w-full items-center gap-1.5 rounded-full bg-spike px-3 text-[12px] font-bold text-spike-ink [--lip:var(--color-spike-lip)] hover:bg-spike-hi disabled:opacity-70"
        >
          {busy ? <LoaderCircle size={13} className="shrink-0 animate-spin" /> : <Download size={13} strokeWidth={2.6} className="shrink-0" />}
          <span className="truncate">
            {has && !bytes ? "Set up audio.cpp" : `Get it · ${gbOf(bytes)}`}
            {spot.fit.offload ? " · part in RAM" : ""}
          </span>
        </button>
      ) : (
        <span className="text-[11.5px] text-tungsten">
          Needs {gbOf(bytes)} free on {gpuName(m)}; it has {m.diskGb?.toFixed(0)} GB.
        </span>
      )}
      {error ? (
        <p className="mt-1.5 flex items-start gap-1 text-[11px] text-tally">
          <TriangleAlert size={12} className="mt-px shrink-0" /> {error}
        </p>
      ) : null}
    </div>
  );
}

/** A model on its way to a machine: how much is there. */
function Getting({ model, machine }: { model: VoiceModel; machine: VoiceMachine }) {
  const files = machine.downloads.filter((d) => model.variants.some((v) => v.file.name === d.file) || HEARING.some((h) => h.name === d.file));
  const received = files.reduce((s, d) => s + d.received, 0) + (machine.installing?.received ?? 0);
  const total = files.reduce((s, d) => s + d.total, 0) + (machine.installing?.total ?? 0);
  return (
    <div className="w-full">
      <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.12]">
        <div className="h-full rounded-full bg-spike transition-[width] duration-700" style={{ width: `${Math.max(2, total ? (received / total) * 100 : 2)}%` }} />
      </div>
      <p className="mt-1.5 truncate text-[11px] text-fog">{total ? `${gbOf(received)} of ${gbOf(total)} on ${gpuName(machine)}` : `Starting on ${gpuName(machine)}…`}</p>
    </div>
  );
}

function MachineLine({ m }: { m: VoiceMachine }) {
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-[14px] bg-white/[0.035] px-3.5 py-2.5 text-[12.5px] text-haze">
      <Cpu size={14} className="shrink-0 text-fog" />
      <span className="font-semibold text-paper">{gpuName(m)}</span>
      {m.gpuGb ? <span>{Math.round(m.gpuGb)} GB VRAM</span> : null}
      {m.ramGb ? <span>· {Math.round(m.ramGb)} GB RAM</span> : null}
      {m.diskGb != null ? <span>· {m.diskGb.toFixed(0)} GB disk free</span> : null}
      <span>· {m.engine ? "audio.cpp ready" : "audio.cpp comes with the first model"}</span>
      {m.hearing ? <span>· speech to text ready</span> : null}
    </p>
  );
}

function GhostLinkOut({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="press inline-flex h-8 items-center gap-1 rounded-full bg-white/[0.08] px-3 text-[12.5px] font-semibold text-paper hover:bg-white/[0.14]">
      {children} <ArrowUpRight size={13} />
    </Link>
  );
}

