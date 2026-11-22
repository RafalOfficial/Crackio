"use client";

import { useEffect, useState } from "react";

/** Frames already pulled from a video (by url and count): a timeline drawn again doesn't seek the video again. */
const strips = new Map<string, Promise<string[]>>();

/**
 * `count` small pictures from a video, evenly from its start to `seconds` (the timeline's length), as data URLs: the
 * video lane of the timeline in Director video mode, so you see when what happens. Pulled in the page by seeking a
 * muted video element (no server work); each picture is 96 px tall.
 */
function pull(url: string, seconds: number, count: number): Promise<string[]> {
  const key = `${url}|${seconds.toFixed(2)}|${count}`;
  let p = strips.get(key);
  if (!p) {
    p = new Promise<string[]>((resolve, reject) => {
      const v = document.createElement("video");
      v.muted = true;
      v.playsInline = true;
      v.preload = "auto";
      v.crossOrigin = "anonymous";
      v.src = url;
      const out: string[] = [];
      const canvas = document.createElement("canvas");
      const step = () => {
        if (out.length >= count) {
          v.removeAttribute("src");
          v.load();
          return resolve(out);
        }
        v.currentTime = Math.min(Math.max(0, v.duration - 0.05), ((out.length + 0.5) / count) * seconds);
      };
      v.addEventListener("loadedmetadata", () => {
        canvas.height = 96;
        canvas.width = Math.max(1, Math.round((96 * v.videoWidth) / Math.max(1, v.videoHeight)));
        step();
      });
      v.addEventListener("seeked", () => {
        const g = canvas.getContext("2d");
        if (!g) return reject(new Error("no canvas"));
        g.drawImage(v, 0, 0, canvas.width, canvas.height);
        out.push(canvas.toDataURL("image/jpeg", 0.7));
        step();
      });
      v.addEventListener("error", () => reject(new Error("The video couldn't be read")));
    });
    p.catch(() => strips.delete(key));
    strips.set(key, p);
  }
  return p;
}

export function useVideoStrip(url: string | undefined, seconds: number, count: number) {
  const [frames, setFrames] = useState<string[] | null>(null);
  useEffect(() => {
    if (!url || !(seconds > 0)) return;
    let live = true;
    void pull(url, seconds, count).then(
      (f) => live && setFrames(f),
      () => live && setFrames(null),
    );
    return () => {
      live = false;
    };
  }, [url, seconds, count]);
  return frames;
}
