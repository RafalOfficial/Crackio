"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { PanelLeft, X } from "lucide-react";
import { LogoMark, Wordmark } from "@/components/brand/Logo";
import { NavTile, ToolTile } from "@/components/ui/ToolTile";
import { TOOLS } from "@/lib/tools";
import { cn } from "@/lib/cn";
import { useShell } from "./shell-store";
import { useConnections } from "@/lib/hooks/use-connections";
import { DEMO, DEMO_FULL, demoPage, demoToolSlug } from "@/lib/demo/config";
import { DemoCard } from "@/components/demo/DemoStrip";

/** Glyph images live in public/icons (scripts/assets/icons.mjs); tools carry theirs in TOOLS. */
const primary = [
  { href: "/", label: "Home", glyph: "/icons/home.png" },
  { href: "/create", label: "Image", glyph: "/icons/image.png" },
  { href: "/video", label: "Video", glyph: "/icons/video.png" },
  { href: "/templates", label: "Templates", glyph: "/icons/templates.png" },
  { href: "/library", label: "Library", glyph: "/icons/library.png" },
  { href: "/local", label: "Local", glyph: "/icons/local.png" },
  { href: "/comfy", label: "ComfyUI", glyph: "/icons/comfy.png" },
];

/** The live demo shows only its own pages and tools (lib/demo). */
const shownPrimary = DEMO ? primary.filter((item) => demoPage(item.href)) : primary;
const shownTools = DEMO ? TOOLS.filter((tool) => demoToolSlug(tool.slug)) : TOOLS;

const TILE = 26;
/** The icon dips a little while its row is pressed. */
const tileMotion = "transition-[transform,filter] duration-200 ease-[var(--ease-out-quint)] group-hover:brightness-110 group-active:scale-[0.9]";

