"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { create } from "zustand";
import { useSetupStore } from "@/lib/hooks/use-setup";
import { KITS } from "@/lib/setup/kits";
import type { Kit } from "@/lib/setup/types";
import { DEMO } from "@/lib/demo/config";
import { cn } from "@/lib/cn";
import { Lamp } from "./parts";

/**
 * The one small pop-up for a tool that can't run yet: it floats over the page (never pushes the layout), says so in a
 * line, and its button opens that tool in Settings → Tools, where one click sets it up on the machine that runs it best.
 * It reads the same look as Settings (lib/hooks/use-setup), so the two can't disagree. Voice and Lip Sync keep their own
 * set-up pill on their pages for now (their owner's), so this one stays away there.
 */

const OWN_PILL = new Set(["voice", "lipsync"]);

/** Whether this pill is up: another pill at the top of the page (models/GetToolModel) sits under it then. */
export const useTopPills = create<{ setup: boolean }>(() => ({ setup: false }));
const LATER = "crackio:setup-hint-later";
/** Pages with a bar of their own along the top (Storyboard's Editor | Director switch, Motion's turn pill): the pill sits under it. */
const OWN_TOP_BAR = ["/tools/storyboard", "/tools/motion", "/director"];

function kitFor(pathname: string): Kit | null {
  // The longest matching page wins ("/tools/upscale" over "/").
  return [...KITS].filter((k) => k.href !== "/" && (pathname === k.href || pathname.startsWith(`${k.href}/`))).sort((a, b) => b.href.length - a.href.length)[0] ?? null;
}

function readLater(): string[] {
  try {
    return JSON.parse(sessionStorage.getItem(LATER) ?? "[]") as string[];
  } catch {
    return [];
  }
}

export function SetupHint({ pathname }: { pathname: string }) {
  const kit = kitFor(pathname);
  const snap = useSetupStore((s) => s.snap);
  // Read once in the browser: the server never draws the pill (it has no look at the machines), so nothing mismatches.
  const [later, setLater] = useState<string[]>(() => (typeof window === "undefined" ? [] : readLater()));
  const watched = Boolean(kit && !OWN_PILL.has(kit.id) && !DEMO);
  useEffect(() => {
    if (!watched) return;
    const { snap: s, checkedAt } = useSetupStore.getState();
    if (!s || Date.now() - (checkedAt || s.at) > 60_000) void useSetupStore.getState().reload();
  }, [watched, pathname]);

  const up = Boolean(watched && kit && snap && !later.includes(kit.id) && !snap.runsOn[kit.id] && !(kit.cloud && snap.keys.comfy));
  return <Pill up={up} kit={kit} snap={snap} pathname={pathname} later={later} setLater={setLater} />;
}

function Pill({ up, kit, snap, pathname, later, setLater }: { up: boolean; kit: Kit | null; snap: ReturnType<typeof useSetupStore.getState>["snap"]; pathname: string; later: string[]; setLater: (v: string[]) => void }) {
  useEffect(() => {
    useTopPills.setState({ setup: up });
    return () => useTopPills.setState({ setup: false });
  }, [up]);
  if (!up || !kit || !snap) return null;
  const job = snap.jobs.find((j) => (j.state === "running" || j.state === "queued") && j.kits.includes(kit.id));
  const best = snap.recommended[kit.id] ?? null;
  const href = `/settings/tools?${new URLSearchParams({ ...(best ? { machine: best } : {}), tool: kit.id })}`;
  const close = () => {
    const next = [...later, kit.id];
    setLater(next);
    try {
      sessionStorage.setItem(LATER, JSON.stringify(next));
    } catch {
      // Private windows: it comes back next page.
    }
  };
  const step = job?.steps.find((s) => s.state === "running");
  return (
    <div
      className={cn(
        "pointer-events-none fixed inset-x-0 top-16 z-[60] flex justify-center px-4",
        OWN_TOP_BAR.some((p) => pathname === p || pathname.startsWith(`${p}/`)) ? "lg:top-[76px]" : "lg:top-4",
      )}
      role="status"
    >
      <div className="pointer-events-auto flex max-w-[640px] items-center gap-3 rounded-full bg-[#1d1a22]/95 py-1.5 pl-4 pr-1.5 text-[13px] text-fog shadow-[0_12px_40px_rgb(0_0_0/0.45),inset_0_0_0_1px_rgb(255_255_255/0.08)]">
        <Lamp tone={job ? "busy" : "needs"} />
        <span className="min-w-0 truncate">
          {job ? (
            <>
              Setting {kit.name} up on {job.machineLabel}
              {step ? `: ${step.label}` : "…"}
            </>
          ) : (
            <>
              <span className="font-semibold text-paper">{kit.name}</span> isn&rsquo;t ready on your machines yet
            </>
          )}
        </span>
        <Link href={href} className="press shrink-0 rounded-full bg-spike px-3.5 py-1.5 text-[12.5px] font-bold text-spike-ink hover:bg-spike-hi">
          {job ? "See it in Settings" : "Fix in Settings"}
        </Link>
        <button type="button" onClick={close} aria-label="Hide for now" className="press grid size-7 shrink-0 place-items-center rounded-full text-haze hover:bg-white/[0.06] hover:text-paper">
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
