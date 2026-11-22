"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import { ASPECT_STAGES, withRuntime } from "@/lib/motion/runtime";
import { cn } from "@/lib/cn";

export type PlayerComposition = { id: string; html: string; aspect: string; duration: number; fps: number; width?: number; height?: number; base?: string };

/**
 * Plays a Motion composition live, the same document the renderer scrubs, scaled to fit.
 * It runs in a sandboxed frame (scripts only, no access to Crackio itself).
 *
 * The frame says where it is every frame it draws: the readout and the scrubber follow it directly, so playing never
 * redraws the page (React only hears play, pause and the frame's size).
 */
export function CompositionPlayer({ composition, className }: { composition: PlayerComposition; className?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const range = useRef<HTMLInputElement>(null);
  const readout = useRef<HTMLSpanElement>(null);
  const time = useRef(0);
  const scrubbing = useRef(false);
  const [scale, setScale] = useState(0);
  const [playing, setPlaying] = useState(true);
  const wasPlaying = useRef(true);
  const size = composition.width && composition.height ? { width: composition.width, height: composition.height } : (ASPECT_STAGES[composition.aspect] ?? ASPECT_STAGES["16:9"]);
  const stage = { ...size, duration: composition.duration, fps: composition.fps };
  // Relative file names in the document resolve in the project folder.
  const doc = useMemo(
    () => withRuntime(composition.html, stage, typeof window === "undefined" ? undefined : `${window.location.origin}${composition.base ?? "/"}`),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [composition.id, composition.html],
  );

  const show = (t: number) => {
    time.current = t;
    if (readout.current) readout.current.textContent = `${t.toFixed(1)}s`;
    if (range.current && !scrubbing.current) range.current.value = String(Math.min(t, composition.duration));
  };

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
      if (d?.type === "crackio:time" && typeof d.t === "number") show(d.t);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [composition.duration]);

  const post = (msg: Record<string, unknown>) => frame.current?.contentWindow?.postMessage(msg, "*");

  // A hidden page (another route, kept by Next) stops the piece's loop and its videos; showing it again goes on.
  useLayoutEffect(() => {
    if (wasPlaying.current) post({ type: "crackio:play", t: time.current });
    return () => post({ type: "crackio:pause" });
  }, []);

  const toggle = () => {
    post(playing ? { type: "crackio:pause" } : { type: "crackio:play", t: time.current });
    wasPlaying.current = !playing;
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
                show(0);
                wasPlaying.current = true;
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
        <span ref={readout} className="tabular w-11 shrink-0 font-mono text-[11.5px] text-fog">
          0.0s
        </span>
        <input
          ref={range}
          type="range"
          min={0}
          max={composition.duration}
          step={1 / composition.fps}
          defaultValue={0}
          onPointerDown={() => (scrubbing.current = true)}
          onPointerUp={() => (scrubbing.current = false)}
          onChange={(e) => {
            const t = Number(e.target.value);
            show(t);
            wasPlaying.current = false;
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
