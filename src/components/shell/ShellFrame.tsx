"use client";

import { useEffect, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";
import { Wordmark } from "@/components/brand/Logo";
import { Sidebar } from "./Sidebar";
import { DemoBar } from "@/components/demo/DemoStrip";
import { DEMO } from "@/lib/demo/config";
import { useShell } from "./shell-store";
import { usePauseHiddenMedia, useWarmup } from "./upkeep";
import { cn } from "@/lib/cn";

/** Workspaces that need every pixel get the slim icon rail. */
const WIDE_ROUTES = ["/director", "/tools/storyboard", "/tools/motion"];

export function ShellFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const wide = WIDE_ROUTES.some((r) => pathname.startsWith(r));
  const collapsed = useShell((s) => s.collapsed) || wide;
  const setMobileOpen = useShell((s) => s.setMobileOpen);
  useEffect(() => {
    void useShell.persist.rehydrate();
  }, []);
  usePauseHiddenMedia(pathname);
  useWarmup();

  return (
    // #shell: overlays drawn above the page (the Library's viewer) make it inert while they're up.
    <div id="shell" className="min-h-dvh">
      <Sidebar forceCollapsed={wide} />
      <DemoBar />
      <div
        className={cn(
          "min-h-dvh transition-[padding] duration-300 ease-[var(--ease-out-quint)]",
          collapsed ? "lg:pl-[68px]" : "lg:pl-[var(--sidebar-w)]",
        )}
      >
        {/* Phones and small tablets: a slim bar with the menu. */}
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-line bg-stage/85 px-3 backdrop-blur-xl lg:hidden">
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
        <main id="main" className={DEMO ? "pb-14 lg:pb-0" : undefined}>
          {children}
        </main>
      </div>
    </div>
  );
}
