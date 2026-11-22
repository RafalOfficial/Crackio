"use client";

import Image, { getImageProps } from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  ArrowUpRight,
  Dumbbell,
  Film,
  House,
  ImageIcon,
  LayoutGrid,
  LayoutTemplate,
  LibraryBig,
  Settings,
  Workflow,
  X,
  type LucideIcon,
} from "lucide-react";
import { LogoMark, Wordmark } from "@/components/brand/Logo";
import { TOOLS, type Tool, type ToolSlug } from "@/lib/tools";
import { cn } from "@/lib/cn";
import { useShell } from "./shell-store";
import { warmLibrary } from "./upkeep";
import { useSetupStore } from "@/lib/hooks/use-setup";
import { isLive, useGenerations } from "@/lib/hooks/use-generations";
import { findProblems } from "@/components/settings/problems";
import { DEMO, DEMO_FULL, demoPage, demoToolSlug } from "@/lib/demo/config";
import { DemoCard } from "@/components/demo/DemoStrip";

type Page = { href: string; label: string; icon: LucideIcon };

/** The rail, top to bottom: pages, the Tools drawer after Video, then Library and Templates; ComfyUI and Settings sit at the foot. */
const BEFORE_TOOLS: Page[] = [
  { href: "/", label: "Home", icon: House },
  { href: "/create", label: "Image", icon: ImageIcon },
  { href: "/video", label: "Video", icon: Film },
];
const AFTER_TOOLS: Page[] = [
  { href: "/library", label: "Library", icon: LibraryBig },
  { href: "/templates", label: "Templates", icon: LayoutTemplate },
  // LoRAs of your own, trained from your pictures (components/train).
  { href: "/train", label: "Train", icon: Dumbbell },
];
const COMFY: Page = { href: "/comfy", label: "ComfyUI", icon: Workflow };
const SETTINGS: Page = { href: "/settings", label: "Settings", icon: Settings };

/** The drawer's three plain groups. */
const GROUPS: { name: string; slugs: ToolSlug[] }[] = [
  { name: "Create", slugs: ["director", "storyboard", "motion", "product"] },
  { name: "Edit", slugs: ["retouch", "relight", "angles", "upscale", "recast", "lipsync"] },
  { name: "People and sound", slugs: ["cast", "voice"] },
];
/** Where each tool's picture is cropped in its card, so the person in it stays in the frame. */
const FRAMING: Partial<Record<ToolSlug, string>> = { recast: "50% 18%", cast: "50% 6%" };

/** The live demo shows only its own pages and tools (lib/demo). */
const shown = (page: Page) => !DEMO || demoPage(page.href);
const shownTool = (tool: Tool) => !DEMO || Boolean(demoToolSlug(tool.slug));
const showSettings = !DEMO || DEMO_FULL;

let warmed = false;
/** The drawer's pictures, fetched once before it first opens (pointing at Tools, or when the page is idle), so it opens full. */
function warmToolPictures() {
  if (warmed || typeof window === "undefined") return;
  warmed = true;
  for (const t of TOOLS) {
    const { props } = getImageProps({ src: t.media, alt: "", fill: true, sizes: "180px", quality: 70 });
    const img = new window.Image();
    img.decoding = "async";
    if (props.sizes) img.sizes = props.sizes;
    if (props.srcSet) img.srcset = props.srcSet;
    img.src = props.src;
  }
}

