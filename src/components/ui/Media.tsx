"use client";

/* eslint-disable @next/next/no-img-element */
import { useEffect, useRef } from "react";
import type { MediaRef } from "@/lib/generations/types";
import { posterUrl, previewSrcSet, previewUrl } from "@/lib/media-url";
import { playbackSlot } from "@/lib/playback";
import { cn } from "@/lib/cn";

/**
 * Where a thumbnail sits, for picking its light copy: a card in a grid of columns (the Library,
 * Recent), or a chip in a strip of takes. The browser takes the copy that's sharp at that size on
 * this screen.
 */
const SLOTS = {
  card: { sizes: "(min-width: 1280px) 18vw, (min-width: 1024px) 22vw, (min-width: 640px) 30vw, 48vw", widths: [320, 480, 640, 960] },
  chip: { sizes: "240px", widths: [320, 480] },
} as const;
/** Clips loop from one copy, wide enough for a card on a sharp screen. */
const CLIP_WIDTH = 640;

/**
 * One generated result, image or video. Thumbnails show light copies sized for where they sit
 * (lib/media-url), and clips play muted on a loop like a contact sheet, but only while they're on
 * screen; the main viewer gets the original with playback controls.
 */
export function Media({
  media,
  alt = "",
  controls = false,
  slot = "card",
  className,
}: {
  media: Pick<MediaRef, "url" | "kind">;
  alt?: string;
  /** Show playback controls (main viewer). Thumbnails autoplay silently instead. */
  controls?: boolean;
  /** Where a thumbnail sits (ignored by the main viewer, which shows the original). */
  slot?: keyof typeof SLOTS;
  className?: string;
}) {
  if (media.kind === "video") {
    if (!controls) return <Thumb key={media.url} url={media.url} alt={alt} className={className} />;
    return (
      <video
        key={media.url}
        // Start a hair past zero so the first frame shows instead of black.
        src={`${media.url}#t=0.1`}
        className={cn("bg-black", className)}
        playsInline
        loop
        controls
        preload="auto"
        aria-label={alt}
      />
    );
  }
  if (controls) return <img src={media.url} alt={alt} loading="lazy" className={className} />;
  const { sizes, widths } = SLOTS[slot];
  return <img src={previewUrl(media.url, 640)} srcSet={previewSrcSet(media.url, widths)} sizes={sizes} alt={alt} loading="lazy" decoding="async" className={className} />;
}

/**
 * A looping, muted clip that plays only while it's on screen, from its light copy, and shows its
 * opening frame until then. Playing previews share a budget (lib/playback), so a page of takes
 * never decodes them all at once.
 */
function Thumb({ url, alt, className }: { url: string; alt: string; className?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    const slot = playbackSlot(
      () => void v.play().catch(() => {}),
      () => v.pause(),
    );
    const io = new IntersectionObserver(([entry]) => (entry.isIntersecting ? slot.want() : slot.drop()), { rootMargin: "120px" });
    io.observe(v);
    // Also when the page is hidden (Next keeps recent pages around): it stops, and plays again on return.
    return () => {
      io.disconnect();
      slot.drop();
      v.pause();
    };
  }, []);
  return (
    <video
      ref={ref}
      src={`${previewUrl(url, CLIP_WIDTH)}#t=0.1`}
      poster={posterUrl(url, CLIP_WIDTH)}
      className={cn("bg-black", className)}
      playsInline
      loop
      muted
      preload="none"
      aria-label={alt}
    />
  );
}
