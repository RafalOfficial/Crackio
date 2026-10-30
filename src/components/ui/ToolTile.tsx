import type { CSSProperties } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * A glossy squircle with a solid white glyph image, like an app icon. `hue` colors the tile;
 * without one it's graphite (navigation). Glyphs live in public/icons (see scripts/assets/icons.mjs).
 */
export function AppIcon({
  glyph,
  hue,
  size = 28,
  className,
}: {
  /** Path of the white glyph image, e.g. "/icons/director.png". */
  glyph: string;
  hue?: string;
  size?: number;
  className?: string;
}) {
  const inner = Math.round(size * 0.64);
  return (
    <span
      aria-hidden="true"
      data-tone={hue ? undefined : "neutral"}
      className={cn("app-icon", className)}
      style={{ "--hue": hue, width: size, height: size, borderRadius: Math.round(size * 0.34) } as CSSProperties}
    >
      <span className="app-icon-glyph">
        <span style={{ "--glyph": `url(${glyph})`, width: inner, height: inner } as CSSProperties} />
      </span>
    </span>
  );
}

/** `hue` is "var(--color-tool-<slug>)"; the glyph image shares the slug. */
const glyphFromHue = (hue: string) => {
  const slug = /--color-tool-([a-z]+)/.exec(hue)?.[1];
  return slug ? `/icons/${slug}.png` : undefined;
};

/** A tool's mark. Pass `glyph` (Tool.glyph); older call sites that only pass the hue still get theirs. */
export function ToolTile({
  icon: Icon,
  glyph,
  hue,
  size = 28,
  className,
}: {
  /** Fallback when the tool has no glyph image. */
  icon: LucideIcon;
  glyph?: string;
  hue: string;
  size?: number;
  className?: string;
}) {
  const src = glyph ?? glyphFromHue(hue);
  if (src) return <AppIcon glyph={src} hue={hue} size={size} className={className} />;
  return (
    <span
      className={cn("tile squircle inline-grid shrink-0 place-items-center", className)}
      style={{ "--hue": hue, width: size, height: size, borderRadius: Math.round(size * 0.34) } as CSSProperties}
    >
      <Icon size={Math.round(size * 0.55)} strokeWidth={2} />
    </span>
  );
}

/** Graphite app icon for navigation items that aren't tools (Home, Image, Library, Connections, Models). */
export function NavTile({ glyph, size = 28, className }: { glyph: string; size?: number; className?: string }) {
  return <AppIcon glyph={glyph} size={size} className={className} />;
}