const isOn = (pathname: string, href: string) => (href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`));
const toolAt = (pathname: string) => TOOLS.find((t) => isOn(pathname, t.href));

/**
 * Crackio's navigation. On a computer: a slim rail of icons with their names, the one you're on held in a raised
 * button that slides from place to place; Tools opens a drawer of every tool beside it. On a phone: a menu sheet.
 */
export function Sidebar() {
  const pathname = usePathname();
  const tool = toolAt(pathname);
  const [drawer, setDrawer] = useState(false);
  // Going somewhere else (a link, Back) closes the drawer.
  const [at, setAt] = useState(pathname);
  if (at !== pathname) {
    setAt(pathname);
    setDrawer(false);
  }
  const toolsButton = useRef<HTMLButtonElement>(null);
  const closeDrawer = useCallback((returnFocus: boolean) => {
    setDrawer(false);
    if (returnFocus) toolsButton.current?.focus({ preventScroll: true });
  }, []);

  return (
    <>
      <Rail pathname={pathname} tool={tool} drawer={drawer} onTools={() => setDrawer((open) => !open)} toolsButton={toolsButton} />
      <ToolsDrawer open={drawer} current={tool} onClose={closeDrawer} />
      <PhoneMenu pathname={pathname} tool={tool} />
    </>
  );
}

function Rail({
  pathname,
  tool,
  drawer,
  onTools,
  toolsButton,
}: {
  pathname: string;
  tool: Tool | undefined;
  drawer: boolean;
  onTools: () => void;
  toolsButton: React.RefObject<HTMLButtonElement | null>;
}) {
  const running = useGenerations((s) => s.items.reduce((n, g) => n + (isLive(g) ? 1 : 0), 0));
  const list = useRef<HTMLDivElement>(null);
  const selected = tool || drawer ? "tools" : [...BEFORE_TOOLS, ...AFTER_TOOLS, COMFY, SETTINGS].find((p) => isOn(pathname, p.href))?.href;
  const [spot, setSpot] = useState<number | null>(null);
  // The raised button sits under the item you're on; it only glides once it has been placed (no slide in from the top).
  const [ready, setReady] = useState(false);

  useLayoutEffect(() => {
    const box = list.current;
    if (!box) return;
    const place = () => {
      const item = selected ? box.querySelector<HTMLElement>(`[data-nav="${selected}"]`) : null;
      const y = item ? item.offsetTop : null;
      setSpot((was) => (was === y ? was : y));
    };
    place();
    // The foot items move with the window's height.
    const watch = new ResizeObserver(place);
    watch.observe(box);
    return () => watch.disconnect();
  }, [selected]);

  useEffect(() => {
    const id = requestAnimationFrame(() => setReady(true));
    // Once the page has settled, the tools drawer's pictures come in the background.
    const warm = setTimeout(() => {
      if ("requestIdleCallback" in window) window.requestIdleCallback(warmToolPictures, { timeout: 5000 });
      else warmToolPictures();
    }, 4000);
    return () => {
      cancelAnimationFrame(id);
      clearTimeout(warm);
    };
  }, []);

  return (
    <nav aria-label="Main navigation" className="nav-rail fixed inset-y-0 left-0 z-50 hidden w-[76px] flex-col lg:flex" data-ready={ready || undefined}>
      <Link href="/" aria-label="Crackio home" className="mx-auto mb-4 mt-5 grid h-7 place-items-center">
        <LogoMark size={20} />
      </Link>
      <div ref={list} className="relative flex flex-1 flex-col items-center gap-1 pb-3">
        {spot !== null ? <span aria-hidden="true" className="nav-selected" style={{ transform: `translateY(${spot}px)` }} /> : null}
        {BEFORE_TOOLS.filter(shown).map((page) => (
          <RailLink key={page.href} page={page} active={selected === page.href} />
        ))}
        <button
          ref={toolsButton}
          type="button"
          onClick={onTools}
          onPointerEnter={warmToolPictures}
          onFocus={warmToolPictures}
          data-nav="tools"
          data-active={selected === "tools" || undefined}
          aria-expanded={drawer}
          aria-controls="tools-drawer"
          aria-haspopup="dialog"
          aria-label={tool ? `Tools (you're in ${tool.name})` : "Tools"}
          className="nav-item"
          style={{ "--hue": tool?.hue ?? "var(--color-spike)" } as CSSProperties}
        >
          {/* Always "Tools": inside a tool it takes that tool's colour, so it reads as where the tools live. */}
          <LayoutGrid size={20} strokeWidth={1.75} aria-hidden="true" />
          <span className="nav-label">Tools</span>
        </button>
        {AFTER_TOOLS.filter(shown).map((page) => (
          <RailLink key={page.href} page={page} active={selected === page.href} onIntent={page.href === "/library" ? warmLibrary : undefined}>
            {page.href === "/library" && running ? (
              <span className="nav-badge" aria-label={`${running} running`}>
                {running > 9 ? "9+" : running}
              </span>
            ) : null}
          </RailLink>
        ))}
        <div className="flex-1" />
        {/* The live demo's access code and credits left. */}
        <DemoCard collapsed />
        {shown(COMFY) ? <RailLink page={COMFY} active={selected === COMFY.href} /> : null}
        {showSettings ? (
          <RailLink page={SETTINGS} active={selected === SETTINGS.href}>
            <SettingsLamp />
          </RailLink>
        ) : null}
      </div>
    </nav>
  );
}

function RailLink({ page, active, onIntent, children }: { page: Page; active: boolean; onIntent?: () => void; children?: ReactNode }) {
  const Icon = page.icon;
  return (
    <Link
      href={page.href}
      onPointerEnter={onIntent}
      onFocus={onIntent}
      data-nav={page.href}
      data-active={active || undefined}
      aria-current={active ? "page" : undefined}
      className="nav-item"
      style={{ "--hue": "var(--color-spike)" } as CSSProperties}
    >
      <Icon size={20} strokeWidth={1.75} aria-hidden="true" />
      <span className="nav-label">{page.label}</span>
      {children}
    </Link>
  );
}

