"use client";

import { create } from "zustand";
import { lengthOf, placed, speedOf, type EditTimeline } from "@/lib/storyboard/edit";
import { previewUrl } from "@/lib/media-url";

/**
 * The film playing in the browser, outside React: two video elements take turns (the next clip waits paused on its
 * first frame, so a cut is a cut and not a flash), two pictures the same way, and the music track's sounds kept in
 * time with the film. React draws the elements once; this moves them.
 */

/** Where the film is and whether it plays: the playhead, the time readout and the engine share it. */
export const usePlayhead = create<{ t: number; playing: boolean }>(() => ({ t: 0, playing: false }));

type Seg = {
  id: string;
  kind: "image" | "video";
  url: string;
  start: number;
  end: number;
  in: number;
  out: number;
  speed: number;
  volume: number;
  muted: boolean;
  fit: "fill" | "fit";
  push: boolean;
  fadeIn: number;
  fadeOut: number;
};

type Sound = Omit<Seg, "kind" | "fit" | "push" | "start"> & { at: number };

const EPS = 1 / 120;

export function segmentsOf(t: EditTimeline): { segs: Seg[]; sounds: Sound[]; total: number } {
  const segs = placed(t.main)
    .filter((p) => p.clip.kind !== "audio")
    .map(({ clip: c, start, end }) => ({
      id: c.id,
      kind: c.kind === "video" ? ("video" as const) : ("image" as const),
      url: c.url,
      start,
      end,
      in: c.in,
      out: c.out,
      speed: speedOf(c),
      volume: c.volume ?? 1,
      muted: Boolean(c.muted),
      fit: c.fit ?? "fill",
      push: Boolean(c.push),
      fadeIn: c.fadeIn ?? 0,
      fadeOut: c.fadeOut ?? 0,
    }));
  const sounds = t.music.map((c) => ({
    id: c.id,
    url: c.url,
    at: c.at ?? 0,
    end: (c.at ?? 0) + lengthOf(c),
    in: c.in,
    out: c.out,
    speed: speedOf(c),
    volume: c.volume ?? 0.8,
    muted: Boolean(c.muted),
    fadeIn: c.fadeIn ?? 0,
    fadeOut: c.fadeOut ?? 0,
  }));
  return { segs, sounds, total: segs.at(-1)?.end ?? 0 };
}

/** How faded in (or out) a piece is at `t`: 0 black, 1 full. */
const fadeAt = (s: { fadeIn: number; fadeOut: number; end: number }, start: number, t: number) =>
  Math.max(0, Math.min(1, s.fadeIn > 0 ? (t - start) / s.fadeIn : 1, s.fadeOut > 0 ? (s.end - t) / s.fadeOut : 1));

const ready = (v: HTMLVideoElement) => v.readyState >= 2 && !v.seeking && !v.error;

export class FilmEngine {
  private segs: Seg[] = [];
  private sounds: Sound[] = [];
  private total = 0;
  private raf = 0;
  private last = 0;
  /** How long the clip that should be playing has waited to load. */
  private waited = 0;
  private audio = new Map<string, HTMLAudioElement>();

  constructor(
    private videos: [HTMLVideoElement, HTMLVideoElement],
    private pictures: [HTMLImageElement, HTMLImageElement],
  ) {
    for (const v of videos) {
      v.preload = "auto";
      v.playsInline = true;
    }
  }

  get length() {
    return this.total;
  }

  setFilm(timeline: EditTimeline) {
    const { segs, sounds, total } = segmentsOf(timeline);
    this.segs = segs;
    this.sounds = sounds;
    this.total = total;
    for (const [id, el] of this.audio) {
      if (sounds.some((s) => s.id === id && el.dataset.url === s.url)) continue;
      el.pause();
      el.removeAttribute("src");
      this.audio.delete(id);
    }
    const { t } = usePlayhead.getState();
    this.render(Math.min(t, total), usePlayhead.getState().playing);
  }

  seek(t: number) {
    const to = Math.max(0, Math.min(t, this.total));
    usePlayhead.setState({ t: to });
    this.waited = 0;
    this.render(to, usePlayhead.getState().playing, true);
  }

  play() {
    if (!this.segs.length) return;
    let { t } = usePlayhead.getState();
    if (t >= this.total - EPS) t = 0;
    usePlayhead.setState({ t, playing: true });
    this.last = performance.now();
    this.waited = 0;
    this.render(t, true, true);
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(this.tick);
  }

  pause() {
    cancelAnimationFrame(this.raf);
    usePlayhead.setState({ playing: false });
    for (const v of this.videos) v.pause();
    for (const a of this.audio.values()) a.pause();
  }

  toggle() {
    if (usePlayhead.getState().playing) this.pause();
    else this.play();
  }

  destroy() {
    this.pause();
    for (const a of this.audio.values()) {
      a.pause();
      a.removeAttribute("src");
    }
    this.audio.clear();
  }

  private segAt(t: number) {
    const i = this.segs.findIndex((s) => t < s.end - EPS);
    return i < 0 ? this.segs.length - 1 : i;
  }

