"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { LoaderCircle, Wand2, X } from "lucide-react";
import { create } from "zustand";
import { Vector3 } from "three";
import { useDirector } from "@/lib/director/store";
import { shotCamera } from "@/lib/director/camera";
import { placeModel } from "../place-model";
import { friendlyModelError } from "../status";
import { notice } from "./notice";

/** Whether the Fix this spot box is open (the rail's wand button opens it in the Camera tab). */
export const useFixSpot = create<{ open: boolean; busy: boolean }>(() => ({ open: false, busy: false }));

/**
 * Fix this spot: say what to change in the part of the place the Camera sees ("make the sky stormy", "a red door
 * here"); that part is cut out of the 360 world, changed by the place's model and put back exactly where it was
 * (server/fix-spot). The place keeps its 3D; Undo brings the old picture back.
 */
export function FixSpot() {
  const { open, busy } = useFixSpot();
  const [words, setWords] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const world = useDirector((s) => s.scene.place.world);
  useEffect(() => {
    if (open) setTimeout(() => input.current?.focus(), 30);
  }, [open]);

  async function fix() {
    const w = words.trim();
    const place = useDirector.getState().scene.place.world;
    const photo = useDirector.getState().scene.place.image;
    if (!w || !place || busy) return;
    const model = placeModel();
    if (!model || model === "auto") {
      notice("Pick the place's model first (Cast & place → the place)", "warn", 4000);
      return;
    }
    const cam = shotCamera(useDirector.getState().scene);
    const forward = cam.getWorldDirection(new Vector3());
    const right = new Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
    const up = new Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
    useFixSpot.setState({ busy: true });
    notice("Fixing this spot of the place…", "busy", 600_000);
    try {
      const res = await fetch("/api/director/fix", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          world: place.url,
          words: w,
          model,
          look: { forward: forward.toArray(), right: right.toArray(), up: up.toArray(), vfov: cam.fov, aspect: cam.aspect },
          // The photo the stage shows where it looks gets the fix too (Stage3D Surround photoOver).
          ...(photo?.view ? { photo: { url: place.photo?.url ?? photo.url, view: { fov: photo.view.fov, pitch: photo.view.pitch, roll: photo.view.roll } } } : {}),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { world?: { url: string; width: number; height: number }; photo?: { url: string; width: number; height: number }; error?: string };
      if (!res.ok || !data.world) throw new Error(data.error ?? "The model couldn't fix it.");
      const now = useDirector.getState().scene.place.world;
      if (now?.url !== place.url) return; // another place meanwhile
      useDirector.getState().checkpoint();
      useDirector.getState().sharpenWorld(place.url, { ...data.world, ...(data.photo ? { photo: data.photo } : {}) });
      setWords("");
      useFixSpot.setState({ open: false });
      notice("Fixed · Undo brings the old one back", "done", 3000);
    } catch (err) {
      notice(friendlyModelError((err as Error).message), "stop", 8000);
    } finally {
      useFixSpot.setState({ busy: false });
    }
  }

  return (
    <AnimatePresence>
      {open && world ? (
        <motion.div
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.14 }}
          className="absolute left-1/2 top-16 z-30 w-[min(560px,calc(100%-180px))] -translate-x-1/2 rounded-[14px] bg-[#16171a]/95 p-2 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.12),0_16px_40px_rgb(0_0_0/0.45)]"
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void fix();
            }}
            className="flex items-center gap-2"
          >
            <Wand2 size={16} className="ml-1.5 shrink-0 text-spike" />
            <input
              ref={input}
              value={words}
              onChange={(e) => setWords(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") useFixSpot.setState({ open: false });
              }}
              disabled={busy}
              maxLength={300}
              placeholder="What should change here? A stormy sky, a red door…"
              className="h-10 min-w-0 flex-1 bg-transparent text-[14px] text-paper outline-none placeholder:text-haze"
            />
            <button type="submit" disabled={busy || !words.trim()} className="press inline-flex h-9 items-center gap-1.5 rounded-[10px] bg-spike px-3 text-[13px] font-semibold text-spike-ink disabled:opacity-50">
              {busy ? <LoaderCircle size={14} className="animate-spin" /> : null}
              {busy ? "Fixing" : "Fix it"}
            </button>
            <button type="button" onClick={() => useFixSpot.setState({ open: false })} className="press grid size-9 place-items-center rounded-[10px] text-haze hover:text-paper" aria-label="Close">
              <X size={15} />
            </button>
          </form>
          <p className="px-2 pb-0.5 pt-1 text-[11.5px] text-haze">Changes only what the Camera sees of the place, and puts it back exactly there. People aren&apos;t touched.</p>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
