"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import type { ReactNode } from "react";
import { Bot, ChartColumn, ChevronLeft, Boxes, HardDrive, KeyRound, Layers, LayoutGrid, Radar, Server, SlidersHorizontal, Sparkles, Stethoscope, type LucideIcon } from "lucide-react";
import { useSetup } from "@/lib/hooks/use-setup";
import { DEMO } from "@/lib/demo/config";
import { cn } from "@/lib/cn";
import { Tape } from "./parts";
import { countReady, gbText, pickMachine } from "./words";
import { findProblems } from "./problems";
import type { SetupSnapshot } from "@/lib/setup/types";

/**
 * Settings: one place for every machine, tool, model, LoRA, key and preference. A rail of sections on the left (with a live
 * fact beside each, so the rail itself reads as a health check); on phones the rail is Settings' home list and each
 * section opens as its own page with a way back.
 */

type Section = { href: string; label: string; icon: LucideIcon; fact?: (s: SetupSnapshot | null, machine: string | null) => ReactNode };

const SECTIONS: Section[] = [
  { href: "/settings", label: "Overview", icon: LayoutGrid },
  {
    href: "/settings/machines",
    label: "Machines",
    icon: Server,
    fact: (s) => (s ? `${s.machines.filter((m) => m.online && !m.metered).length} on` : null),
  },
  {
    href: "/settings/tools",
    label: "Tools",
    icon: Boxes,
    fact: (s, asked) => {
      const m = pickMachine(s, asked);
      return m ? `${countReady(m)} ready` : null;
    },
  },
  { href: "/settings/rent", label: "Rent", icon: Radar },
  { href: "/settings/models", label: "Models", icon: Layers },
  { href: "/settings/loras", label: "LoRAs", icon: Sparkles },
  {
    href: "/settings/storage",
    label: "Storage",
    icon: HardDrive,
    fact: (s, asked) => {
      const m = pickMachine(s, asked);
      if (m?.diskFreeGb == null) return null;
      const low = m.diskFreeGb < 5;
      return <span className={low ? "text-tungsten" : undefined}>{m.diskFreeGb < 0.1 ? "Full" : `${gbText(m.diskFreeGb)} free`}</span>;
    },
  },
  { href: "/settings/usage", label: "Usage", icon: ChartColumn },
  { href: "/settings/accounts", label: "Accounts", icon: KeyRound },
  { href: "/settings/agents", label: "Agents", icon: Bot },
  { href: "/settings/preferences", label: "Preferences", icon: SlidersHorizontal },
];

const DOCTOR: Section = { href: "/settings/doctor", label: "Doctor", icon: Stethoscope };

/** The live demo keeps only the visitor's own keys (Accounts). */
const shown = DEMO ? SECTIONS.filter((s) => s.href === "/settings/accounts") : SECTIONS;

export function SettingsShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const params = useSearchParams();
  const asked = params.get("machine");
  const { snap } = useSetup(!DEMO);
  const isHome = pathname === "/settings";
  const current = [...shown, DOCTOR].find((s) => (s.href === "/settings" ? isHome : pathname.startsWith(s.href)));
  const keep = asked ? `?machine=${encodeURIComponent(asked)}` : "";
  const problems = snap ? countProblems(snap) : 0;

  return (
    <div className="mx-auto flex w-full max-w-[1480px] gap-8 px-4 pb-24 pt-5 sm:px-6 lg:gap-10 lg:px-8 lg:pt-8">
      <aside aria-label="Settings sections" className="hidden w-[208px] shrink-0 self-start lg:sticky lg:top-8 lg:block">
        <p className="mb-3 px-3 font-display text-[22px] uppercase leading-none text-paper">Settings</p>
        <ul className="space-y-0.5">
          {shown.map((s) => (
            <RailItem key={s.href} s={s} on={current?.href === s.href} href={`${s.href}${s.href === "/settings/machines" || s.href === "/settings/tools" || s.href === "/settings/storage" ? keep : ""}`} fact={s.fact?.(snap, asked)} />
          ))}
        </ul>
        {DEMO ? null : (
          <>
            <div className="mx-3 my-3 h-px bg-line" />
            <RailItem
              s={DOCTOR}
              on={current?.href === DOCTOR.href}
              href={DOCTOR.href}
              fact={problems ? <span className="font-semibold text-tally">{problems}</span> : snap ? <span className="text-chroma">All good</span> : null}
            />
          </>
        )}
      </aside>

      <div className="min-w-0 flex-1">
        {/* Phones: a way back to the section list. */}
        {!isHome ? (
          <Link href="/settings" className="mb-3 inline-flex items-center gap-1 text-[13px] font-medium text-haze hover:text-paper lg:hidden">
            <ChevronLeft size={15} /> Settings
          </Link>
        ) : null}
        {children}
        {/* Phones: Overview ends with the section list (the rail's home on small screens). */}
        {isHome ? (
          <nav aria-label="Settings sections" className="mt-10 lg:hidden">
            <ul className="squircle divide-y divide-line overflow-hidden rounded-[16px] shadow-[inset_0_0_0_1px_var(--color-line)]">
              {[...shown.slice(1), ...(DEMO ? [] : [DOCTOR])].map((s) => (
                <li key={s.href}>
                  <Link href={s.href} className="flex h-12 items-center justify-between px-4 text-[14px] font-medium text-paper hover:bg-white/[0.03]">
                    {s.label}
                    <span className="text-[12.5px] text-haze">{s === DOCTOR ? (problems ? `${problems} to look at` : "") : s.fact?.(snap, asked)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        ) : null}
      </div>
    </div>
  );
}

function RailItem({ s, on, href, fact }: { s: Section; on: boolean; href: string; fact?: ReactNode }) {
  return (
    <li className="list-none">
      <Link
        href={href}
        aria-current={on ? "page" : undefined}
        className={cn(
          "squircle relative flex h-[38px] items-center justify-between gap-2 rounded-[12px] px-3 text-[13.5px] font-medium transition-colors duration-150",
          on ? "bg-white/[0.08] text-paper" : "text-fog hover:bg-white/[0.045] hover:text-paper",
        )}
      >
        <span className="flex min-w-0 items-center gap-2.5">
          <s.icon size={15} strokeWidth={2} className={cn("shrink-0 transition-colors", on ? "text-spike" : "text-haze")} />
          <span className="truncate">{s.label}</span>
        </span>
        {fact ? <span className="shrink-0 text-[11.5px] tabular text-haze">{fact}</span> : null}
        {on ? <Tape className="inset-x-auto -bottom-0 left-0 top-[9px] h-[20px] w-[3px]" /> : null}
      </Link>
    </li>
  );
}

/** What the Doctor counts: the same list Overview's "Needs you" shows. */
export function countProblems(snap: SetupSnapshot) {
  return findProblems(snap).length;
}
