"use client";

import { useRef, useState, type ReactNode } from "react";
import { Osd } from "@/components/ui/Viewfinder";

/** Before/after with a draggable divider. Without an "after", shows the source alone. */
export function CompareView({
  before,
  after,
  ratio,
  overlay,
  labels = ["Before", "After"],
}: {
  before: string;
  after?: string | null;
  ratio: number;
  overlay?: ReactNode;
  labels?: [string, string];
}) {
  const [split, setSplit] = useState(50);
  const ref = useRef<HTMLDivElement>(null);
  const move = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    setSplit(Math.min(100, Math.max(0, ((clientX - r.left) / r.width) * 100)));
  };

  return (
    // The outer box is a size container, so the frame can be the largest rectangle with this ratio.
    <div className="grid size-full place-items-center" style={{ containerType: "size" }}>
      <div
        ref={ref}
        className="relative overflow-hidden rounded-[14px] bg-apple shadow-[0_0_0_1px_var(--color-line-strong)]"
        style={{ aspectRatio: ratio, width: `min(100cqw, calc(100cqh * ${ratio}))` }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={before} alt="Original" className="absolute inset-0 size-full object-contain" draggable={false} />
        {after ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={after}
              alt="Result"
              className="absolute inset-0 size-full object-contain"
              style={{ clipPath: `inset(0 0 0 ${split}%)` }}
              draggable={false}
            />
            <div
              role="slider"
              aria-label="Compare before and after"
              aria-valuenow={Math.round(split)}
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "ArrowLeft") setSplit((s) => Math.max(0, s - 5));
                if (e.key === "ArrowRight") setSplit((s) => Math.min(100, s + 5));
              }}
              onPointerDown={(e) => {
                (e.currentTarget as Element).setPointerCapture(e.pointerId);
                move(e.clientX);
              }}
              onPointerMove={(e) => e.buttons && move(e.clientX)}
              className="absolute inset-y-0 z-10 w-8 -translate-x-1/2 cursor-ew-resize touch-none"
              style={{ left: `${split}%` }}
            >
              <span className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-paper shadow-[0_0_8px_rgb(0_0_0/0.6)]" />
              <span className="absolute left-1/2 top-1/2 grid size-8 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-paper text-[11px] font-bold text-[#16171a] shadow-lg">
                ⇆
              </span>
            </div>
            <Osd className="absolute left-3 top-3 rounded bg-black/50 px-1.5 py-1">{labels[0]}</Osd>
            <Osd className="absolute right-3 top-3 rounded bg-black/50 px-1.5 py-1">{labels[1]}</Osd>
          </>
        ) : null}
        {overlay}
      </div>
    </div>
  );
}