/**
 * Settings' health at a glance: green when all is well, blue while something sets up, amber with a count when
 * something needs you. It looks once the page is idle (Settings' own pages keep it fresh).
 */
function SettingsLamp() {
  const snap = useSetupStore((s) => s.snap);
  useEffect(() => {
    if (DEMO) return;
    const look = () => {
      const { checkedAt } = useSetupStore.getState() as { checkedAt?: number };
      if (!checkedAt || Date.now() - checkedAt > 60_000) void useSetupStore.getState().reload();
    };
    if ("requestIdleCallback" in window) {
      const id = window.requestIdleCallback(look, { timeout: 4000 });
      return () => window.cancelIdleCallback(id);
    }
    const id = setTimeout(look, 1500);
    return () => clearTimeout(id);
  }, []);
  if (!snap) return null;
  const problems = findProblems(snap).length;
  const busy = snap.jobs.some((j) => j.state === "running" || j.state === "queued");
  const tone = busy ? "busy" : problems ? "warn" : "ok";
  const say = busy ? "Setting up…" : problems ? `${problems} ${problems === 1 ? "thing needs" : "things need"} you` : "All set";
  return (
    <>
      <span className="nav-lamp" data-tone={tone} aria-hidden="true">
        {tone === "warn" ? problems : null}
      </span>
      <span className="nav-tip" role="tooltip">
        <b>{say}</b>
        <span>{busy ? "Open Settings to follow it" : problems ? "Open Settings to fix it" : "Your machines are ready"}</span>
      </span>
      <span className="sr-only">: {say}</span>
    </>
  );
}

