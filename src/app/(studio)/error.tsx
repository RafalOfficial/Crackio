"use client";

import { useEffect } from "react";
import Link from "next/link";
import { RotateCcw, TriangleAlert } from "lucide-react";

/**
 * A page that broke while drawing: the rail stays (this sits inside the studio layout), and the page says so in plain
 * words with a way back, instead of going blank. "Try again" fetches and draws the page afresh.
 */
export default function StudioError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  // In development the message helps; in production Next sends a generic one with a digest for the server's log.
  const message = error instanceof Error && process.env.NODE_ENV !== "production" ? error.message : null;
  return (
    <div className="grid min-h-[70dvh] place-items-center px-6 py-16">
      <div className="flex max-w-[440px] flex-col items-center text-center">
        <span className="squircle grid size-12 place-items-center rounded-[16px] bg-tungsten/12 text-tungsten shadow-[inset_0_0_0_1px_rgb(242_181_75/0.25)]">
          <TriangleAlert size={22} />
        </span>
        <h1 className="mt-5 font-display text-[26px] leading-tight">This page hit a snag</h1>
        <p className="mt-2 text-[14px] leading-relaxed text-fog">Nothing you made is lost. Try again, or head back home.</p>
        {message ? <p className="mt-4 max-w-full break-words rounded-[12px] bg-white/[0.04] px-3 py-2 font-mono text-[11.5px] text-haze">{message}</p> : null}
        <div className="mt-6 flex items-center gap-2">
          <button
            type="button"
            onClick={() => retry()}
            className="lip press squircle inline-flex h-10 items-center gap-2 rounded-btn bg-spike px-4 text-[13.5px] font-semibold text-spike-ink"
          >
            <RotateCcw size={15} />
            Try again
          </button>
          <Link
            href="/"
            className="press squircle inline-flex h-10 items-center rounded-btn px-4 text-[13.5px] font-semibold text-fog shadow-[inset_0_0_0_1px_var(--color-line-strong)] hover:bg-white/[0.05] hover:text-paper"
          >
            Home
          </Link>
        </div>
      </div>
    </div>
  );
}
