"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion, useSpring, useTransform, type MotionValue } from "motion/react";
import { X } from "lucide-react";
import { DotField } from "./DotField";
import { cn } from "@/lib/cn";

/** "0:07", "1:42". */
const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return <span className="tabular hidden text-[12px] font-medium text-paper/45 @min-[240px]:inline">{clock(now - since)}</span>;
}

/** The thin line with a glowing head, at the eased progress. */
function Line({ width, className }: { width: MotionValue<string>; className?: string }) {
  return (
    <div className={cn("relative h-[2px] rounded-full bg-white/[0.09]", className)}>
      <motion.div className="absolute inset-y-0 left-0 rounded-full bg-[linear-gradient(90deg,rgb(255_91_46/0.25),rgb(255_91_46/0.95))]" style={{ width }} />
      <motion.span
        aria-hidden="true"
        className="absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#ffb08f] shadow-[0_0_12px_3px_rgb(255_91_46/0.7)]"
        style={{ left: width }}
      />
    </div>
  );
}

/**
 * Anything on its way, wherever it shows (the tools' previews, the Library, Home's recent takes, Cast, Product): the dot
 * field (DotField) to play with while it works, lighting up as the job goes, under a quiet readout: the prompt, a large
 * percentage that counts up smoothly instead of jumping, the stage fading from one step to the next, the time so far,
 * and a thin line with a glowing head. It sizes itself to its box (a container query): small tiles get a smaller
 * percentage and leave out the prompt and the time. `bare`: the dots and the line only, for thumbnails and chips.
 * `backdrop`: the picture or first frame it starts from, faint underneath.
 */
export function GeneratingField({
  stage,
  progress,
  prompt,
  since,
  onCancel,
  backdrop,
  bare = false,
  className,
}: {
  stage?: string | null;
  progress?: number | null;
  prompt?: string | null;
  /** When the job started (its createdAt), for the time so far. */
  since?: number;
  onCancel?: () => void;
  backdrop?: string | null;
  bare?: boolean;
  className?: string;
}) {
  const known = typeof progress === "number";
  const p = Math.max(0.02, Math.min(1, progress ?? 0));
  const eased = useSpring(p, { stiffness: 70, damping: 22, mass: 0.8 });
  useEffect(() => eased.set(p), [p, eased]);
  const percent = useTransform(eased, (v) => `${Math.round(v * 100)}`);
  const width = useTransform(eased, (v) => `${v * 100}%`);
  const label = stage?.trim() || "Queued";

  return (
    <div className={cn("@container absolute inset-0 overflow-hidden bg-[#0e0c12]", className)}>
      {backdrop ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={backdrop} alt="" draggable={false} className="pointer-events-none absolute inset-0 size-full scale-105 object-cover opacity-25 blur-[3px]" />
      ) : null}
      <DotField progress={known ? p : 0} />
      {bare ? (
        known ? <Line width={width} className="absolute inset-x-1.5 bottom-1.5" /> : null
      ) : (
        <>
          {/* Darker toward the readout, so it stays legible over the dots. */}
          <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_top,rgb(14_12_18/0.92),rgb(14_12_18/0.35)_38%,transparent_62%)]" />
          {onCancel ? (
            <button
              type="button"
              onClick={onCancel}
              aria-label="Cancel"
              title="Cancel"
              className="press squircle absolute right-2 top-2 z-[1] grid size-7 place-items-center rounded-[10px] bg-white/[0.07] text-paper/70 backdrop-blur-md hover:bg-white/[0.12] hover:text-paper @min-[320px]:right-3 @min-[320px]:top-3 @min-[320px]:size-8"
            >
              <X size={14} />
            </button>
          ) : null}
          <div className="pointer-events-none absolute inset-x-3 bottom-3 @min-[320px]:inset-x-5 @min-[320px]:bottom-5">
            {prompt ? <p className="hidden max-w-[62ch] text-[12.5px] leading-snug text-paper/55 @min-[300px]:line-clamp-2">{prompt}</p> : null}
            <div className="mt-2 flex items-end gap-2.5 @min-[320px]:mt-3 @min-[320px]:gap-3">
              <span className="font-display tabular text-[22px] leading-[0.85] text-paper @min-[320px]:text-[30px]">
                <motion.span>{percent}</motion.span>
                <span className="ml-0.5 text-[12px] text-paper/50 @min-[320px]:text-[15px]">%</span>
              </span>
              <span className="relative min-w-0 flex-1 overflow-hidden pb-0.5">
                <AnimatePresence mode="popLayout" initial={false}>
                  <motion.span
                    key={label}
                    initial={{ opacity: 0, y: 8, filter: "blur(4px)" }}
                    animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                    exit={{ opacity: 0, y: -8, filter: "blur(4px)" }}
                    transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
                    className="block truncate text-[11.5px] font-semibold text-paper/85 @min-[320px]:text-[13px]"
                  >
                    {label}
                  </motion.span>
                </AnimatePresence>
              </span>
              {since ? <Elapsed since={since} /> : null}
            </div>
            <Line width={width} className="mt-2 @min-[320px]:mt-3" />
          </div>
        </>
      )}
    </div>
  );
}
