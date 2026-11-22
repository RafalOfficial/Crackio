"use client";

import { useEffect, useState } from "react";
import { SRGBColorSpace, VideoTexture } from "three";
import { usePlayhead, type Playhead } from "@/lib/director/store";
import type { PlaceVideo } from "@/lib/director/types";

type FrameCallback = (cb: () => void) => number;

/**
 * Director video mode: the place's video as the 3D set's picture, at the timeline's playhead. It plays while the timeline
 * plays (put back on the playhead when it drifts) and shows the playhead's frame while it stands still. Each new frame
 * asks the stage to draw (the stage draws only when asked). Null without a video.
 */
export function useVideoTexture(video: PlaceVideo | undefined, fps: number, invalidate: () => void) {
  const [texture, setTexture] = useState<VideoTexture | null>(null);
  const url = video?.url;
  useEffect(() => {
    if (!url) return;
    const el = document.createElement("video");
    el.src = url;
    el.muted = true;
    el.playsInline = true;
    el.crossOrigin = "anonymous";
    el.preload = "auto";
    const tex = new VideoTexture(el);
    tex.colorSpace = SRGBColorSpace;
    let live = true;
    const drawn = () => {
      tex.needsUpdate = true;
      invalidate();
    };
    const next = (el as HTMLVideoElement & { requestVideoFrameCallback?: FrameCallback }).requestVideoFrameCallback?.bind(el);
    const onFrame = () => {
      if (!live) return;
      drawn();
      next?.(onFrame);
    };
    next?.(onFrame);
    // Shown once its first frame is in (the photo of that frame until then).
    el.addEventListener("loadeddata", () => {
      if (!live) return;
      setTexture(tex);
      drawn();
    });
    el.addEventListener("seeked", drawn);
    const sync = (p: Playhead) => {
      const want = p.frame / Math.max(1, fps);
      if (p.playing) {
        if (el.paused) {
          el.currentTime = want;
          void el.play().catch(() => undefined);
        } else if (Math.abs(el.currentTime - want) > 0.25) el.currentTime = want;
      } else {
        if (!el.paused) el.pause();
        if (Math.abs(el.currentTime - want) > 0.5 / Math.max(1, fps)) el.currentTime = want;
      }
    };
    sync(usePlayhead.getState());
    const stop = usePlayhead.subscribe(sync);
    return () => {
      live = false;
      stop();
      el.pause();
      el.removeAttribute("src");
      el.load();
      tex.dispose();
      setTexture(null);
    };
  }, [url, fps, invalidate]);
  return texture;
}
