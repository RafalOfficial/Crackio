import { useId, type CSSProperties } from "react";
import { cn } from "@/lib/cn";
import { CAP, COUNTER, EDGE_HI, EDGE_LO, FEED, FRAMES, FRONT, GAP, LETTERS, MARK_VIEW, O, O_OUTLINE, PERFS, SHADE, STRIP, VIEW } from "./wordmark-art";

/**
 * Crackio's logo: CRACKIO in the face of the "See it work" lockups (Archivo ExtraBold Italic),
 * with a strip of film running through the O and out of it, like a print leaving a camera.
 * It's drawn from outlines (scripts/assets/logo.mjs), so it needs no font. Pointing at it takes a
 * shot: the O flashes and the film feeds out (.wordmark in globals.css).
 */
function Art({ mark, size, className }: { mark: boolean; size: number; className?: string }) {
  const id = useId();
  const v = mark ? MARK_VIEW : VIEW;
  const height = (size * v.h) / CAP;
  const url = (name: string) => `url(#${id}${name})`;
  // Masks cover the art's box with room for the film to feed out.
  const area = { x: v.x - 600, y: v.y - 600, width: v.w + 1800, height: v.h + 1200 };
  return (
    <svg
      width={((height * v.w) / v.h).toFixed(1)}
      height={height.toFixed(1)}
      viewBox={`${v.x} ${v.y} ${v.w} ${v.h}`}
      aria-hidden="true"
      className={cn("wordmark shrink-0 overflow-visible", className)}
      style={{ "--feed": `${FEED}px` } as CSSProperties}
    >
      <defs>
        {/* The film shows through the counter and right of it, never between the I and the O. */}
        <clipPath id={`${id}show`}>
          <path d={O_OUTLINE} />
          <path d={FRONT} />
        </clipPath>
        <clipPath id={`${id}strip`}>
          <path d={STRIP} />
        </clipPath>
        {/* A dark seam where the O passes over the film. */}
        <mask id={`${id}seam`} maskUnits="userSpaceOnUse" {...area}>
          <rect {...area} fill="#fff" />
          <path d={O} stroke="#000" strokeWidth={GAP * 2} strokeLinejoin="round" />
        </mask>
        <mask id={`${id}perfs`} maskUnits="userSpaceOnUse" {...area}>
          <rect {...area} fill="#fff" />
          <path d={PERFS} />
        </mask>
        <linearGradient id={`${id}frame`} x1="0" y1="0" x2="0" y2="1">
          <stop stopColor="#4a1b0b" stopOpacity="0.92" />
          <stop offset="0.5" stopColor="#2a0f06" stopOpacity="0.9" />
          <stop offset="1" stopColor="#1a0904" stopOpacity="0.92" />
        </linearGradient>
        {/* The film is in the dark inside the O and comes out into the light. */}
        <linearGradient id={`${id}shade`} x1={SHADE[0]} x2={SHADE[1]} y1="0" y2="0" gradientUnits="userSpaceOnUse">
          <stop stopOpacity="0.4" />
          <stop offset="1" stopOpacity="0" />
        </linearGradient>
        <filter id={`${id}soft`} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="16" />
        </filter>
      </defs>
      {mark ? null : <path d={LETTERS} fill="currentColor" />}
      <g clipPath={url("show")} mask={url("seam")}>
        <g className="wordmark-film">
          <g mask={url("perfs")}>
            <path d={STRIP} fill="var(--color-spike)" />
            <path d={EDGE_HI} fill="#fff" fillOpacity="0.28" />
            <path d={EDGE_LO} fill="#000" fillOpacity="0.16" />
          </g>
          {FRAMES.map((d, i) => (
            <path key={i} d={d} fill={url("frame")} />
          ))}
        </g>
        <path d={STRIP} fill={url("shade")} />
        {/* The O's shadow on the film. */}
        <g clipPath={url("strip")}>
          <path d={O} transform="translate(16 30)" filter={url("soft")} opacity="0.55" />
        </g>
        <path d={COUNTER} className="wordmark-flash" fill="#fff8ee" />
      </g>
      <path d={O} fill="currentColor" />
    </svg>
  );
}

/** The whole word. `size` is its cap height in px. */
export function Wordmark({ size = 19, className }: { size?: number; className?: string }) {
  return <Art mark={false} size={size} className={className} />;
}

/** The O and its film alone, where the word doesn't fit (the collapsed sidebar). Same `size`. */
export function LogoMark({ size = 19, className }: { size?: number; className?: string }) {
  return <Art mark size={size} className={className} />;
}
