"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import type { ReactNode } from "react";
import { Plus, TriangleAlert } from "lucide-react";
import { AppIcon } from "@/components/ui/ToolTile";
import { cn } from "@/lib/cn";
import type { Kit, SetupMachine, SetupSnapshot } from "@/lib/setup/types";
import { machineTone, machineWords, type Tone } from "./words";

/**
 * Settings' small pieces, shared by every section: the tally lamp, the machine strip, a tool's mark that lights up when
 * it's ready, the verdict headline and the one problem card.
 */

const LAMP: Record<Tone, string> = {
  ready: "bg-chroma shadow-[0_0_10px_rgb(90_215_143/0.6)]",
  busy: "bg-daylight shadow-[0_0_10px_rgb(142_197_255/0.65)] motion-safe:animate-pulse",
  needs: "bg-tungsten shadow-[0_0_10px_rgb(242_181_75/0.55)]",
  problem: "bg-tally shadow-[0_0_10px_rgb(255_92_116/0.6)]",
  off: "bg-transparent shadow-[inset_0_0_0_1.5px_var(--color-haze)]",
};

/** A studio tally lamp: steady green ready, blue while working, amber when it needs you, an empty ring when off. */
export function Lamp({ tone, className, label }: { tone: Tone; className?: string; label?: string }) {
  if (tone === "problem") return <TriangleAlert size={13} className={cn("shrink-0 text-tally", className)} aria-label={label} />;
  return <span role={label ? "img" : undefined} aria-label={label} className={cn("inline-block size-2 shrink-0 rounded-full", LAMP[tone], className)} />;
}

/** A link that keeps the page's other query values and sets one. */
export function useHrefWith() {
  const pathname = usePathname();
  const params = useSearchParams();
  return (key: string, value: string | null, path = pathname) => {
    const next = new URLSearchParams(params.toString());
    if (value === null) next.delete(key);
    else next.set(key, value);
    const q = next.toString();
    return q ? `${path}?${q}` : path;
  };
}

/**
 * Every machine Crackio knows, as chips with their lamps: picking one sets the page's machine (?machine=). Spike tape
 * marks the one picked; "All" (when `all`) shows every machine at once.
 */
export function MachineStrip({
  snap,
  selected,
  all,
  allOn,
  addHref = "/settings/machines?add=1",
}: {
  snap: SetupSnapshot;
  selected: string | null;
  all?: boolean;
  allOn?: boolean;
  addHref?: string;
}) {
  const hrefWith = useHrefWith();
  return (
    <nav aria-label="Machines" className="scroll-thin -mx-1 flex items-center gap-1.5 overflow-x-auto px-1 pb-1">
      {snap.machines.map((m) => (
        <MachineChip key={m.id} m={m} on={!allOn && m.id === selected} href={hrefWith("machine", m.id)} />
      ))}
      {all ? (
        <Link
          href={hrefWith("machine", "all")}
          aria-current={allOn ? "page" : undefined}
          className={cn(
            "press squircle relative flex h-11 shrink-0 items-center rounded-[13px] px-3.5 text-[12.5px] font-semibold",
            allOn ? "bg-white/[0.09] text-paper" : "text-fog hover:bg-white/[0.05] hover:text-paper",
          )}
        >
          All
          {allOn ? <Tape /> : null}
        </Link>
      ) : null}
      <Link href={addHref} className="press squircle flex h-11 shrink-0 items-center gap-1.5 rounded-[13px] px-3 text-[12.5px] font-semibold text-haze hover:bg-white/[0.05] hover:text-paper">
        <Plus size={14} /> Add a computer
      </Link>
    </nav>
  );
}

function MachineChip({ m, on, href }: { m: SetupMachine; on: boolean; href: string }) {
  const tone = machineTone(m);
  return (
    <Link
      href={href}
      aria-current={on ? "page" : undefined}
      title={`${m.label} · ${m.where} · ${machineWords(m)}`}
      className={cn(
        "press squircle relative flex h-11 shrink-0 items-center gap-2.5 rounded-[13px] px-3 text-left",
        on ? "bg-white/[0.09] shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)]" : "hover:bg-white/[0.05]",
      )}
    >
      <Lamp tone={tone} />
      <span className="flex min-w-0 flex-col leading-tight">
        <span className={cn("truncate font-display text-[13px] uppercase tracking-[0.01em]", on ? "text-paper" : "text-fog")}>{m.label}</span>
        <span className="truncate text-[11px] text-haze">
          {m.kind === "this-computer" ? "This computer" : m.where}
          {m.gpu?.memoryGb ? ` · ${Math.round(m.gpu.memoryGb)} GB` : ""}
        </span>
      </span>
      {on ? <Tape /> : null}
    </Link>
  );
}

