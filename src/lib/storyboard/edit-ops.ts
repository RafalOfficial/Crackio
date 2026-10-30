import { MAX_STILL_SECONDS, MIN_SECONDS, lengthOf, placed, speedOf, type EditClip, type EditFile, type EditTimeline } from "./edit";

/**
 * Changes to a timeline, each returning a new one (the editor keeps the old ones for undo). The main track is
 * magnetic: pictures and clips always follow each other, so taking one out or shortening it pulls the rest in.
 */

const round = (n: number) => Math.round(n * 1000) / 1000;

const trackOf = (t: EditTimeline, id: string): "main" | "music" | null => (t.main.some((c) => c.id === id) ? "main" : t.music.some((c) => c.id === id) ? "music" : null);

export const findClip = (t: EditTimeline, id: string | null | undefined) => (id ? (t.main.find((c) => c.id === id) ?? t.music.find((c) => c.id === id) ?? null) : null);

export function insertMain(t: EditTimeline, clip: EditClip, index = t.main.length): EditTimeline {
  const main = [...t.main];
  main.splice(Math.max(0, Math.min(index, main.length)), 0, clip);
  return { ...t, main };
}

export function addMusic(t: EditTimeline, clip: EditClip): EditTimeline {
  return { ...t, music: [...t.music, { ...clip, at: round(Math.max(0, clip.at ?? 0)) }] };
}

/** Move a piece of the main track so it sits at `to` (an index in the track without it). */
export function moveMain(t: EditTimeline, id: string, to: number): EditTimeline {
  const from = t.main.findIndex((c) => c.id === id);
  if (from < 0) return t;
  const main = [...t.main];
  const [clip] = main.splice(from, 1);
  main.splice(Math.max(0, Math.min(to, main.length)), 0, clip);
  return main.every((c, i) => c === t.main[i]) ? t : { ...t, main };
}

export function removeClip(t: EditTimeline, id: string): EditTimeline {
  const track = trackOf(t, id);
  if (!track) return t;
  return { ...t, [track]: t[track].filter((c) => c.id !== id) };
}

/** A piece swapped for another in the same place (a picture whose clip is done). */
export function replaceClip(t: EditTimeline, id: string, clip: EditClip): EditTimeline {
  const track = trackOf(t, id);
  if (!track) return t;
  return { ...t, [track]: t[track].map((c) => (c.id === id ? fitted(clip) : c)) };
}

export function patchClip(t: EditTimeline, id: string, patch: Partial<EditClip>): EditTimeline {
  const track = trackOf(t, id);
  if (!track) return t;
  return { ...t, [track]: t[track].map((c) => (c.id === id ? fitted({ ...c, ...patch }) : c)) };
}

/** A clip's settings kept to what it can do: its part inside the file, its speed and volume in range. */
export function fitted(c: EditClip): EditClip {
  const speed = Math.min(4, Math.max(0.25, speedOf(c)));
  const next = { ...c, speed: speed === 1 ? undefined : speed };
  if (c.kind === "image") {
    next.in = 0;
    next.out = round(Math.min(MAX_STILL_SECONDS, Math.max(MIN_SECONDS, c.out)));
    next.speed = undefined;
  } else {
    const end = c.length && c.length > 0 ? c.length : Infinity;
    next.in = round(Math.max(0, Math.min(c.in, end - MIN_SECONDS * speed)));
    next.out = round(Math.max(next.in + MIN_SECONDS * speed, Math.min(c.out, end)));
  }
  if (c.volume !== undefined) next.volume = Math.min(1, Math.max(0, c.volume));
  const room = lengthOf(next) / 2;
  if (c.fadeIn !== undefined) next.fadeIn = c.fadeIn > 0 ? round(Math.min(c.fadeIn, room)) : undefined;
  if (c.fadeOut !== undefined) next.fadeOut = c.fadeOut > 0 ? round(Math.min(c.fadeOut, room)) : undefined;
  if (c.at !== undefined) next.at = round(Math.max(0, c.at));
  return next;
}

/**
 * One edge of a piece moved by `delta` seconds of the film (positive = right). The left edge of a clip starts it later
 * in its file; a picture has no time of its own, so either edge only changes how long it stays.
 */
export function trimmed(c: EditClip, edge: "in" | "out", delta: number): EditClip {
  const speed = speedOf(c);
  if (c.kind === "image") return fitted({ ...c, out: c.out + (edge === "in" ? -delta : delta) });
  if (edge === "in") {
    const next = fitted({ ...c, in: c.in + delta * speed });
    // A sound starts where its new first second now plays.
    if (c.at !== undefined) next.at = round(Math.max(0, c.at + (next.in - c.in) / speed));
    return next;
  }
  return fitted({ ...c, out: c.out + delta * speed });
}

/** Cut the piece under `t` (seconds of the film) in two. The second half gets `newId`. */
export function splitAt(t: EditTimeline, id: string, at: number, newId: string): EditTimeline {
  const track = trackOf(t, id);
  if (!track) return t;
  const clip = t[track].find((c) => c.id === id)!;
  const start = track === "main" ? (placed(t.main).find((p) => p.clip.id === id)?.start ?? 0) : (clip.at ?? 0);
  const into = at - start;
  const length = lengthOf(clip);
  if (into < MIN_SECONDS || into > length - MIN_SECONDS) return t;
  const speed = speedOf(clip);
  const cut = clip.kind === "image" ? round(into) : round(clip.in + into * speed);
  const first: EditClip = { ...clip, out: cut, fadeOut: undefined };
  const second: EditClip =
    clip.kind === "image"
      ? { ...clip, id: newId, out: round(length - into), fadeIn: undefined, making: undefined }
      : { ...clip, id: newId, in: cut, fadeIn: undefined, ...(clip.at !== undefined ? { at: round(start + into) } : {}) };
  const list = t[track].flatMap((c) => (c.id === id ? [first, second] : [c]));
  return { ...t, [track]: list };
}

export function duplicate(t: EditTimeline, id: string, newId: string): EditTimeline {
  const track = trackOf(t, id);
  if (!track) return t;
  const clip = t[track].find((c) => c.id === id)!;
  const copy: EditClip = { ...clip, id: newId, making: undefined };
  if (track === "music") return addMusic(t, { ...copy, at: (clip.at ?? 0) + lengthOf(clip) });
  return insertMain(t, copy, t.main.findIndex((c) => c.id === id) + 1);
}

/** A picture whose clip is done becomes that clip, in the same place. */
export function becomeClip(c: EditClip, file: EditFile): EditClip {
  const length = file.duration && file.duration > 0 ? round(file.duration) : undefined;
  return {
    id: c.id,
    url: file.url,
    kind: "video",
    name: file.name,
    gen: file.gen,
    width: file.width,
    height: file.height,
    length,
    sound: file.sound,
    in: 0,
    out: length ?? lengthOf(c),
    fit: c.fit,
    fadeIn: c.fadeIn,
    fadeOut: c.fadeOut,
  };
}

/** The index a piece dropped at `x` seconds of the film goes to: before the piece whose middle is past it. */
export function dropIndex(main: EditClip[], x: number, without?: string) {
  const list = placed(main.filter((c) => c.id !== without));
  for (const p of list) if (x < (p.start + p.end) / 2) return p.index;
  return list.length;
}