  private tick = (now: number) => {
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    let { t } = usePlayhead.getState();
    const k = this.segAt(t);
    const seg = this.segs[k];
    if (!seg) return this.pause();
    if (seg.kind === "video") {
      const v = this.holder(seg);
      if (v && ready(v) && !v.paused) {
        this.waited = 0;
        t = Math.max(seg.start, seg.start + (v.currentTime - seg.in) / seg.speed);
        if (v.currentTime >= seg.out - EPS || v.ended) t = seg.end;
      } else if (v && !v.error && this.waited < 3) {
        // Still loading: the film waits for it (a clip that never loads plays as time passing, so nothing is stuck).
        this.waited += dt;
      } else t += dt;
    } else t += dt;
    if (t >= seg.end - EPS) {
      if (k + 1 >= this.segs.length) {
        usePlayhead.setState({ t: this.total });
        this.render(this.total, false);
        return this.pause();
      }
      t = this.segs[k + 1].start;
      this.waited = 0;
    }
    usePlayhead.setState({ t });
    this.render(t, true);
    this.raf = requestAnimationFrame(this.tick);
  };

  /** The video element that has this clip loaded, if one has. */
  private holder(seg: Seg) {
    return this.videos.find((v) => v.dataset.seg === seg.id && v.dataset.url === seg.url) ?? null;
  }

  private load(v: HTMLVideoElement, seg: Seg, at: number) {
    if (v.dataset.url !== seg.url) {
      v.dataset.url = seg.url;
      v.src = seg.url;
    }
    v.dataset.seg = seg.id;
    const place = () => {
      if (Math.abs(v.currentTime - at) > 1 / 60) {
        try {
          v.currentTime = at;
        } catch {
          /* not seekable yet */
        }
      }
    };
    if (v.readyState >= 1) place();
    else v.addEventListener("loadedmetadata", place, { once: true });
  }

  private render(t: number, playing: boolean, seeked = false) {
    const k = this.segAt(t);
    const seg = this.segs[k];
    const next = this.segs[k + 1];
    if (!seg) {
      for (const v of this.videos) v.style.opacity = "0";
      for (const p of this.pictures) p.style.opacity = "0";
      return;
    }
    const fade = fadeAt(seg, seg.start, t);
    let showVideo: HTMLVideoElement | null = null;
    let showPicture: HTMLImageElement | null = null;

    if (seg.kind === "video") {
      let v = this.holder(seg);
      if (!v) {
        // The element the next clip isn't waiting in.
        v = this.videos.find((x) => !next || x.dataset.seg !== next.id) ?? this.videos[0];
        this.load(v, seg, seg.in + (t - seg.start) * seg.speed);
      }
      const at = seg.in + (t - seg.start) * seg.speed;
      if (seeked || !playing) {
        if (Math.abs(v.currentTime - at) > 1 / 30) {
          try {
            v.currentTime = at;
          } catch {
            /* loading: placed when it can be */
          }
        }
      }
      v.playbackRate = seg.speed;
      v.muted = seg.muted || seg.volume <= 0;
      v.volume = Math.max(0, Math.min(1, seg.volume * fade));
      v.style.objectFit = seg.fit === "fit" ? "contain" : "cover";
      if (playing && v.paused && v.readyState >= 2) {
        void v.play().catch(() => {
          // Sound not allowed yet: silent rather than stuck.
          v.muted = true;
          void v.play().catch(() => {});
        });
      }
      if (!playing && !v.paused) v.pause();
      showVideo = v;
    } else {
      const src = previewUrl(seg.url, 1280);
      const p = this.pictures.find((x) => x.dataset.seg === seg.id && x.dataset.url === seg.url) ?? this.pictures.find((x) => !next || x.dataset.seg !== next.id) ?? this.pictures[0];
      if (p.dataset.url !== seg.url) {
        p.dataset.url = seg.url;
        p.src = src;
      }
      p.dataset.seg = seg.id;
      p.style.objectFit = seg.push ? "cover" : seg.fit === "fit" ? "contain" : "cover";
      p.style.transform = seg.push ? `scale(${1 + 0.06 * Math.max(0, Math.min(1, (t - seg.start) / (seg.end - seg.start)))})` : "";
      showPicture = p;
    }

    // The next piece waits, ready: a clip on its first frame, a picture loaded.
    if (next && next.id !== seg.id) {
      if (next.kind === "video" && !this.holder(next)) {
        const free = this.videos.find((x) => x !== showVideo);
        if (free) {
          free.pause();
          this.load(free, next, next.in);
        }
      } else if (next.kind === "image") {
        const free = this.pictures.find((x) => x !== showPicture);
        if (free && free.dataset.url !== next.url) {
          free.dataset.url = next.url;
          free.dataset.seg = next.id;
          free.src = previewUrl(next.url, 1280);
        } else if (free) free.dataset.seg = next.id;
      }
    }

    for (const v of this.videos) {
      v.style.opacity = v === showVideo ? String(fade) : "0";
      if (v !== showVideo && !v.paused) v.pause();
    }
    for (const p of this.pictures) p.style.opacity = p === showPicture ? String(fade) : "0";
    this.syncSounds(t, playing, seeked);
  }

  private syncSounds(t: number, playing: boolean, seeked: boolean) {
    for (const s of this.sounds) {
      const on = playing && t >= s.at && t < s.end - EPS && !s.muted && s.volume > 0;
      let el = this.audio.get(s.id);
      if (!on) {
        if (el && !el.paused) el.pause();
        continue;
      }
      if (!el) {
        el = new Audio();
        el.preload = "auto";
        el.dataset.url = s.url;
        el.src = s.url;
        this.audio.set(s.id, el);
      }
      const at = s.in + (t - s.at) * s.speed;
      el.playbackRate = s.speed;
      el.volume = Math.max(0, Math.min(1, s.volume * fadeAt(s, s.at, t)));
      if (el.paused || seeked || Math.abs(el.currentTime - at) > 0.3) {
        try {
          el.currentTime = at;
        } catch {
          /* loading */
        }
      }
      if (el.paused) void el.play().catch(() => {});
    }
  }
}
