"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import Link from "next/link";
import { ArrowUpRight, Check, ChevronDown, CornerDownLeft, Languages, LoaderCircle, Mic, Minus, Plus, SlidersHorizontal, User, Users, Wand2, X } from "lucide-react";
import { Popover } from "@/components/ui/Popover";
import { ScrollRow } from "@/components/ui/ScrollRow";
import { RecDot } from "@/components/ui/Viewfinder";
import { ChipButton, GLASS_CHIP } from "@/components/dashboard/ComposerControls";
import { ScriptBox, ScriptPreview, type ScriptEditor } from "./ScriptBox";
import { Orb, watch } from "./Orb";
import { Aurora } from "./Aurora";
import { TakeRow } from "./TakeRow";
import { VoiceDrawer, type VoiceView } from "./VoiceDrawer";
import { VoiceModelLibrary, VoiceModelMark } from "./VoiceModelLibrary";
import { VoiceSetupBar } from "./VoiceSetup";
import { TalkBar } from "./TalkBar";
import { useTalkState } from "./talk-store";
import { AddPanel, HowPanel, MOODS } from "./ComposerPanels";
import { usePlayer } from "./player";
import { useVoicePrefs } from "./prefs";
import { useVoiceSetup, useVoiceStore } from "@/lib/hooks/use-voice";
import { useGenerations, useGenerationsStore } from "@/lib/hooks/use-generations";
import { useNow } from "@/lib/hooks/use-now";
import { secondsOf, type SceneLine } from "@/lib/voice/script";
import { gbOf, voiceModel, type VoiceModelId } from "@/lib/voice/models";
import { LFM3_BYTES, LFM3_NAME } from "@/lib/local/lfm3";
import type { VoiceAsk, VoiceCard } from "@/lib/voice/types";
import type { Generation } from "@/lib/generations/types";
import { cn } from "@/lib/cn";

/** What an empty script suggests, one after another, with sounds and whispers where they'd go. */
const EXAMPLES = [
  "[laughs] Okay, okay. One more take, and this time I'll keep a straight face.",
  "<whisper>Don't turn around.</whisper> It's right behind you.",
  "[sighs] Last call before we close the doors tonight. Take your time.",
  "Hey, you made it! [chuckles] I saved you the good seat.",
  "Welcome back. [pause] Tonight's story begins on a small island, far out at sea…",
  "[gasps] Wait. Is that a new episode? Nobody move.",
];

/** Ways to start: a script, how it's said and a voice that suits it, in one click. */
const STARTERS: { label: string; voice: string; direction: string; script: string }[] = [
  { label: "Ad read", voice: "sloane", direction: "A confident announcer, big and clear", script: "[breath] Introducing the all-new Aurora headphones. <emphasis>Twelve</emphasis> hours of silence, wherever you are. Pre-order today." },
  { label: "Bedtime story", voice: "lumi", direction: "A storyteller by the fire, taking their time", script: "Once upon a time, [pause] in a town where the lights came on one by one, there lived a very small dragon who was afraid of the dark." },
  { label: "Podcast intro", voice: "elio", direction: "Warm and close, like talking to a friend", script: "Hey everyone, welcome back to the show. [chuckles] I promise, this week's episode is worth it." },
  { label: "Game character", voice: "rook", direction: "Serious and steady, every word matters", script: "[sighs] You came back. <whisper>They said you wouldn't.</whisper> Pick up your sword. We leave at dawn." },
  { label: "Announcement", voice: "bram", direction: "Calm and even, no rush", script: "Good evening. The museum will close in fifteen minutes. [pause] Thank you for visiting, and have a safe trip home." },
  { label: "Meditation", voice: "wren", direction: "Quiet and slow, every word soft", script: "Breathe in slowly. [breath] Let your shoulders drop. <slow>There's nowhere else you need to be.</slow>" },
];

/** Conversations to start from: two voices, about a minute of lines, and how it's played. */
const SCENE_STARTERS: { label: string; cast: [string, string]; direction: string; lines: SceneLine[] }[] = [
  {
    label: "The fridge has opinions",
    cast: ["juno", "rook"],
    direction: "Playful and quick, two roommates bickering in the kitchen",
    lines: [
      { speaker: 0, text: "Okay, I need you to stay calm. The fridge is talking again." },
      { speaker: 1, text: "[sighs] Juno. It's a fridge. It hums." },
      { speaker: 0, text: "It doesn't hum. It told me my oat milk deserves better." },
      { speaker: 1, text: "Better than what?" },
      { speaker: 0, text: "Better than me! [laughs] It said I keep opening the door and staring, like I'm waiting for my life to change." },
      { speaker: 1, text: "Are you waiting for your life to change?" },
      { speaker: 0, text: "I'm waiting for cheese, Rook. I'm waiting for cheese." },
      { speaker: 1, text: "[chuckles] Fine. Ask it what we're having for dinner." },
      { speaker: 0, text: "<whisper>Fridge, what should we have for dinner?</whisper> [pause] It says whatever's about to expire." },
      { speaker: 1, text: "That's honestly reasonable." },
      { speaker: 0, text: "Then it said, and I quote, and call your mother." },
      { speaker: 1, text: "[gasps] Okay, now it's personal." },
      { speaker: 0, text: "Right? Who gave it the right?" },
      { speaker: 1, text: "We did. We clicked I agree on a forty-page document." },
      { speaker: 0, text: "[sighs] I'm unplugging it." },
      { speaker: 1, text: "You can't. The ice cream." },
      { speaker: 0, text: "The ice cream. [laughs] Fine, it stays. But it doesn't get a say in my love life." },
      { speaker: 1, text: "Too late. It just ordered you a smaller pizza." },
    ],
  },
  {
    label: "Grandpa invented the selfie",
    cast: ["nia", "otto"],
    direction: "Warm and cosy, a grandpa teasing his granddaughter",
    lines: [
      { speaker: 0, text: "Grandpa, look, I'll show you how to take a selfie. You hold it up like this." },
      { speaker: 1, text: "[chuckles] Sweetheart. I invented the selfie." },
      { speaker: 0, text: "You did not." },
      { speaker: 1, text: "Nineteen seventy-three. Me, a lake, and a camera on a very long stick." },
      { speaker: 0, text: "[laughs] A stick?" },
      { speaker: 1, text: "A broom handle. Your grandmother tied it on with her scarf." },
      { speaker: 0, text: "That's actually amazing. Did it work?" },
      { speaker: 1, text: "The first one? A beautiful photo of my left ear. [pause] The second one, the camera fell in the lake." },
      { speaker: 0, text: "Oh no." },
      { speaker: 1, text: "Oh yes. A fish took it. I like to think he still has it." },
      { speaker: 0, text: "[laughs] So where's the third one?" },
      { speaker: 1, text: "Framed. In the hallway. You walk past it every Sunday." },
      { speaker: 0, text: "Wait. The blurry one with the duck?" },
      { speaker: 1, text: "That's not a duck. That is your grandmother, laughing." },
      { speaker: 0, text: "[gasps] Grandpa!" },
      { speaker: 1, text: "She'd say the same thing. [sighs] Now. Show me this selfie of yours. And hold it properly. No broom." },
    ],
  },
  {
    label: "The meeting that never ended",
    cast: ["sloane", "elio"],
    direction: "Dry office comedy, quick back and forth",
    lines: [
      { speaker: 0, text: "Okay, one quick thing before we wrap up." },
      { speaker: 1, text: "[sighs] Sloane, it's been six hours." },
      { speaker: 0, text: "Five and a half. The first thirty minutes were small talk." },
      { speaker: 1, text: "We talked about the weather for thirty minutes." },
      { speaker: 0, text: "It was very interesting weather." },
      { speaker: 1, text: "[laughs] It was drizzle. Drizzle, Sloane." },
      { speaker: 0, text: "Focus. Item forty-two. Who keeps taking the stapler?" },
      { speaker: 1, text: "Nobody's taking the stapler. The stapler is right there." },
      { speaker: 0, text: "That's the backup stapler." },
      { speaker: 1, text: "We have a backup stapler?" },
      { speaker: 0, text: "We have a backup stapler because someone took the stapler." },
      { speaker: 1, text: "[pause] Okay. It was me. I needed it for a craft project." },
      { speaker: 0, text: "[gasps] A craft project?" },
      { speaker: 1, text: "My daughter's volcano. It had a paper tower." },
      { speaker: 0, text: "[laughs] Fine. Forgiven. Item forty-three." },
      { speaker: 1, text: "No. No more items. <whisper>Everyone else left two hours ago.</whisper>" },
      { speaker: 0, text: "Then who's been nodding on the call this whole time?" },
      { speaker: 1, text: "That's a screensaver, Sloane. It's a screensaver." },
    ],
  },
];