/** Spike tape under the thing that's your pick: a short strip, its ends a little ragged. */
export function Tape({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("absolute inset-x-3 -bottom-[3px] h-[3px] rounded-[1px] bg-spike", className)}
      style={{ clipPath: "polygon(0 15%, 3% 0, 97% 10%, 100% 0, 99% 100%, 96% 85%, 4% 100%, 1% 90%)" }}
    />
  );
}

/** A tool's own mark, lit in its colour when it's ready here and dimmed when it isn't. */
export function KitMark({ kit, lit, size = 34, title }: { kit: Pick<Kit, "glyph" | "hue">; lit: boolean; size?: number; title?: string }) {
  return (
    <span title={title} className={cn("shrink-0 transition-[filter,opacity] duration-300", lit ? "" : "opacity-40 grayscale-[0.9]")}>
      <AppIcon glyph={kit.glyph} hue={kit.hue || undefined} size={size} />
    </span>
  );
}

/** The page's verdict: one line in the display face, the facts under it in small type. */
export function Verdict({ title, facts, aside }: { title: string; facts?: ReactNode; aside?: ReactNode }) {
  return (
    <header className="relative flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      {/* A soft spotlight on the page's title, like a lit set: a gradient, no blur layer. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute -left-16 -top-20 h-[240px] w-[min(760px,90vw)]"
        style={{ background: "radial-gradient(closest-side, rgb(255 91 46 / 0.11), rgb(255 91 46 / 0.04) 55%, transparent)" }}
      />
      <div className="relative min-w-0">
        <h1 className="font-display text-[32px] uppercase leading-[0.95] tracking-[-0.005em] text-paper sm:text-[38px]">{title}</h1>
        {facts ? <p className="mt-2.5 max-w-[78ch] text-[14px] leading-relaxed text-fog">{facts}</p> : null}
      </div>
      {aside ? <div className="relative flex shrink-0 items-center gap-2">{aside}</div> : null}
    </header>
  );
}

/** A section heading inside a page: plain words, one line under it at most. */
export function Heading({ title, note, aside, id }: { title: string; note?: ReactNode; aside?: ReactNode; id?: string }) {
  return (
    <div id={id} className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
      <div>
        <h2 className="text-[15px] font-semibold text-paper">{title}</h2>
        {note ? <p className="mt-0.5 text-[13px] text-haze">{note}</p> : null}
      </div>
      {aside}
    </div>
  );
}

/**
 * One problem, said the same way everywhere: what happened, then one fix that says what it costs. `why` opens under it.
 */
export function ProblemCard({
  tone = "problem",
  title,
  why,
  action,
}: {
  tone?: "problem" | "needs";
  title: ReactNode;
  why?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "squircle flex flex-wrap items-center gap-x-4 gap-y-2 rounded-[16px] px-4 py-3",
        tone === "problem" ? "bg-tally/[0.08] shadow-[inset_0_0_0_1px_rgb(255_92_116/0.18)]" : "bg-tungsten/[0.07] shadow-[inset_0_0_0_1px_rgb(242_181_75/0.16)]",
      )}
    >
      <div className="flex min-w-0 flex-1 items-start gap-2.5">
        {tone === "problem" ? <TriangleAlert size={15} className="mt-0.5 shrink-0 text-tally" /> : <Lamp tone="needs" className="mt-1.5" />}
        <div className="min-w-0">
          <p className="text-[14px] font-medium leading-snug text-paper">{title}</p>
          {why ? <p className="mt-0.5 text-[12.5px] leading-snug text-fog">{why}</p> : null}
        </div>
      </div>
      {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
    </div>
  );
}

/** A thin progress line (bytes or percent), blue like the lamp of something at work. */
export function Progress({ received, total, className }: { received: number; total: number; className?: string }) {
  const pct = total > 0 ? Math.max(2, Math.min(100, (received / total) * 100)) : 0;
  return (
    <span className={cn("block h-1 overflow-hidden rounded-full bg-white/[0.07]", className)}>
      <span className="block h-full rounded-full bg-daylight transition-[width] duration-700 ease-out" style={{ width: `${pct}%` }} />
    </span>
  );
}

/** A skeleton for a page still loading its first look. */
export function Loading({ rows = 4 }: { rows?: number }) {
  return (
    <div className="mt-8 space-y-3" aria-busy="true" aria-label="Loading">
      <div className="skeleton h-10 w-[46%] rounded-[12px]" />
      <div className="skeleton h-5 w-[64%] rounded-[8px]" />
      <div className="mt-6 grid gap-2">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="skeleton h-14 rounded-[14px]" />
        ))}
      </div>
    </div>
  );
}
