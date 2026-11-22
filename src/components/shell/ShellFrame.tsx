"use client";

import { useEffect, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { MotionConfig } from "motion/react";
import { Menu } from "lucide-react";
import { Wordmark } from "@/components/brand/Logo";
import { cn } from "@/lib/cn";
import { Sidebar } from "./Sidebar";
import { DemoBar } from "@/components/demo/DemoStrip";
import { DEMO } from "@/lib/demo/config";
import { useMotionPref } from "@/lib/motion-pref";
import { useShell } from "./shell-store";
import { usePauseHiddenMedia, useWarmup } from "./upkeep";
import { SetupHint } from "@/components/settings/SetupHint";
import { Notifier } from "@/components/settings/Notifier";

export function ShellFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const setMobileOpen = useShell((s) => s.setMobileOpen);
  // Calm turns off motion/react's movement too; System and Full leave it as it is (globals.css handles the CSS).
  const calm = useMotionPref() === "calm";
  useEffect(() => {
    void useShell.persist.rehydrate();
  }, []);
  usePauseHiddenMedia(pathname);
  useWarmup();

  return (
    <MotionConfig reducedMotion={calm ? "always" : "never"}>
      {/* #shell: overlays drawn above the page (the Library's viewer) make it inert while they're up. */}
      <div id="shell" className="min-h-dvh">
        <a
          href="#main"
          className="sr-only z-[95] rounded-[10px] bg-paper px-3 py-2 text-[13px] font-semibold text-stage focus:not-sr-only focus:fixed focus:left-3 focus:top-3"
        >
          Skip to content
        </a>
        <Sidebar />
        <DemoBar />
        {/* The rail is always the same width, so the page never has to re-lay itself out around it. */}
        <div className="min-h-dvh lg:pl-[var(--sidebar-w)]">
          {/* Phones and small tablets: a slim bar with the menu. The Director goes full screen there (its own menu
              button sits on the stage): the bar took a seventh of a phone held sideways. */}
          <header className={cn("sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-line bg-stage/95 px-3 lg:hidden", pathname === "/director" && "hidden")}>
            <button
              onClick={() => setMobileOpen(true)}
              className="grid size-10 place-items-center rounded-[10px] text-fog hover:bg-white/[0.05] hover:text-paper"
              aria-label="Open menu"
            >
              <Menu size={19} />
            </button>
            <Link href="/" className="flex items-center" aria-label="Crackio home">
              <Wordmark size={18} />
            </Link>
          </header>
          {/* Phones in the live demo: room for its bar along the bottom. */}
          <main id="main" tabIndex={-1} className={DEMO ? "pb-14 outline-none lg:pb-0" : "outline-none"}>
            {children}
          </main>
          {/* A tool that can't run yet: one small pill that opens its fix in Settings. */}
          <SetupHint pathname={pathname} />
          {DEMO ? null : <Notifier />}
        </div>
      </div>
    </MotionConfig>
  );
}
