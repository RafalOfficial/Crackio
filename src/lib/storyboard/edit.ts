import type { AspectId } from "@/lib/shot";

/**
 * Storyboard projects: a film you cut together from the pictures and clips you make for it. Each project is a Library
 * folder (everything made in it is filed there), a timeline, and the Director's set as you left it. Shared by the
 * editor in the browser and the server that saves and exports it.
 */

export type EditKind = "image" | "video" | "audio";

/** One piece on the timeline: a picture held for a while, part of a clip, or part of a sound. */
export type EditClip = {
  id: string;
  /** The file it plays. */
  url: string;
  kind: EditKind;
  name?: string;
  /** The take it came from (a generation), when it's one. */
  gen?: string;
  width?: number;
  height?: number;
  /** A clip's or a sound's own length in seconds. */
  length?: number;
  /** A clip that has its own sound. */
  sound?: boolean;
  /**
   * The part that plays, in seconds of the file. A picture has no time of its own: it plays from 0 to its time on
   * screen.
   */
  in: number;
  out: number;
  /** Sounds on the music track: where in the film it starts. Pictures and clips follow each other. */
  at?: number;
  /** 0.25 to 4 (clips and sounds). */
  speed?: number;
  /** 0 to 1. */
  volume?: number;
  muted?: boolean;
  /** Fill the frame (cropping what spills over) or fit inside it (bars where the shape differs). */
  fit?: "fill" | "fit";
  /** Pictures: a slow push in while it's on screen. */
  push?: boolean;
  /** Seconds it fades in from black (or silence) and out to it. */
  fadeIn?: number;
  fadeOut?: number;
  /** A clip being made from this picture: its generation. The clip takes the picture's place when it's done. */
  making?: string;
};

/** The film: pictures and clips one after the other, and sounds laid under them. */
export type EditTimeline = { main: EditClip[]; music: EditClip[] };

/** A file in the project: a take made in it, or something you added from your computer. */
export type EditFile = {
  /** `gen:<id>:<n>` for a take, `up:<url>` for an upload. */
  key: string;
  url: string;
  kind: EditKind;
  name: string;
  width?: number;
  height?: number;
  duration?: number;
  sound?: boolean;
  gen?: string;
  index?: number;
  createdAt: number;
  /** What it was made from, in words. */
  prompt?: string;
  /** Which tool made it ("director", "storyboard"…), or "upload". */
  from?: string;
};

export type EditMode = "edit" | "direct";

export type EditProject = {
  /** The Library folder's id. */
  id: string;
  name: string;
  icon: string;
  color: string;
  /** The film's shape. */
  aspect: AspectId;
  timeline: EditTimeline;
  /** The Director's set as it was left in this project (lib/director/types Scene). */
  scene?: unknown;
  mode: EditMode;
  /** Files added from your computer (takes are found through the folder). */
  uploads: EditFile[];
  createdAt: number;
  updatedAt: number;
};

/** A project in the list: enough to show and open it. */
export type EditProjectSummary = Pick<EditProject, "id" | "name" | "icon" | "color" | "aspect" | "createdAt" | "updatedAt"> & {
  cover?: string;
  clips: number;
  seconds: number;
};

export const emptyTimeline = (): EditTimeline => ({ main: [], music: [] });

/** How long a picture stays on screen when it's dropped on the timeline. */
export const STILL_SECONDS = 3;
/** The shortest piece the timeline keeps. */
export const MIN_SECONDS = 0.2;
export const MAX_STILL_SECONDS = 60;
export const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
/** Frames per second the film plays and exports at. */
export const FPS = 30;

export const speedOf = (c: Pick<EditClip, "speed">) => (c.speed && c.speed > 0 ? c.speed : 1);
/** Seconds on screen. */
export const lengthOf = (c: EditClip) => Math.max(MIN_SECONDS, (c.out - c.in) / speedOf(c));

/** A clip on the main track with where it starts and ends in the film. */
export type Placed = { clip: EditClip; index: number; start: number; end: number };

export function placed(main: EditClip[]): Placed[] {
  let start = 0;
  return main.map((clip, index) => {
    const end = start + lengthOf(clip);
    const p = { clip, index, start, end };
    start = end;
    return p;
  });
}

/** The film's length: its pictures and clips (sounds past the end are cut there). */
export const filmLength = (t: EditTimeline) => t.main.reduce((s, c) => s + lengthOf(c), 0);

/** The piece of the main track playing at `t` (the last one at the very end). */
export function placedAt(list: Placed[], t: number): Placed | null {
  if (!list.length) return null;
  for (const p of list) if (t < p.end - 1e-6) return p;
  return list[list.length - 1];
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/** A file as a new piece of the timeline. */
export function clipFromFile(file: EditFile, id: string, at?: number): EditClip {
  const length = file.duration && file.duration > 0 ? round(file.duration) : undefined;
  const base = { id, url: file.url, kind: file.kind, name: file.name, gen: file.gen, width: file.width, height: file.height } satisfies Partial<EditClip>;
  if (file.kind === "image") return { ...base, in: 0, out: STILL_SECONDS };
  if (file.kind === "audio") return { ...base, length, in: 0, out: length ?? 10, at: Math.max(0, at ?? 0), volume: 0.8 };
  return { ...base, length, sound: file.sound, in: 0, out: length ?? 5 };
}

/** Pixel size of the film at a quality, by its shape (even numbers, as video encoders want). */
export function filmSize(aspect: AspectId, quality: "720p" | "1080p"): [number, number] {
  const short = quality === "720p" ? 720 : 1080;
  const [w, h] = aspect.split(":").map(Number);
  const even = (n: number) => Math.round(n / 2) * 2;
  return w >= h ? [even((short * w) / h), short] : [short, even((short * h) / w)];
}

/** "1:05.4" */
export function timecode(t: number, tenths = true) {
  const s = Math.max(0, t);
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  const whole = Math.floor(sec);
  return `${m}:${String(whole).padStart(2, "0")}${tenths ? `.${Math.floor((sec - whole) * 10)}` : ""}`;
}

/** The shapes a film can have. */
export const FILM_ASPECTS: AspectId[] = ["16:9", "9:16", "1:1", "4:5", "21:9"];
