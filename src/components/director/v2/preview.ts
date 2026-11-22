"use client";

import { useDirector, usePlayhead } from "@/lib/director/store";
import { hasKeys } from "@/lib/director/timeline";
import { aspectById } from "@/lib/shot";
import { grabFrame } from "../stage/capture";

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Save preview: the shot's camera move (and everyone's moves) played through the Camera and recorded in the browser,
 * free and on any computer (no model, no GPU server): a quick animatic to judge the move before filming it. Each
 * timeline frame is set, drawn through the lens and handed to the recorder at the timeline's pace.
 */
export async function recordPreview(onProgress?: (share: number) => void): Promise<Blob> {
  const start = useDirector.getState();
  const tl = start.scene.timeline;
  if (!hasKeys(tl)) throw new Error("Make a camera move first: key the camera, move the playhead, move the camera.");
  if (typeof MediaRecorder === "undefined") throw new Error("This browser can't record video.");
  const a = aspectById(start.scene.aspect);
  const height = 540;
  const width = Math.round((height * (a.w / a.h)) / 2) * 2;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser can't draw the preview.");
  const stream = canvas.captureStream(0);
  const track = stream.getVideoTracks()[0] as MediaStreamTrack & { requestFrame?: () => void };
  const type = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm", "video/mp4"].find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
  const recorder = new MediaRecorder(stream, { ...(type ? { mimeType: type } : {}), videoBitsPerSecond: 8_000_000 });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data);
  };
  const finished = new Promise<Blob>((resolve) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: type.split(";")[0] || "video/webm" }));
  });
  const was = usePlayhead.getState().frame;
  usePlayhead.setState({ playing: false });
  const image = ctx.createImageData(width, height);
  const frameMs = 1000 / Math.max(1, tl.fps);
  recorder.start();
  try {
    for (let f = 0; f <= tl.length; f++) {
      const t0 = performance.now();
      useDirector.getState().seek(f);
      // The set follows the store on the next frames (React, then the stage).
      await nextFrame();
      await nextFrame();
      const px = grabFrame(width, height);
      // WebGL's rows run bottom-up.
      for (let y = 0; y < height; y++) image.data.set(px.subarray((height - 1 - y) * width * 4, (height - y) * width * 4), y * width * 4);
      ctx.putImageData(image, 0, 0);
      track.requestFrame?.();
      onProgress?.(f / tl.length);
      const left = frameMs - (performance.now() - t0);
      if (left > 0) await wait(left);
    }
  } finally {
    recorder.stop();
    useDirector.getState().seek(was);
  }
  return finished;
}

/** Hands a recorded preview to the browser as a download. */
export function downloadPreview(blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `director-preview-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.${blob.type.includes("mp4") ? "mp4" : "webm"}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
