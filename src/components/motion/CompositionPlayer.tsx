"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import { ASPECT_STAGES, withRuntime } from "@/lib/motion/runtime";
import { cn } from "@/lib/cn";

export type PlayerComposition = { id: string; html: string; aspect: string; duration: number; fps: number; width?: number; height?: number; base?: string };

/**
 * Plays a Motion composition live, the same document the renderer scrubs, scaled to fit.
 * It runs in a sandboxed frame (scripts only, no access to Crackio itself).
 */
export function CompositionPlayer({ composition, className }: { composition: PlayerComposition; className?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [scale, setScale] = useState(0);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(true);
  const size = composition.width && composition.height ? { width: composition.width, height: composition.height } : (ASPECT_STAGES[composition.aspect] ?? ASPECT_STAGES["16:9"]);
  const stage = { ...size, duration: composition.duration, fps: composition.fps };
  // Relative file names in the document resolve in the project folder.
  const doc = useMemo(
    () => withRuntime(composition.html, stage, typeof window === "undefined" ? undefined : `${window.location.origin}${composition.base ?? "/"}`),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [composition.id, composition.html],
  );

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setScale(Math.min(e.contentRect.width / stage.width, e.contentRect.height / stage.height)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [stage.width, stage.height]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow) return;
      const d = e.data as { type?: string; t?: number };
      if (d?.type === "crackio:time" && typeof d.t === "number") setTime(d.t);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const post = (msg: Record<string, unknown>) => frame.current?.contentWindow?.postMessage(msg, "*");
  const toggle = () => {
    post(playing ? { type: "crackio:pause" } : { type: "crackio:play", t: time });
    setPlaying(!playing);
  };

  return (
    <div className={cn("flex h-full flex-col", className)}>
      <div ref={box} className="relative grid min-h-0 flex-1 place-items-center overflow-hidden">
        {scale ? (
          <div className="relative overflow-hidden rounded-[12px] shadow-[0_30px_80px_-30px_rgb(0_0_0/0.8)]" style={{ width: stage.width * scale, height: stage.height * scale }}>
            <iframe
              key={composition.id}
              ref={frame}
              title="Motion preview"
              sandbox="allow-scripts"
              srcDoc={doc}
              onLoad={() => {
                setTime(0);
                setPlaying(true);
                post({ type: "crackio:play", t: 0 });
              }}
              className="absolute left-0 top-0 origin-top-left border-0"
              style={{ width: stage.width, height: stage.height, transform: `scale(${scale})` }}
            />
          </div>
        ) : null}
      </div>
      <div className="mt-3 flex items-center gap-3 px-1">
        <button
          onClick={toggle}
          className="press grid size-9 shrink-0 place-items-center rounded-full bg-paper text-[#16131b] hover:bg-white"
          aria-label={playing ? "Pause" : "Play"}
        >
          {playing ? <Pause size={15} /> : <Play size={15} className="translate-x-px" />}
        </button>
        <span className="tabular w-11 shrink-0 font-mono text-[11.5px] text-fog">{time.toFixed(1)}s</span>
        <input
          type="range"
          min={0}
          max={composition.duration}
          step={1 / composition.fps}
          value={Math.min(time, composition.duration)}
          onChange={(e) => {
            const t = Number(e.target.value);
            setTime(t);
            setPlaying(false);
            post({ type: "crackio:seek", t });
          }}
          className="h-1 min-w-0 flex-1 accent-[var(--color-spike)]"
          aria-label="Scrub"
        />
        <span className="tabular w-11 shrink-0 text-right font-mono text-[11.5px] text-haze">{composition.duration.toFixed(1)}s</span>
      </div>
    </div>
  );
}