const FALLBACK: [string, string] = ["#ffc07c", "#b8432e"];

/**
 * The hero fills the screen; under the top bar, the room around the bar is shared 1 : 1.1 (its middle a little above
 * the hero's), and every part keeps its own height on a short screen (the hero grows instead).
 */
const HERO: CSSProperties = { minHeight: "calc(100svh - 2rem)" };
const HERO_INNER: CSSProperties = { flex: "1 1 auto", paddingTop: "clamp(5rem, 2rem + 6vw, 6rem)" };
const HERO_TOP: CSSProperties = { flex: "1 1 0px" };
const HERO_BOTTOM: CSSProperties = { flex: "1.1 1 0px" };

/** What Talk can be locked to hearing (Qwen3-ASR's languages, the bridge's codes); "auto" works it out each time. */
const HEARS: [string, string][] = [
  ["auto", "Any language"],
  ["en", "English"],
  ["pl", "Polish"],
  ["it", "Italian"],
  ["es", "Spanish"],
  ["fr", "French"],
  ["de", "German"],
  ["pt", "Portuguese"],
  ["nl", "Dutch"],
  ["sv", "Swedish"],
  ["da", "Danish"],
  ["fi", "Finnish"],
  ["cs", "Czech"],
  ["uk", "Ukrainian"],
  ["ru", "Russian"],
  ["tr", "Turkish"],
  ["el", "Greek"],
  ["hu", "Hungarian"],
  ["ro", "Romanian"],
  ["ar", "Arabic"],
  ["hi", "Hindi"],
  ["id", "Indonesian"],
  ["ms", "Malay"],
  ["vi", "Vietnamese"],
  ["th", "Thai"],
  ["zh", "Chinese"],
  ["ja", "Japanese"],
  ["ko", "Korean"],
];
const LETTERS = "ABCD";
type Mode = "solo" | "scene" | "talk";

/**
 * Voice, in Home's way of working: one line for the words (it grows as you write), the chips under it and Speak, all on
 * Home's smoked glass over a backdrop of the voice's own light. Solo, Conversation or Talk live switches what the bar
 * holds: one voice and its script, a cast and their lines, or a live talk with the voice (TalkBar). The takes play
 * below, day by day, their words lighting up.
 */
