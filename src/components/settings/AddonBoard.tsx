"use client";

import Image from "next/image";
import { useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import { ArrowUpRight, Check, CornerDownLeft, LoaderCircle, MessagesSquare, Scale, ScanEye, WandSparkles, type LucideIcon } from "lucide-react";
import { Button, ButtonLink } from "@/components/ui/Button";
import { ADDONS, type Addon, type AddonId } from "@/lib/addons";
import { setUp } from "@/lib/hooks/use-setup";
import { useSettings } from "@/lib/hooks/use-settings";
import type { ReqStatus, SetupJob, SetupMachine } from "@/lib/setup/types";
import { cn } from "@/lib/cn";
import { Heading, Lamp, Progress } from "./parts";
import { bytesText, fits, gbText, type Tone } from "./words";

/**
 * Settings → Tools → Add-ons: the tools' board again, for the small extras a tool can do without (lib/addons). A card
 * is a tool's card: its picture, where it stands on the machine picked, one line, one button that gets it (a set-up of
 * just that requirement). Pointing at a card plays what the add-on does over the picture; at rest the picture is left
 * alone. The prompt enhancer can be tried under the board once it's there.
 */

const ICON: Record<AddonId, LucideIcon> = { enhance: WandSparkles, judge: Scale, eyes: ScanEye, chat: MessagesSquare };

export const addonStatus = (m: SetupMachine, a: Addon): ReqStatus | undefined => m.tools[a.kit]?.reqs.find((r) => r.id === a.req);

/** Where an add-on stands on a machine, in the two words of its pill. */
function addonWords(m: SetupMachine, status: ReqStatus | undefined): { label: string; tone: Tone } {
  if (!m.online) return { label: "Not answering", tone: "off" };
  if (m.metered) return { label: "Not for this machine", tone: "off" };
  switch (status?.state) {
    case "ready":
      return { label: "Ready", tone: "ready" };
    case "installing":
      return { label: "Setting up", tone: "busy" };
    case "unpublished":
      return { label: "Coming soon", tone: "off" };
    case "needs-key":
      return { label: "Needs a key", tone: "needs" };
    case "outdated":
      return { label: "Needs an update", tone: "needs" };
    case "broken":
      return { label: "Stopped", tone: "problem" };
    case "unsupported":
    case "blocked":
      return { label: "Not for this machine", tone: "off" };
    default:
      return { label: "Not set up", tone: "off" };
  }
}

export function AddonBoard({ m, live }: { m: SetupMachine; live: SetupJob | null }) {
  const enhancer = ADDONS[0];
  return (
    <>
      {/* Four in a row where they fit, else two by two: never three and one left over. */}
      <div className="@container">
        <ul className="grid grid-cols-1 gap-3 @xl:grid-cols-2 @5xl:grid-cols-4">
          {ADDONS.map((a) => (
            <AddonCard key={a.id} addon={a} m={m} live={live} />
          ))}
        </ul>
      </div>
      {m.online && addonStatus(m, enhancer)?.state === "ready" ? <TryEnhancer /> : null}
    </>
  );
}

/** The ready glow in the add-on's colour, as on the tools' cards. */
const glow = (hue: string): CSSProperties => ({ boxShadow: `0 0 0 1px color-mix(in oklab, ${hue} 42%, transparent), 0 26px 60px -34px ${hue}` });

function AddonCard({ addon, m, live }: { addon: Addon; m: SetupMachine; live: SetupJob | null }) {
  const Icon = ICON[addon.id];
  const status = addonStatus(m, addon);
  const words = addonWords(m, status);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lit = m.online && status?.state === "ready";
  const bytes = status?.plan?.bytes ?? 0;

  async function get() {
    setBusy(true);
    setError(null);
    const r = await setUp(m.id, [addon.kit], undefined, undefined, [addon.req]);
    setError(r.error);
    setBusy(false);
  }

  let action: ReactNode = null;
  if (m.online && !m.metered && status) {
    if (status.state === "ready") {
      action = (
        <ButtonLink href={addon.usedIn.href} variant="ghost" size="sm">
          Open <ArrowUpRight size={13} />
        </ButtonLink>
      );
    } else if (status.state === "needs-key") {
      action = (
        <ButtonLink href="/settings/accounts#hf" variant="outline" size="sm">
          Add the key
        </ButtonLink>
      );
    } else if (status.fix === "bridge") {
      action = (
        <ButtonLink href={`/settings/machines?machine=${encodeURIComponent(m.id)}`} variant="ghost" size="sm">
          How to update
        </ButtonLink>
      );
    } else if (status.plan && status.state !== "installing") {
      action = !fits(m, bytes) ? (
        <ButtonLink href={`/settings/storage?machine=${encodeURIComponent(m.id)}`} variant="ghost" size="sm" title={`Needs ${bytesText(bytes)}; ${gbText(m.diskFreeGb)} free`}>
          Make room · {bytesText(bytes)}
        </ButtonLink>
      ) : (
        <Button variant="outline" size="sm" onClick={() => void get()} disabled={busy || Boolean(live)}>
          {busy ? <LoaderCircle size={14} className="animate-spin" /> : null}
          {status.state === "broken" ? "Try again" : `Get it · ${bytesText(bytes)}`}
        </Button>
      );
    }
  }

  return (
    <li className="addon-card group relative">
      <div
        className={cn("squircle relative flex h-full flex-col overflow-hidden rounded-[20px] bg-apple transition-[box-shadow,transform] duration-300", !lit && "shadow-[inset_0_0_0_1px_var(--color-line)]")}
        style={lit ? glow(addon.hue) : undefined}
      >
        <div className="relative aspect-[16/10] w-full overflow-hidden">
          <Image
            src={addon.media}
            alt=""
            fill
            sizes="(min-width: 1536px) 25vw, (min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw"
            className={cn("object-cover transition-[filter,opacity,transform] duration-500", lit ? "" : "opacity-45 grayscale-[0.9] group-hover:opacity-75 group-hover:grayscale-[0.3]")}
          />
          <span className="pointer-events-none absolute inset-0 bg-gradient-to-t from-apple via-apple/25 to-transparent" />
          {/* The preview's own dusk: the picture steps back while the add-on shows what it does. */}
          <span className="addon-dusk pointer-events-none absolute inset-0 bg-black/35" />
          <Demo id={addon.id} hue={addon.hue} />
          <span className="absolute left-3 top-3 inline-flex items-center gap-1.5 rounded-full bg-black/55 px-2.5 py-1 text-[11.5px] font-semibold text-paper shadow-[inset_0_0_0_1px_rgb(255_255_255/0.1)]">
            <Lamp tone={words.tone} />
            {words.label}
          </span>
        </div>
        <div className="relative -mt-6 flex flex-1 flex-col px-4 pb-4">
          <span
            aria-hidden="true"
            className={cn("app-icon transition-[filter,opacity]", !lit && "opacity-75 grayscale-[0.5]")}
            style={{ "--hue": addon.hue, width: 38, height: 38, borderRadius: 13 } as CSSProperties}
          >
            <Icon size={19} strokeWidth={2} className="text-white drop-shadow-[0_1px_1px_rgb(0_0_0/0.35)]" />
          </span>
          <h3 className="mt-2.5 font-display text-[19px] uppercase leading-none tracking-[0.005em] text-paper">{addon.name}</h3>
          <p className="mt-1.5 min-h-[2.6em] text-[12.5px] leading-snug text-haze">{status?.state === "installing" ? status.why || "Setting it up" : addon.summary}</p>
          {status?.state === "installing" && status.progress ? <Progress received={status.progress.received} total={status.progress.total} className="mt-2" /> : null}
          <div className="mt-auto flex min-h-8 items-center justify-between gap-2 pt-3">
            <span className="truncate text-[11.5px] text-haze">{status?.state === "unpublished" ? "Arrives with the next release" : `For ${addon.usedIn.label}`}</span>
            {action}
          </div>
          {error ? <p className="mt-2 text-[12px] text-tally">{error}</p> : null}
        </div>
      </div>
    </li>
  );
}

/* ---------------------------------------------------------------- previews */

/** One beat of a preview: it comes in `at` ms after the card is pointed at (globals.css `.addon-beat`). */
const beat = (at: number): CSSProperties => ({ "--at": `${at}ms` }) as CSSProperties;
/** Every beat is the same quiet chip: dark glass, small words. The add-on's colour only marks, it never fills. */
const chip = "addon-beat inline-flex max-w-full items-center gap-1.5 rounded-[9px] bg-black/65 px-2 py-[5px] text-[11.5px] font-medium leading-tight text-paper shadow-[inset_0_0_0_1px_rgb(255_255_255/0.1)]";

/** What the add-on does, in two or three beats over its picture: words written out, a frame checked, things found, an answer. */
function Demo({ id, hue }: { id: AddonId; hue: string }) {
  const frame = "pointer-events-none absolute inset-x-3 bottom-9 flex flex-col gap-1.5";
  if (id === "enhance") {
    return (
      <div className={cn(frame, "items-start")} aria-hidden="true">
        <span className={cn(chip, "font-mono")} style={beat(0)}>
          a dog on a beach
        </span>
        <span className={chip} style={beat(260)}>
          <span className="line-clamp-2">A dog on a beach. Bright late-afternoon sunlight washes across a low eye-level view.</span>
        </span>
      </div>
    );
  }
  if (id === "judge") {
    const tick = <Check size={12} strokeWidth={3} className="shrink-0 text-chroma" />;
    return (
      <div className={cn(frame, "items-start")} aria-hidden="true">
        <span className={chip} style={beat(0)}>
          {tick}Character swapped in
        </span>
        <span className={chip} style={beat(260)}>
          {tick}Pose kept
        </span>
      </div>
    );
  }
  if (id === "eyes") {
    const box = (label: string, at: number, style: CSSProperties) => (
      <span className="addon-beat absolute rounded-[8px] shadow-[inset_0_0_0_1.5px_rgb(255_255_255/0.85)]" style={{ ...beat(at), ...style }}>
        <span className="absolute -top-px left-0 rounded-[7px_0_7px_0] px-1.5 py-[3px] text-[10.5px] font-semibold leading-none text-[#16131b]" style={{ background: hue }}>
          {label}
        </span>
      </span>
    );
    return (
      <div className="pointer-events-none absolute inset-0" aria-hidden="true">
        {box("mirror", 0, { left: "66%", top: "8%", width: "30%", height: "33%" })}
        {box("armchair", 260, { left: "27%", top: "47%", width: "40%", height: "36%" })}
      </div>
    );
  }
  return (
    <div className={frame} aria-hidden="true">
      <span className={cn(chip, "self-end")} style={beat(0)}>
        What should I film today?
      </span>
      <span className={cn(chip, "self-start")} style={beat(260)}>
        <span className="flex h-3 shrink-0 items-center gap-[2px]">
          {[5, 11, 7, 12, 6].map((h, i) => (
            <span key={i} className="w-[2px] rounded-full" style={{ height: h, background: hue }} />
          ))}
        </span>
        Golden hour, by the river.
      </span>
    </div>
  );
}

/* ---------------------------------------------------------------- try it */

/** Type a few words, see the prompt the enhancer writes and how long it took; and whether it writes your prompts. */
function TryEnhancer() {
  const { settings, patch } = useSettings();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<{ prompt?: string; ms?: number; on?: string; error?: string } | null>(null);
  const on = (settings?.promptEnhancer ?? "auto") !== "off";

  async function go(e: FormEvent) {
    e.preventDefault();
    if (!text.trim() || busy) return;
    setBusy(true);
    const res = await fetch("/api/addons/try", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) }).catch(() => null);
    const body = res ? ((await res.json().catch(() => ({}))) as { prompt?: string; ms?: number; on?: string; error?: string }) : { error: "Crackio didn't answer." };
    setOut(res?.ok ? body : { error: body.error ?? "That didn't work." });
    setBusy(false);
  }

  return (
    <section className="squircle mt-6 max-w-[860px] rounded-[20px] bg-white/[0.035] p-5 shadow-[inset_0_0_0_1px_var(--color-line)]">
      <Heading title="Try the prompt enhancer" note="Type a few words, in any language, and see the prompt it writes." />
      <form onSubmit={go} className="mt-3.5 flex items-center gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="sunset · a dog on a beach · anime train crossing"
          aria-label="A few words to try the prompt enhancer with"
          maxLength={2000}
          className="h-10 min-w-0 flex-1 rounded-[12px] bg-black/25 px-3.5 text-[14px] text-paper shadow-[inset_0_0_0_1px_var(--color-line)] outline-none placeholder:text-haze focus:shadow-[inset_0_0_0_1px_var(--color-line-strong)]"
        />
        <Button type="submit" variant="secondary" size="md" disabled={busy || !text.trim()} aria-label="Enhance">
          {busy ? <LoaderCircle size={15} className="animate-spin" aria-hidden="true" /> : <CornerDownLeft size={15} aria-hidden="true" />}
          Enhance
        </Button>
      </form>
      {out?.prompt ? (
        <div className="mt-3.5" aria-live="polite">
          <p className="text-[14px] leading-relaxed text-paper">{out.prompt}</p>
          <p className="mt-1.5 text-[12px] tabular text-haze">
            {((out.ms ?? 0) / 1000).toFixed(1)} s{out.on ? ` on ${out.on}` : ""}
          </p>
        </div>
      ) : out?.error ? (
        <p className="mt-3 text-[13px] text-tally" aria-live="polite">
          {out.error}
        </p>
      ) : null}
      <button
        type="button"
        role="switch"
        aria-checked={on}
        onClick={() => void patch({ promptEnhancer: on ? "off" : "auto" })}
        className="mt-4 inline-flex items-center gap-3 text-[13.5px] font-medium text-paper"
      >
        <span className={cn("relative h-[22px] w-10 rounded-full transition-colors", on ? "bg-spike" : "bg-gaffer")}>
          <span className={cn("absolute left-[3px] top-[3px] size-4 rounded-full bg-paper transition-transform duration-200", on && "translate-x-[18px]")} />
        </span>
        Write my prompts with it when Enhance is on
      </button>
    </section>
  );
}