/** Every tool, as cards with their pictures, beside the rail. */
function ToolsDrawer({ open, current, onClose }: { open: boolean; current: Tool | undefined; onClose: (returnFocus: boolean) => void }) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  useEffect(() => {
    if (!open) return;
    // Focus lands on the tool you're in, or the first one, so the keyboard carries on from there.
    const id = requestAnimationFrame(() => {
      const target = panel.current?.querySelector<HTMLElement>('[aria-current="page"]') ?? panel.current?.querySelector<HTMLElement>("a");
      target?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(id);
  }, [open]);

  let order = 0;
  return (
    <AnimatePresence>
      {open ? (
        <>
          <motion.button
            key="tools-scrim"
            type="button"
            tabIndex={-1}
            aria-label="Close tools"
            onClick={() => onClose(false)}
            className="fixed inset-y-0 left-[76px] right-0 z-[48] hidden cursor-default bg-black/50 lg:block"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          />
          <motion.div
            key="tools-drawer"
            ref={panel}
            id="tools-drawer"
            role="dialog"
            aria-label="Tools"
            className="tools-drawer scroll-thin fixed inset-y-0 left-[76px] z-[49] hidden w-[392px] flex-col overflow-y-auto px-[18px] pb-5 pt-[22px] lg:flex"
            initial={{ opacity: 0, x: -18 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -12, transition: { duration: 0.16, ease: [0.4, 0, 1, 1] } }}
            transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="mx-0.5 flex h-[26px] items-center justify-between">
              <h2 className="font-display text-[20px] leading-none">Tools</h2>
              <button
                type="button"
                onClick={() => onClose(true)}
                aria-label="Close tools"
                className="press squircle grid size-7 place-items-center rounded-[9px] text-haze hover:bg-white/[0.07] hover:text-paper"
              >
                <X size={16} />
              </button>
            </div>
            {GROUPS.map((group) => {
              const tools = group.slugs.map((slug) => TOOLS.find((t) => t.slug === slug)).filter((t): t is Tool => Boolean(t && shownTool(t)));
              if (!tools.length) return null;
              return (
                <section key={group.name} aria-label={group.name}>
                  <p className="label mx-0.5 mb-[9px] mt-[18px]">{group.name}</p>
                  <div className="grid grid-cols-2 gap-2.5">
                    {tools.map((t) => {
                      const Icon = t.icon;
                      const here = current?.slug === t.slug;
                      return (
                        <Link
                          key={t.slug}
                          href={t.href}
                          aria-current={here ? "page" : undefined}
                          onClick={() => onClose(false)}
                          className="tool-card"
                          style={{ "--hue": t.hue, "--d": `${30 + 18 * order++}ms` } as CSSProperties}
                        >
                          <span className="tool-card-thumb">
                            <Image
                              src={t.media}
                              alt=""
                              fill
                              sizes="180px"
                              quality={70}
                              className="object-cover"
                              style={FRAMING[t.slug] ? { objectPosition: FRAMING[t.slug] } : undefined}
                            />
                          </span>
                          <span className="flex h-8 items-center gap-2 pl-[5px] pr-1.5">
                            <Icon size={15} strokeWidth={2} className="shrink-0 text-[var(--hue)]" aria-hidden="true" />
                            <span className="flex-1 truncate text-[13px] font-semibold text-paper">{t.name}</span>
                            <ArrowUpRight size={13} strokeWidth={2.2} className="tool-card-go" aria-hidden="true" />
                          </span>
                        </Link>
                      );
                    })}
                  </div>
                </section>
              );
            })}
          </motion.div>
        </>
      ) : null}
    </AnimatePresence>
  );
}

/** Phones and small tablets: the same places in a sheet from the left, opened from the top bar's menu button. */
function PhoneMenu({ pathname, tool }: { pathname: string; tool: Tool | undefined }) {
  const open = useShell((s) => s.mobileOpen);
  const setOpen = useShell((s) => s.setMobileOpen);
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    const root = document.documentElement;
    const was = root.style.overflow;
    root.style.overflow = "hidden";
    const id = requestAnimationFrame(() => close.current?.focus({ preventScroll: true }));
    return () => {
      window.removeEventListener("keydown", onKey);
      root.style.overflow = was;
      cancelAnimationFrame(id);
    };
  }, [open, setOpen]);

  const row = (href: string, label: string, Icon: LucideIcon, hue?: string) => {
    const active = tool ? tool.href === href : isOn(pathname, href);
    return (
      <li key={href}>
        <Link
          href={href}
          onClick={() => setOpen(false)}
          aria-current={active ? "page" : undefined}
          className={cn(
            "squircle flex h-11 items-center gap-3 rounded-[12px] px-3 text-[14.5px] font-medium transition-colors",
            active ? "bg-white/[0.08] text-paper shadow-[inset_0_0_0_1px_rgb(255_255_255/0.07)]" : "text-fog hover:bg-white/[0.045] hover:text-paper",
          )}
        >
          <Icon size={19} strokeWidth={1.75} style={hue ? { color: hue } : undefined} className={hue ? undefined : active ? "text-spike" : "text-haze"} aria-hidden="true" />
          {label}
        </Link>
      </li>
    );
  };

  return (
    <AnimatePresence>
      {open ? (
        <>
          <motion.button
            key="menu-scrim"
            type="button"
            tabIndex={-1}
            aria-label="Close menu"
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-40 cursor-default bg-black/60 lg:hidden"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          />
          <motion.nav
            key="menu"
            aria-label="Main navigation"
            className="scroll-thin fixed inset-y-0 left-0 z-50 flex w-[300px] max-w-[86vw] flex-col overflow-y-auto bg-stage shadow-[inset_-1px_0_0_rgb(255_255_255/0.06)] lg:hidden"
            initial={{ x: "-100%" }}
            animate={{ x: 0 }}
            exit={{ x: "-100%", transition: { duration: 0.2, ease: [0.4, 0, 1, 1] } }}
            transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="flex h-14 shrink-0 items-center justify-between px-4">
              <Link href="/" onClick={() => setOpen(false)} aria-label="Crackio home">
                <Wordmark size={18} />
              </Link>
              <button
                ref={close}
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close menu"
                className="press squircle grid size-9 place-items-center rounded-[10px] text-haze hover:bg-white/[0.06] hover:text-paper"
              >
                <X size={18} />
              </button>
            </div>
            <ul className="space-y-0.5 px-2.5">{[...BEFORE_TOOLS, ...AFTER_TOOLS].filter(shown).map((p) => row(p.href, p.label, p.icon))}</ul>
            <p className="label mx-5 mb-1.5 mt-5">Tools</p>
            <ul className="space-y-0.5 px-2.5">{TOOLS.filter(shownTool).map((t) => row(t.href, t.name, t.icon, t.hue))}</ul>
            <div className="mt-auto space-y-0.5 px-2.5 pb-4 pt-5">
              <DemoCard collapsed={false} />
              <ul className="space-y-0.5">
                {shown(COMFY) ? row(COMFY.href, COMFY.label, COMFY.icon) : null}
                {showSettings ? row(SETTINGS.href, SETTINGS.label, SETTINGS.icon) : null}
              </ul>
            </div>
          </motion.nav>
        </>
      ) : null}
    </AnimatePresence>
  );
}