export function VoiceStudio() {
  useVoiceSetup();
  const ready = useVoiceStore((s) => s.ready);
  const yours = useVoiceStore((s) => s.yours);
  const machines = useVoiceStore((s) => s.machines);
  const machinesLoaded = useVoiceStore((s) => s.machinesLoaded);
  const items = useGenerations((s) => s.items);
  const submit = useGenerations((s) => s.submit);

  // The choices you keep between visits.
  const model = useVoicePrefs((s) => s.model);
  const voice = useVoicePrefs((s) => s.voice);
  const direction = useVoicePrefs((s) => s.direction);
  const lively = useVoicePrefs((s) => s.lively);
  const language = useVoicePrefs((s) => s.language);
  const hears = useVoicePrefs((s) => s.hears);
  const setPrefs = useVoicePrefs((s) => s.set);
  const setModel = (v: VoiceModelId) => setPrefs({ model: v });
  const setVoice = (v: string) => setPrefs({ voice: v });

  const [mode, setMode] = useState<Mode>("solo");
  const [cast, setCast] = useState<string[]>([]);
  const [lines, setLines] = useState<SceneLine[]>([]);
  const [focusLine, setFocusLine] = useState<number | null>(null);
  const [script, setScript] = useState("");
  const [speed, setSpeed] = useState(1);
  const [count, setCount] = useState(1);
  const [voicesFor, setVoicesFor] = useState<number | "one" | null>(null);
  const [voicesView, setVoicesView] = useState<VoiceView>("all");
  const [modelsOpen, setModelsOpen] = useState(false);
  const [modelAnchor, setModelAnchor] = useState<HTMLSpanElement | null>(null);
  const [whoAnchor, setWhoAnchor] = useState<HTMLSpanElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [example, setExample] = useState(0);
  const [brainBusy, setBrainBusy] = useState(false);
  const [brainError, setBrainError] = useState<string | null>(null);
  const editor = useRef<ScriptEditor | null>(null);

  useEffect(() => {
    if (!useGenerationsStore.getState().loaded) void useGenerationsStore.getState().load();
    void useVoicePrefs.persist.rehydrate();
  }, []);

  // ?voices=clone (or design) opens Voices on that tab: Clone's "use the secure address" lands back there.
  useEffect(() => {
    const url = new URL(window.location.href);
    const tab = url.searchParams.get("voices");
    if (tab !== "clone" && tab !== "design") return;
    // Read again on React's second mount while developing, so the address loses it only once it has opened.
    const t = window.setTimeout(() => {
      url.searchParams.delete("voices");
      window.history.replaceState(window.history.state, "", url);
      setVoicesView(tab);
      setVoicesFor("one");
    }, 0);
    return () => window.clearTimeout(t);
  }, []);

  // ?talk=1 (Talk's way to the secure address lands back there) opens on Talk live.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get("talk") !== "1") return;
    const t = window.setTimeout(() => {
      url.searchParams.delete("talk");
      window.history.replaceState(window.history.state, "", url);
      setMode("talk");
    }, 0);
    return () => window.clearTimeout(t);
  }, []);

  // Examples take turns while the script is empty, as on Home.
  useEffect(() => {
    if (script) return;
    const t = setInterval(() => setExample((e) => (e + 1) % EXAMPLES.length), 4200);
    return () => clearInterval(t);
  }, [script]);

  const all = useMemo(() => [...yours, ...ready], [yours, ready]);
  const find = (id: string) => all.find((v) => v.id === id) ?? null;
  const current = find(voice);
  const scene = mode === "scene";
  const talking = mode === "talk";
  const m = voiceModel(model)!;
  const where = machines.filter((x) => x.online && x.engine && x.models.includes(model));
  const runsOn = where.find((x) => x.runOn) ?? [...where].sort((a, b) => (b.gpuGb ?? 0) - (a.gpuGb ?? 0))[0];
  // The model is on a machine that isn't answering (a rented GPU switched off): say so, rather than offer it again.
  const away = !runsOn ? machines.find((x) => !x.online && x.away?.models.includes(model)) : undefined;
  const awayName = away?.away?.gpu ?? away?.label ?? "";
  // Talk's answers: LFM3-VL 2B on one of your GPUs. Machines with bridge 1.9.2+ say whether it's there; when none can,
  // Talk just tries.
  const brains = machines.filter((x) => x.online && x.brain);
  const brainReady = !brains.length || brains.some((x) => x.brain?.ready);
  const brainJobs = machines.flatMap((x) => (x.brainSetup ? [x.brainSetup] : []));
  const brainJob = brainJobs.find((j) => j.state === "running") ?? brainJobs.find((j) => j.state === "error") ?? brainJobs[0] ?? null;
  const takes = items.filter((g) => g.tool === "voice");
  const live = takes.filter((g) => g.status === "queued" || g.status === "running").length;
  const plain = !m.can.tags;

  // Conversation: the voice you have and a second one, and a few lines to start from (yours stay when you switch back).
  const toScene = () => {
    setMode("scene");
    if (cast.length < 2) {
      setCast([voice, voice === "elio" ? "mara" : "elio"]);
      setLines([
        { speaker: 0, text: "Is it on? Is it recording?" },
        { speaker: 1, text: "It's been recording for ten minutes." },
        { speaker: 0, text: "[laughs] Great. Then that was the warm-up." },
      ]);
    }
  };
  const addSpeaker = () => {
    if (cast.length >= 4) return;
    const next = ["juno", "otto", "nia", "bram"].find((id) => !cast.includes(id)) ?? "juno";
    setCast((c) => [...c, next]);
    setVoicesFor(cast.length);
  };
  const dropSpeaker = (i: number) => {
    if (cast.length <= 2) return;
    setCast((c) => c.filter((_, k) => k !== i));
    setLines((ls) => ls.filter((l) => l.speaker !== i).map((l) => ({ ...l, speaker: l.speaker > i ? l.speaker - 1 : l.speaker })));
  };
  const pick = (v: VoiceCard) => {
    if (voicesFor === "one" || voicesFor === null) setVoice(v.id);
    else setCast((c) => c.map((id, i) => (i === voicesFor ? v.id : id)));
  };
  const addLine = (speaker: number, after = lines.length - 1) => {
    setLines((ls) => [...ls.slice(0, after + 1), { speaker, text: "" }, ...ls.slice(after + 1)]);
    setFocusLine(after + 1);
  };

  const speak = async (base?: { gen: Generation; note: string }) => {
    setNotice(null);
    if (!runsOn) {
      // Switched off, not missing: look again (it may be back) rather than offer it somewhere else.
      if (away) {
        setNotice(`Your ${awayName} isn't answering: switch it on first.`);
        void useVoiceStore.getState().loadMachines(true);
      } else setModelsOpen(true);
      return;
    }
    const prev = base?.gen.params?.voice as VoiceAsk | undefined;
    const said = lines.filter((l) => l.text.trim());
    const ask: VoiceAsk = prev
      ? { ...prev, direction: base!.note ? [prev.direction, base!.note].filter(Boolean).join(", ") : prev.direction, note: base!.note || undefined, of: base!.gen.id }
      : {
          model,
          direction,
          speed,
          lively,
          language,
          ...(scene ? { cast, lines: said } : { voice }),
          who: (scene ? cast : [voice]).map((id) => ({ name: find(id)?.name ?? "Voice", hues: find(id)?.hues ?? FALLBACK })),
        };
    const words = prev ? base!.gen.prompt : scene ? said.map((l) => `${find(cast[l.speaker])?.name ?? "Voice"}: ${l.text}`).join("\n") : script;
    if (!words.trim()) {
      setNotice(scene ? "Give someone a line first." : "Write what should be said first.");
      return;
    }
    setBusy(true);
    try {
      for (let i = 0; i < (base ? 1 : count); i++) {
        await submit({ tool: "voice", prompt: words, aspect: "1:1", count: 1, model: ask.model, refine: false, params: { kind: "voice", voice: ask } });
      }
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // LFM3-VL for Talk, set up in one go (server/voice/talk-setup): on the machine named, else beside the voice.
  const setUpBrain = async (machine?: string) => {
    if (brainBusy || brainJob?.state === "running") return;
    setBrainBusy(true);
    setBrainError(null);
    try {
      const res = await fetch("/api/voice/talk/setup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model, machine }) });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "That didn't start.");
      await useVoiceStore.getState().loadMachines(true);
    } catch (e) {
      setBrainError((e as Error).message);
    } finally {
      setBrainBusy(false);
    }
  };

  const seconds = scene ? lines.reduce((s, l) => s + secondsOf(l.text), 0) : secondsOf(script || EXAMPLES[example]);
  const hues = (scene ? find(cast[0])?.hues : current?.hues) ?? FALLBACK;
  const name = scene ? null : (current?.name ?? "Mara");
  const mood = MOODS.find((x) => x.text === direction.trim());
  const how = !m.can.direct ? "Language" : mood ? mood.label : direction.trim() ? (direction.length > 24 ? `${direction.slice(0, 22).trim()}…` : direction) : "How it's said";
  const castNames = cast.map((id) => find(id)?.name ?? "Voice");

  // The three ways to use Voice, as tabs right above the bar: the first thing you pick.
  const modeSwitch = (
    <div role="radiogroup" aria-label="How Voice works" className="flex h-10 shrink-0 rounded-full bg-black/35 p-1 ring-1 ring-white/[0.08]">
      {(
        [
          ["solo", "Solo", User],
          ["scene", "Conversation", Users],
          ["talk", "Real time", Mic],
        ] as const
      ).map(([id, label, Icon]) => (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={mode === id}
          onClick={() => (id === "scene" ? toScene() : setMode(id))}
          className={cn(
            "press inline-flex items-center gap-1.5 rounded-full px-4 text-[13.5px] font-semibold transition-colors duration-150",
            mode === id ? "bg-white/[0.14] text-paper shadow-[inset_0_1px_0_rgb(255_255_255/0.1),0_1px_2px_rgb(0_0_0/0.3)]" : "text-fog hover:text-paper",
          )}
        >
          <Icon size={14} strokeWidth={2.2} className={mode === id ? "text-[var(--color-tool-voice)]" : "opacity-70"} />
          {label}
        </button>
      ))}
    </div>
  );
  // The chips both bars share: who speaks and the model.
  const whoChip = (
    <span ref={setWhoAnchor} className="inline-flex shrink-0">
      {scene ? (
        <CastChip cast={cast} find={find} onChange={(i) => setVoicesFor(i)} onAdd={addSpeaker} onDrop={dropSpeaker} />
      ) : (
        <ChipButton onClick={() => setVoicesFor("one")} aria-haspopup="dialog" title={talking ? "Who you talk with" : "Who says it"} className="pl-1.5">
          <Orb hues={current?.hues ?? FALLBACK} size={22} />
          {current?.name ?? "Mara"}
          <ChevronDown size={13} className="text-haze" />
        </ChipButton>
      )}
    </span>
  );
  const modelChip = (
    <span ref={setModelAnchor} className="inline-flex shrink-0">
      <ChipButton onClick={() => setModelsOpen(true)} aria-haspopup="dialog" aria-expanded={modelsOpen} aria-label="Voice model" className="pr-2.5">
        <VoiceModelMark model={m} size={15} variant="bare" />
        {m.name}
        {!runsOn && machinesLoaded ? away ? <span className="font-medium text-haze">· off</span> : <span className="font-medium text-tungsten">· get it</span> : null}
        <ChevronDown size={13} className={cn("shrink-0 text-haze transition-transform", modelsOpen && "rotate-180")} />
      </ChipButton>
    </span>
  );
  // Talk: the language you speak in. Locked to one, an accent is never taken for another language.
  const heard = HEARS.find(([code]) => code === hears) ?? HEARS[1];
  const hearsChip = (
    <Popover
      placement="bottom-start"
      panelClassName="p-0"
      trigger={({ toggle, open, id }) => (
        <ChipButton onClick={toggle} aria-expanded={open} aria-controls={id} aria-haspopup="dialog" title="The language you speak in">
          <Languages size={14} className={heard[0] === "auto" ? "text-haze" : "text-[var(--color-tool-voice)]"} />
          {heard[0] === "auto" ? "Any language" : `You speak ${heard[1]}`}
          <ChevronDown size={13} className="shrink-0 text-haze" />
        </ChipButton>
      )}
    >
      {(close) => (
        <div className="flex w-[250px] flex-col p-1.5">
          <p className="label px-2 pb-1.5 pt-1">You speak</p>
          <div className="scroll-thin flex max-h-[300px] flex-col overflow-y-auto">
            {HEARS.map(([code, label]) => (
              <button
                key={code}
                type="button"
                onClick={() => (setPrefs({ hears: code }), close())}
                className={cn("press squircle flex items-center justify-between gap-2 rounded-[12px] px-2.5 py-1.5 text-left text-[13px] font-semibold hover:bg-white/[0.06]", code === heard[0] ? "text-paper" : "text-fog")}
              >
                {label}
                {code === heard[0] ? <Check size={14} className="shrink-0 text-[var(--color-tool-voice)]" /> : null}
              </button>
            ))}
          </div>
          <p className="px-2 pb-1 pt-2 text-[11.5px] leading-snug text-haze">Set to your language, it never takes your accent for another one. Any language works it out each time you speak.</p>
        </div>
      )}
    </Popover>
  );
  const getIt = (
    <span className="text-tungsten">
      {m.name} isn&rsquo;t on your GPUs yet.{" "}
      <button type="button" onClick={() => setModelsOpen(true)} className="font-semibold underline decoration-tungsten/40 underline-offset-2 hover:text-paper">
        Get it
      </button>
    </span>
  );
  const isOff = (
    <span className="text-fog">
      {m.name} is on your {awayName}, which isn&rsquo;t answering: switch it on and Voice finds it.{" "}
      <button type="button" onClick={() => setModelsOpen(true)} className="font-semibold underline decoration-white/25 underline-offset-2 hover:text-paper">
        Other GPUs
      </button>
    </span>
  );
  const brainPct = brainJob?.progress?.total ? Math.round((brainJob.progress.received / brainJob.progress.total) * 100) : null;
  const brainFix = brains.find((x) => x.brain?.files);
  const brainLine =
    brainJob?.state === "running" ? (
      <span className="text-fog">
        <LoaderCircle size={12} className="mr-1.5 inline animate-spin align-[-2px] text-[var(--color-tool-voice)]" />
        Setting up {LFM3_NAME} on {brainJob.label} · {brainJob.detail}
        {brainPct !== null ? <span className="tabular"> · {brainPct}%</span> : null}
      </span>
    ) : brainError || brainJob?.state === "error" ? (
      <span className="text-tally">
        Couldn&rsquo;t set up {LFM3_NAME} · {brainError ?? brainJob?.error}{" "}
        <button type="button" disabled={brainBusy} onClick={() => void setUpBrain(brainError ? undefined : brainJob?.machine)} className="font-semibold text-paper underline decoration-white/25 underline-offset-2 disabled:opacity-50">
          Try again
        </button>
      </span>
    ) : (
      <span className="text-tungsten">
        {brainFix ? `${LFM3_NAME} on ${brainFix.gpu ?? brainFix.label} needs a newer transformers (ComfyUI restarts once).` : `${LFM3_NAME} writes Talk's answers and isn't on your GPUs yet · ${gbOf(LFM3_BYTES)}.`}{" "}
        <button type="button" disabled={brainBusy} onClick={() => void setUpBrain(brainFix?.id)} className="font-semibold underline decoration-tungsten/40 underline-offset-2 hover:text-paper disabled:opacity-50">
          {brainFix ? "Update it" : "Set it up"}
        </button>
      </span>
    );

  return (
    <div className="mx-auto max-w-[1560px] px-3 pb-24 pt-3 sm:px-4 sm:pt-4">
      {/* The hero's frame (its height, its top room, how the room is shared) is in inline styles, not utility classes:
          Safari once laid it out with a stale dev stylesheet that lacked them, and the hero folded to its content. */}
      <section className="relative isolate flex flex-col overflow-hidden rounded-panel bg-[#120f17]" style={HERO}>
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-[1] rounded-[inherit] shadow-[inset_0_0_0_1px_rgb(255_255_255/0.07)]" />
        <Backdrop hues={hues} />

        <div className="absolute inset-x-0 top-0 z-[2] flex items-center justify-between gap-3 p-4 sm:p-6">
          <button
            type="button"
            onClick={() => setModelsOpen(true)}
            className="press inline-flex min-w-0 items-center gap-2 rounded-full bg-black/35 px-3 py-1.5 font-mono text-[10.5px] uppercase tracking-[0.14em] text-paper/80 ring-1 ring-white/[0.08] hover:text-paper"
          >
            {live ? (
              <>
                <RecDot /> Speaking · {live}
              </>
            ) : (
              <>
                <span className={cn("size-1.5 shrink-0 rounded-full", runsOn ? "bg-chroma/80" : away ? "bg-haze" : machinesLoaded ? "bg-tungsten" : "bg-haze")} />
                <span className="truncate">{runsOn ? `${m.name} · ${runsOn.gpu ?? runsOn.label}` : away ? `${m.name} · ${awayName} is off` : machinesLoaded ? `Get ${m.name}` : "Looking for your GPUs"}</span>
              </>
            )}
          </button>
          <Link href="/library" className="hidden rounded-full px-3 py-1.5 text-[12.5px] font-semibold text-fog hover:text-paper sm:block">
            All takes in Library
          </Link>
        </div>

        <VoiceSetupBar onModels={() => setModelsOpen(true)} />

        {/* Three parts: the voice and what it does, the bar just under the middle (the space around it shared 1 : 1.1),
            ways to start at the bottom. Each keeps its own height when the screen is short: the hero grows instead. */}
        <div className="relative z-[2] flex w-full flex-col px-4 sm:px-8" style={HERO_INNER}>
          <div className="flex flex-col items-center justify-end pb-7" style={HERO_TOP}>
            {scene ? (
              <span className="flex -space-x-5">
                {cast.map((id, i) => (
                  <LiveOrb key={`${id}-${i}`} hues={find(id)?.hues ?? FALLBACK} size={76} working={live > 0} className="ring-4 ring-[#120f17]" />
                ))}
              </span>
            ) : (
              <LiveOrb hues={hues} size={96} working={live > 0} />
            )}
            <h1 className="mt-5 text-center font-display text-[40px] sm:text-[56px] lg:text-[68px]">{talking ? <>Talk with {name}</> : name ? <>What should {name} say?</> : <>{castNames.slice(0, -1).join(", ")} and {castNames.at(-1)}, talking</>}</h1>
            <p className="mx-auto mt-2.5 max-w-[44rem] text-balance text-center text-[15px] leading-relaxed text-fog sm:text-base">
              {talking
                ? `Talk out loud and ${name} answers in their own voice. Talk over them to cut in.`
                : scene
                  ? "Write it like a screenplay: each line goes to its speaker, and Drama 3 plays the scene in one take."
                  : "Write it in any language. Add a laugh, a sigh or a whisper where you want it."}
            </p>
          </div>

          <div className="mx-auto w-full max-w-[1080px]">
          <div className="mb-3 flex justify-center">{modeSwitch}</div>
          {talking ? (
            <TalkBar
              voice={voice}
              voiceName={name ?? "Mara"}
              hues={hues}
              model={model}
              language={hears}
              ready={(Boolean(runsOn) || !machinesLoaded) && brainReady}
              onGetModel={() => (runsOn ? void setUpBrain(brainFix?.id ?? (brainJob?.state === "error" ? brainJob.machine : undefined)) : away ? void useVoiceStore.getState().loadMachines(true) : setModelsOpen(true))}
              idle={
                !runsOn && machinesLoaded ? (
                  away ? isOff : getIt
                ) : !brainReady ? (
                  brainLine
                ) : (
                  <span className="text-haze">
                    {brainJob?.state === "done" && brainJob.seconds != null ? <span className="text-fog">{LFM3_NAME} answered in {brainJob.seconds} s · </span> : null}
                    Talk, pause, and it answers · headphones help: it never hears itself ·{" "}
                    {m.credit ? <span className="font-semibold text-[#c9f5a2]/80">{m.credit}</span> : m.licence.name}
                  </span>
                )
              }
              chips={
                <ScrollRow className="-mb-0.5 -mt-1" trackClassName="gap-1.5 px-1">
                  {whoChip}
                  {hearsChip}
                  {modelChip}
                </ScrollRow>
              }
            />
          ) : (
            <>
          <div className="smoked-glass squircle relative flex flex-col gap-2 rounded-[26px] p-2 sm:flex-row">
            <div className="min-w-0 flex-1">
              {scene ? (
                <SceneLines
                  cast={cast}
                  lines={lines}
                  setLines={setLines}
                  find={find}
                  focusLine={focusLine}
                  onFocus={(api) => (editor.current = api)}
                  onNext={(i) => addLine(((lines[i]?.speaker ?? 0) + 1) % cast.length, i)}
                  onAdd={(speaker) => addLine(speaker)}
                  onSubmit={() => void speak()}
                />
              ) : (
                <div className="relative">
                  <ScriptBox
                    value={script}
                    onChange={(v) => {
                      setScript(v);
                      if (notice) setNotice(null);
                    }}
                    onReady={(api) => (editor.current = api)}
                    onSubmit={() => void speak()}
                    label="What they say"
                    placeholder={
                      <span key={example} className="voice-ph">
                        <ScriptPreview text={EXAMPLES[example]} />
                      </span>
                    }
                    className="scroll-thin max-h-[150px] min-h-[60px] overflow-y-auto py-3 pl-3 pr-9 text-[16px] leading-relaxed text-paper"
                  />
                  {script ? (
                    <button type="button" aria-label="Clear the script" title="Clear" onClick={() => setScript("")} className="press absolute right-1.5 top-2 grid size-7 place-items-center rounded-full text-haze hover:bg-white/[0.08] hover:text-paper">
                      <X size={14} />
                    </button>
                  ) : null}
                </div>
              )}

              {/* One row that keeps its labels at any width: past what fits it scrolls sideways, as on Home. */}
              <ScrollRow className="-mb-0.5 -mt-1" trackClassName="gap-1.5 px-1">
                {whoChip}

                <Popover
                  placement="bottom-start"
                  panelClassName="p-0"
                  trigger={({ toggle, open, id }) => (
                    <ChipButton onClick={toggle} aria-expanded={open} aria-controls={id} aria-haspopup="dialog" disabled={plain} title={plain ? `${m.name} reads the words plainly` : "Add a sound, or say words a certain way"} className="disabled:cursor-not-allowed disabled:opacity-35">
                      <Plus size={15} strokeWidth={2.4} className="text-[var(--color-tool-voice)]" />
                      Add
                    </ChipButton>
                  )}
                >
                  {(close) => <AddPanel editor={editor.current} close={close} />}
                </Popover>
                <Popover
                  placement="bottom-start"
                  panelClassName="p-0"
                  trigger={({ toggle, open, id }) => (
                    <ChipButton onClick={toggle} aria-expanded={open} aria-controls={id} aria-haspopup="dialog" title="How it's said">
                      <SlidersHorizontal size={14} className={mood || direction.trim() ? "text-[var(--color-tool-voice)]" : "text-haze"} />
                      <span className={cn("max-w-[200px] truncate", direction.trim() || !m.can.direct ? "text-paper" : "text-fog")}>{how}</span>
                      <ChevronDown size={13} className="shrink-0 text-haze" />
                    </ChipButton>
                  )}
                >
                  {() => (
                    <HowPanel
                      who={{ name: name ?? castNames.join(" & "), hues }}
                      direction={direction}
                      setDirection={(v) => setPrefs({ direction: v })}
                      lively={lively}
                      setLively={(v) => setPrefs({ lively: v })}
                      language={language}
                      setLanguage={(v) => setPrefs({ language: v })}
                      speed={speed}
                      setSpeed={setSpeed}
                      canDirect={m.can.direct}
                      canSpeed={model === "local:voice:supertonic"}
                      modelName={m.name}
                    />
                  )}
                </Popover>
                {modelChip}
                <div className={cn("flex h-9 shrink-0 items-center rounded-chip text-[13px]", GLASS_CHIP)}>
                  <button type="button" aria-label="Fewer takes" disabled={count <= 1} onClick={() => setCount((c) => Math.max(1, c - 1))} className="press grid h-full w-7 place-items-center text-fog hover:text-paper disabled:opacity-30">
                    <Minus size={13} />
                  </button>
                  <span className="tabular w-7 text-center font-medium" aria-live="polite" title="Takes">
                    {count}/4
                  </span>
                  <button type="button" aria-label="More takes" disabled={count >= 4} onClick={() => setCount((c) => Math.min(4, c + 1))} className="press grid h-full w-7 place-items-center text-fog hover:text-paper disabled:opacity-30">
                    <Plus size={13} />
                  </button>
                </div>
              </ScrollRow>
            </div>

            <button
              type="button"
              onClick={() => void speak()}
              disabled={busy}
              className="lip squircle flex h-14 shrink-0 flex-col items-center justify-center gap-1 rounded-[20px] bg-spike px-6 text-spike-ink transition-[background-color,transform,box-shadow] duration-150 [--lip-glow:0_10px_32px_-10px_rgb(255_91_46/0.5)] [--lip:var(--color-spike-lip)] hover:bg-spike-hi hover:[--lip-glow:0_12px_38px_-10px_rgb(255_91_46/0.62)] disabled:cursor-not-allowed disabled:opacity-60 sm:h-auto sm:min-h-[98px] sm:w-[150px] sm:self-stretch"
            >
              {busy ? <LoaderCircle size={20} className="animate-spin" /> : <span className="font-display text-[22px] leading-none">Speak</span>}
              <span className="tabular hidden items-center gap-1 text-[11.5px] font-bold opacity-75 sm:flex">
                ×{count} · ~{seconds}s <CornerDownLeft size={11} />
              </span>
            </button>
          </div>

          <div className="mt-3 min-h-5 text-center text-[13px]" aria-live="polite">
            {notice ? (
              <span className="text-tally">{notice}</span>
            ) : !runsOn && machinesLoaded ? (
              away ? isOff : getIt
            ) : (
              <span className="text-haze">
                {scene ? "Enter for the next line · Shift ↵ for a new one in the same line" : "Enter to speak · Shift ↵ for a new line"} ·{" "}
                {m.credit ? <span className="font-semibold text-[#c9f5a2]/80">{m.credit}</span> : m.licence.name}
              </span>
            )}
          </div>
            </>
          )}
          </div>

          <div className="flex flex-col items-center justify-end pb-5 pt-6 sm:pb-6" style={HERO_BOTTOM}>
          {mode === "solo" ? (
            <div className="flex flex-wrap items-center justify-center gap-1.5">
              <span className="mr-1 text-[12px] font-semibold uppercase tracking-[0.12em] text-haze">Try</span>
              {STARTERS.map((s) => {
                const v = find(s.voice);
                return (
                  <button
                    key={s.label}
                    type="button"
                    onClick={() => {
                      setScript(s.script);
                      setPrefs({ direction: s.direction, ...(v ? { voice: v.id } : {}) });
                      setNotice(null);
                    }}
                    className="press inline-flex h-8 items-center gap-1.5 rounded-full bg-black/25 pl-1 pr-3 text-[12.5px] font-semibold text-fog shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)] hover:bg-black/40 hover:text-paper"
                  >
                    <Orb hues={v?.hues ?? FALLBACK} size={22} />
                    {s.label}
                  </button>
                );
              })}
            </div>
          ) : scene ? (
            <div className="flex flex-wrap items-center justify-center gap-1.5">
              <span className="mr-1 text-[12px] font-semibold uppercase tracking-[0.12em] text-haze">Try</span>
              {SCENE_STARTERS.map((s) => (
                <button
                  key={s.label}
                  type="button"
                  onClick={() => {
                    setCast([...s.cast]);
                    setLines(s.lines.map((l) => ({ ...l })));
                    setPrefs({ direction: s.direction });
                    setNotice(null);
                  }}
                  className="press inline-flex h-8 items-center gap-1.5 rounded-full bg-black/25 pl-1 pr-3 text-[12.5px] font-semibold text-fog shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)] hover:bg-black/40 hover:text-paper"
                >
                  <span className="flex -space-x-2">
                    {s.cast.map((id) => (
                      <Orb key={id} hues={find(id)?.hues ?? FALLBACK} size={22} className="ring-2 ring-[#1a1520]" />
                    ))}
                  </span>
                  {s.label}
                </button>
              ))}
            </div>
          ) : null}
          </div>
        </div>
      </section>

      <Takes takes={takes} onAgain={(gen, note) => void speak({ gen, note })} />

      <VoiceDrawer
        open={voicesFor !== null}
        onClose={() => (setVoicesFor(null), setVoicesView("all"))}
        anchor={whoAnchor}
        view={voicesView}
        current={typeof voicesFor === "number" ? (cast[voicesFor] ?? null) : voice}
        forWho={typeof voicesFor === "number" ? `speaker ${LETTERS[voicesFor]}` : null}
        onPick={pick}
      />
      <VoiceModelLibrary open={modelsOpen} onClose={() => setModelsOpen(false)} anchor={modelAnchor} value={model} onChange={setModel} glass />
    </div>
  );
}

/** The voice's own light behind the page: a shader (Aurora) over a CSS fallback, a haze of clouds and grain on top. */
function Backdrop({ hues }: { hues: [string, string] }) {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => (el.current ? watch(el.current) : undefined), []);
  return (
    <div ref={el} aria-hidden="true" className="voice-backdrop" style={{ "--vh1": hues[0], "--vh2": hues[1] } as CSSProperties}>
      <i className="voice-glow voice-glow-a" />
      <i className="voice-glow voice-glow-b" />
      <i className="voice-glow voice-glow-c" />
      <Aurora hues={hues} className="voice-aurora" />
      <i className="voice-haze" />
      <i className="voice-grain" />
    </div>
  );
}

/**
 * The page's big orb: it swells with whatever sounds, a take playing or a live talk (your voice or its answer), and its
 * ring breathes while a take is made or a talk hears and thinks. It reads the level itself, so the page doesn't
 * re-render with every frame of sound.
 */
function LiveOrb({ hues, size, working, className }: { hues: [string, string]; size: number; working: boolean; className?: string }) {
  const played = usePlayer((s) => (s.playing ? s.level : 0));
  const talked = useTalkState((s) => s.level);
  const thinking = useTalkState((s) => s.phase === "hearing" || s.phase === "thinking");
  return <Orb hues={hues} size={size} level={Math.max(played, talked)} working={working || thinking} className={className} />;
}

/** The cast, in the bar: their skies stacked, their names; open it to change, add or remove a speaker. */
function CastChip({ cast, find, onChange, onAdd, onDrop }: { cast: string[]; find: (id: string) => VoiceCard | null; onChange: (i: number) => void; onAdd: () => void; onDrop: (i: number) => void }) {
  return (
    <Popover
      placement="bottom-start"
      panelClassName="p-0"
      trigger={({ toggle, open, id }) => (
        <ChipButton onClick={toggle} aria-expanded={open} aria-controls={id} aria-haspopup="dialog" title="The cast" className="pl-1.5">
          <span className="flex -space-x-2">
            {cast.map((cid, i) => (
              <Orb key={`${cid}-${i}`} hues={find(cid)?.hues ?? FALLBACK} size={22} className="ring-2 ring-[#1a1720]" />
            ))}
          </span>
          <span className="max-w-[180px] truncate">{cast.map((cid) => find(cid)?.name ?? "Voice").join(" & ")}</span>
          <ChevronDown size={13} className="text-haze" />
        </ChipButton>
      )}
    >
      {(close) => (
        <div className="flex w-[300px] flex-col gap-1 p-2">
          <p className="label px-1.5 pb-1 pt-1">The cast</p>
          {cast.map((cid, i) => {
            const v = find(cid);
            return (
              <div key={`${cid}-${i}`} className="squircle flex items-center gap-2.5 rounded-[14px] bg-white/[0.03] p-2">
                <Orb hues={v?.hues ?? FALLBACK} size={32} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] font-semibold text-paper">{v?.name ?? "Voice"}</span>
                  <span className="block truncate text-[11.5px] text-haze">Speaker {LETTERS[i]} · {v?.desc ?? ""}</span>
                </span>
                <button type="button" onClick={() => (onChange(i), close())} className="press h-7 rounded-full bg-white/[0.08] px-2.5 text-[12px] font-semibold text-paper hover:bg-white/[0.14]">
                  Change
                </button>
                {cast.length > 2 ? (
                  <button type="button" aria-label={`Remove ${v?.name ?? "speaker"}`} onClick={() => onDrop(i)} className="press grid size-7 place-items-center rounded-full text-haze hover:bg-white/[0.08] hover:text-paper">
                    <X size={13} />
                  </button>
                ) : null}
              </div>
            );
          })}
          {cast.length < 4 ? (
            <button type="button" onClick={() => (onAdd(), close())} className="press squircle mt-0.5 flex h-10 items-center justify-center gap-1.5 rounded-[14px] text-[13px] font-semibold text-fog shadow-[inset_0_0_0_1px_var(--color-line)] hover:bg-white/[0.04] hover:text-paper">
              <Plus size={14} /> Add a speaker
            </button>
          ) : null}
        </div>
      )}
    </Popover>
  );
}

