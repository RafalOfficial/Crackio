"use client";

import { create } from "zustand";

/**
 * One player for the whole Voice page: a take, a voice's sample or a design option plays through it, so starting one
 * stops the other. It reports where it is and how loud it is right now (the orb moves with it).
 */
type PlayerState = {
  key: string | null;
  playing: boolean;
  time: number;
  duration: number;
  level: number;
  toggle: (key: string, url: string, from?: number) => void;
  stop: () => void;
  seek: (key: string, url: string, at: number) => void;
};

let audio: HTMLAudioElement | null = null;
let analyser: AnalyserNode | null = null;
let data: Uint8Array<ArrayBuffer> | null = null;
let raf = 0;

function element() {
  if (audio) return audio;
  audio = new Audio();
  audio.preload = "auto";
  audio.addEventListener("ended", () => {
    cancelAnimationFrame(raf);
    usePlayer.setState({ playing: false, time: 0, level: 0 });
  });
  audio.addEventListener("pause", () => usePlayer.setState({ playing: false, level: 0 }));
  audio.addEventListener("loadedmetadata", () => usePlayer.setState({ duration: audio?.duration || 0 }));
  return audio;
}

function listen() {
  // The level meter needs Web Audio, which only starts after a click; without it the orb simply doesn't move.
  if (analyser || !audio) return;
  try {
    const ctx = new AudioContext();
    const src = ctx.createMediaElementSource(audio);
    analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    analyser.connect(ctx.destination);
    data = new Uint8Array(new ArrayBuffer(analyser.fftSize));
  } catch {
    analyser = null;
  }
}

function tick() {
  if (!audio) return;
  let level = 0;
  if (analyser && data) {
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128;
      sum += v * v;
    }
    level = Math.min(1, Math.sqrt(sum / data.length) * 3.2);
  }
  usePlayer.setState({ time: audio.currentTime, level });
  if (!audio.paused) raf = requestAnimationFrame(tick);
}

export const usePlayer = create<PlayerState>((set, get) => ({
  key: null,
  playing: false,
  time: 0,
  duration: 0,
  level: 0,
  toggle: (key, url, from) => {
    const a = element();
    if (get().key === key && !a.paused) {
      a.pause();
      return;
    }
    if (get().key !== key || !a.src.endsWith(url)) {
      a.src = url;
      set({ key, time: 0, duration: 0 });
    }
    if (typeof from === "number") a.currentTime = from;
    listen();
    void (analyser?.context as AudioContext | undefined)?.resume?.();
    void a.play().then(
      () => {
        set({ playing: true });
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(tick);
      },
      () => set({ playing: false }),
    );
  },
  stop: () => {
    audio?.pause();
    set({ key: null, playing: false, time: 0, level: 0 });
  },
  seek: (key, url, at) => {
    const a = element();
    if (get().key !== key) {
      get().toggle(key, url, at);
      return;
    }
    a.currentTime = at;
    set({ time: at });
    if (a.paused) get().toggle(key, url, at);
  },
}));