export function Sidebar({ forceCollapsed = false }: { forceCollapsed?: boolean }) {
  const pathname = usePathname();
  const { collapsed: storedCollapsed, toggleCollapsed, mobileOpen, setMobileOpen } = useShell();
  const collapsed = storedCollapsed || forceCollapsed;
  const { connected, loaded, error } = useConnections();

  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));

  return (
    <>
      <div
        onClick={() => setMobileOpen(false)}
        className={cn(
          "fixed inset-0 z-40 bg-black/60 backdrop-blur-[2px] transition-opacity lg:hidden",
          mobileOpen ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      />
      <aside
        aria-label="Main navigation"
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex flex-col border-r border-line bg-stage transition-[width,transform] duration-300 ease-[var(--ease-out-quint)]",
          collapsed ? "lg:w-[68px]" : "lg:w-[var(--sidebar-w)]",
          "w-[272px] lg:translate-x-0",
          mobileOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className={cn("flex h-14 items-center gap-2 px-4", collapsed && "lg:justify-center lg:px-0")}>
          <Link href="/" className="flex items-center" aria-label="Crackio home">
            <Wordmark size={21} className={cn(collapsed && "lg:hidden")} />
            <LogoMark size={19} className={cn("hidden", collapsed && "lg:block")} />
          </Link>
          <button
            onClick={toggleCollapsed}
            className={cn(
              "press squircle ml-auto hidden size-8 place-items-center rounded-[10px] text-haze hover:bg-white/[0.06] hover:text-paper lg:grid",
              collapsed && "lg:hidden",
            )}
            aria-label="Collapse sidebar"
          >
            <PanelLeft size={16} />
          </button>
          <button
            onClick={() => setMobileOpen(false)}
            className="press squircle ml-auto grid size-8 place-items-center rounded-[10px] text-haze hover:bg-white/[0.06] hover:text-paper lg:hidden"
            aria-label="Close menu"
          >
            <X size={17} />
          </button>
        </div>

        <nav className="scroll-thin flex-1 overflow-y-auto overflow-x-hidden px-2.5 pb-3 pt-1">
          <ul className="space-y-0.5">
            {shownPrimary.map((item) => (
              <li key={item.href}>
                <NavLink href={item.href} active={isActive(item.href)} collapsed={collapsed} label={item.label}>
                  <NavTile glyph={item.glyph} size={TILE} className={tileMotion} />
                </NavLink>
              </li>
            ))}
          </ul>

          <p className={cn("label mb-1.5 mt-6 px-2.5", collapsed && "lg:hidden")}>Tools</p>
          <div className={cn("mx-auto mb-2 mt-5 hidden h-px w-6 bg-line-strong", collapsed && "lg:block")} />
          <ul className="space-y-0.5">
            {shownTools.map((tool) => (
              <li key={tool.slug}>
                <NavLink href={tool.href} active={isActive(tool.href)} collapsed={collapsed} label={tool.name}>
                  <ToolTile icon={tool.icon} glyph={tool.glyph} hue={tool.hue} size={TILE} className={tileMotion} />
                  {tool.badge === "Core" ? (
                    <span className={cn("ml-auto text-[10.5px] font-semibold text-spike", collapsed && "lg:hidden")}>Core</span>
                  ) : null}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>

        <div className="space-y-0.5 border-t border-line px-2.5 py-2.5">
          {/* The live demo's access code and credits left, in the sidebar's own flow. */}
          <DemoCard collapsed={collapsed} />
          {DEMO && !DEMO_FULL ? null : (
          <>
          <NavLink href="/settings/connections" active={isActive("/settings/connections")} collapsed={collapsed} label="Connections">
            <NavTile glyph="/icons/connections.png" size={TILE} className={tileMotion} />
            <span className={cn("ml-auto flex items-center gap-1.5 text-[12px] tabular", collapsed && "lg:hidden")}>
              {!loaded ? null : error ? (
                <span className="text-tally">Offline</span>
              ) : (
                <>
                  <span className={cn("size-1.5 rounded-full", connected > 0 ? "bg-chroma" : "bg-tungsten")} />
                  <span className={connected > 0 ? "text-fog" : "text-tungsten"}>{connected > 0 ? connected : "Set up"}</span>
                </>
              )}
            </span>
          </NavLink>
          <NavLink href="/settings/models" active={isActive("/settings/models")} collapsed={collapsed} label="Models">
            <NavTile glyph="/icons/models.png" size={TILE} className={tileMotion} />
          </NavLink>
          </>
          )}
          {collapsed && !forceCollapsed ? (
            <button
              onClick={toggleCollapsed}
              className="press squircle hidden h-9 w-full place-items-center rounded-[12px] text-haze hover:bg-white/[0.06] hover:text-paper lg:grid"
              aria-label="Expand sidebar"
            >
              <PanelLeft size={16} className="rotate-180" />
            </button>
          ) : null}
        </div>
      </aside>
    </>
  );
}

function NavLink({
  href,
  active,
  collapsed,
  label,
  children,
}: {
  href: string;
  active: boolean;
  collapsed: boolean;
  label: string;
  children: React.ReactNode;
}) {
  const { setMobileOpen } = useShell();
  const [tile, ...rest] = Array.isArray(children) ? children : [children];
  return (
    <Link
      href={href}
      onClick={() => setMobileOpen(false)}
      title={collapsed ? label : undefined}
      aria-current={active ? "page" : undefined}
      className={cn(
        "squircle group flex h-[38px] items-center gap-2.5 rounded-[13px] px-[7px] text-[13.5px] font-medium transition-colors duration-150",
        active
          ? "bg-white/[0.08] text-paper shadow-[inset_0_0_0_1px_rgb(255_255_255/0.05)]"
          : "text-fog hover:bg-white/[0.045] hover:text-paper active:bg-white/[0.07]",
        collapsed && "lg:justify-center lg:px-0",
      )}
    >
      {tile}
      <span className={cn("truncate", collapsed && "lg:hidden")}>{label}</span>
      {rest}
    </Link>
  );
}