/**
 * A conversation in the bar, like a screenplay: each line starts with who says it (pick from the cast), Enter starts the
 * next line for the next speaker, and the buttons under the lines add one for anyone in particular.
 */
function SceneLines({
  cast,
  lines,
  setLines,
  find,
  focusLine,
  onFocus,
  onNext,
  onAdd,
  onSubmit,
}: {
  cast: string[];
  lines: SceneLine[];
  setLines: (fn: (l: SceneLine[]) => SceneLine[]) => void;
  find: (id: string) => VoiceCard | null;
  focusLine: number | null;
  onFocus: (api: ScriptEditor) => void;
  onNext: (i: number) => void;
  onAdd: (speaker: number) => void;
  onSubmit: () => void;
}) {
  return (
    <div className="flex flex-col pb-1 pt-1.5">
      <div className="scroll-thin flex max-h-[280px] flex-col gap-0.5 overflow-y-auto px-1">
        {lines.map((l, i) => {
          const v = find(cast[l.speaker] ?? "");
          return (
            <div key={i} className="group grid grid-cols-[minmax(0,118px)_minmax(0,1fr)_28px] items-start gap-2 rounded-[14px] px-1.5 py-1 hover:bg-white/[0.025]">
              <Popover
                placement="bottom-start"
                trigger={({ toggle, open, id }) => (
                  <button
                    type="button"
                    onClick={toggle}
                    aria-expanded={open}
                    aria-controls={id}
                    title="Who says this line"
                    className="press mt-[3px] flex h-7 max-w-full items-center gap-1.5 justify-self-start rounded-full pl-0.5 pr-2 text-[12.5px] font-semibold"
                    style={{ color: v?.hues[0] ?? FALLBACK[0], background: `color-mix(in oklab, ${v?.hues[0] ?? FALLBACK[0]} 13%, transparent)` }}
                  >
                    <Orb hues={v?.hues ?? FALLBACK} size={24} />
                    <span className="truncate">{v?.name ?? "Voice"}</span>
                    <ChevronDown size={12} className="shrink-0 opacity-60" />
                  </button>
                )}
              >
                {(close) => (
                  <div className="flex w-[200px] flex-col p-1">
                    {cast.map((cid, k) => {
                      const c = find(cid);
                      return (
                        <button
                          key={`${cid}-${k}`}
                          type="button"
                          onClick={() => (setLines((ls) => ls.map((x, n) => (n === i ? { ...x, speaker: k } : x))), close())}
                          className={cn("press squircle flex items-center gap-2 rounded-[12px] px-2 py-1.5 text-left text-[13px] hover:bg-white/[0.06]", k === l.speaker ? "text-paper" : "text-fog")}
                        >
                          <Orb hues={c?.hues ?? FALLBACK} size={22} />
                          <span className="flex-1 truncate font-semibold">{c?.name ?? "Voice"}</span>
                          <span className="font-mono text-[10.5px] text-haze">{LETTERS[k]}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </Popover>
              <ScriptBox
                value={l.text}
                onChange={(t) => setLines((ls) => ls.map((x, k) => (k === i ? { ...x, text: t } : x)))}
                onReady={onFocus}
                onSubmit={onSubmit}
                onEnter={() => onNext(i)}
                autoFocus={focusLine === i}
                label={`Line ${i + 1}, ${v?.name ?? "speaker"}`}
                placeholder={`What ${v?.name ?? "they"} says…`}
                className="py-1 text-[16px] leading-[1.65] text-paper"
              />
              <button type="button" aria-label="Remove line" onClick={() => setLines((ls) => ls.filter((_, k) => k !== i))} className="press mt-1 grid size-7 place-items-center rounded-full text-haze opacity-0 hover:text-paper group-hover:opacity-100 focus:opacity-100">
                <X size={13} />
              </button>
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1.5 px-2.5">
        <span className="text-[12px] font-semibold text-haze">Add a line for</span>
        {cast.map((cid, k) => {
          const c = find(cid);
          return (
            <button
              key={`${cid}-${k}`}
              type="button"
              onClick={() => onAdd(k)}
              className="press inline-flex h-7 items-center gap-1.5 rounded-full bg-white/[0.04] pl-0.5 pr-2.5 text-[12px] font-semibold text-fog shadow-[inset_0_0_0_1px_var(--color-line)] hover:bg-white/[0.08] hover:text-paper"
            >
              <Orb hues={c?.hues ?? FALLBACK} size={22} />
              {c?.name ?? "Voice"}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** The takes, newest first, as lines of the page, day by day. */
function Takes({ takes, onAgain }: { takes: Generation[]; onAgain: (gen: Generation, note: string) => void }) {
  const now = useNow();
  const days = now === null ? [] : groupByDay(takes, now);
  return (
    <section aria-labelledby="takes" className="mx-auto mt-12 max-w-[960px] px-1 sm:mt-16">
      <div className="mb-3 flex items-baseline justify-between gap-3 px-2.5">
        <h2 id="takes" className="font-display text-[24px] sm:text-[28px]">
          Takes {takes.length ? <span className="tabular ml-1 align-middle font-sans text-[13px] font-medium text-haze">{takes.length}</span> : null}
        </h2>
        {takes.length ? (
          <Link href="/library" className="inline-flex items-center gap-1 text-[12.5px] font-semibold text-haze hover:text-paper">
            All in Library <ArrowUpRight size={13} />
          </Link>
        ) : null}
      </div>
      {days.length ? (
        <div className="flex flex-col gap-5">
          {days.map(([day, list]) => (
            <div key={day}>
              <h3 className="mb-0.5 px-2.5 text-[11.5px] font-semibold uppercase tracking-[0.12em] text-haze/80">{day}</h3>
              <ul className="flex flex-col">
                {list.map((g) => (
                  <TakeRow key={g.id} gen={g} onAgain={onAgain} />
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : now === null ? null : (
        <Empty>
          <Wand2 size={20} className="text-haze" />
          <p className="font-display text-[19px]">Your takes play here</p>
          <p className="text-[13.5px] text-haze">Write a line, pick a voice, press Speak. Or start from one of the ideas above.</p>
        </Empty>
      )}
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="squircle grid place-items-center gap-1.5 rounded-[22px] px-6 py-14 text-center shadow-[inset_0_0_0_1px_var(--color-line)]">{children}</div>;
}

/** Takes by the day they were made: Today, Yesterday, then dates. */
function groupByDay(gens: Generation[], now: number): [string, Generation[]][] {
  const out = new Map<string, Generation[]>();
  const today = new Date(now);
  const yesterday = new Date(now - 86_400_000);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  for (const g of gens) {
    const d = new Date(g.createdAt);
    const key = same(d, today) ? "Today" : same(d, yesterday) ? "Yesterday" : d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
    out.set(key, [...(out.get(key) ?? []), g]);
  }
  return [...out.entries()];
}
