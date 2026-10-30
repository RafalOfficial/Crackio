"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** x0, y0, x1, y1 in 0–1000 of the picture. */
export type Box = [number, number, number, number];
/** Something found in the picture: a whole thing, or one of its parts. */
export type Thing = { id: string; label: string; detail: string; box: Box };
/** A whole thing, and its parts once they've been looked for. */
export type Found = Thing & { parts: Thing[] | null; partsState: "idle" | "loading" | "done" | "error" };

export type Attachment = { url: string; preview: string; description?: string; describing?: boolean; error?: string };
/** One change, pinned where you clicked: on a thing (or one of its parts), or on a bare spot. */
export type Pin = { id: string; at: [number, number]; root?: Thing; part?: Thing; text: string; image?: Attachment; t?: number };

/** What a pin points at, for its card and the edit prompt. */
export function pinTarget(p: Pick<Pin, "at" | "root" | "part">): { name: string; detail: string; box: Box | null } {
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const lower = (s: string) => s.replace(/\.$/, "").replace(/^[A-Z](?![A-Z])/, (c) => c.toLowerCase());
  if (p.root && p.part) return { name: `${cap(p.root.label)} › ${cap(p.part.label)}`, detail: `the ${lower(p.part.detail)} of the ${lower(p.root.detail)}`, box: p.part.box };
  if (p.root) return { name: cap(p.root.label), detail: `the ${lower(p.root.detail)}`, box: p.root.box };
  return { name: "This spot", detail: "the spot", box: null };
}

export const boxArea = (b: Box) => (b[2] - b[0]) * (b[3] - b[1]);
export const inBox = (b: Box, [x, y]: [number, number]) => x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3];
/** The smallest of these that holds the point: the most precise thing under the cursor. */
export function smallestAt<T extends { box: Box }>(list: T[], at: [number, number]): T | null {
  let best: T | null = null;
  for (const t of list) if (inBox(t.box, at) && (!best || boxArea(t.box) < boxArea(best.box))) best = t;
  return best;
}

/** "the top left of the picture (x 25–40%, y 10–35%)" */
export function where(box: Box, of = "picture") {
  const [x0, y0, x1, y1] = box;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const h = cx < 333 ? "left" : cx < 667 ? "center" : "right";
  const v = cy < 333 ? "top" : cy < 667 ? "middle" : "bottom";
  const spot = v === "middle" && h === "center" ? "the center" : v === "middle" ? `the ${h} side` : `the ${v} ${h === "center" ? "middle" : h}`;
  const pct = (n: number) => Math.round(n / 10);
  return `${spot} of the ${of} (x ${pct(x0)}–${pct(x1)}%, y ${pct(y0)}–${pct(y1)}%)`;
}

/* ------------------------------------------------------------------ loading */

type ThingsAnswer = { things: Thing[]; error?: string };
type PartsAnswer = { box: Box; parts: Thing[] };

// Shared across the page: the same picture is looked at once, and remounts reuse the answer.
const thingsCache = new Map<string, Promise<ThingsAnswer>>();
const partsCache = new Map<string, Promise<PartsAnswer | null>>();

async function post<T>(body: unknown): Promise<T> {
  const res = await fetch("/api/detect", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? "Couldn't look at the picture.");
  return data;
}

function thingsOf(image: string) {
  let p = thingsCache.get(image);
  if (!p) {
    p = post<ThingsAnswer>({ image }).catch((err: Error) => ({ things: [], error: err.message }));
    thingsCache.set(image, p);
    // A failed look is tried again next time.
    void p.then((a) => a.error && !a.things.length && thingsCache.delete(image));
  }
  return p;
}

// Parts are found two at a time, the one you clicked first.
const waiting: { key: string; run: () => Promise<void> }[] = [];
let running = 0;
function pump() {
  while (running < 2 && waiting.length) {
    const job = waiting.shift()!;
    running++;
    void job.run().finally(() => {
      running--;
      pump();
    });
  }
}

function partsOf(image: string, t: Thing, urgent: boolean): Promise<PartsAnswer | null> {
  const key = `${image}|${t.id}|${t.box.join(",")}`;
  const hit = partsCache.get(key);
  if (hit) {
    // Already waiting: move it to the front.
    const i = waiting.findIndex((w) => w.key === key);
    if (urgent && i > 0) waiting.unshift(...waiting.splice(i, 1));
    return hit;
  }
  const p = new Promise<PartsAnswer | null>((resolve) => {
    const job = { key, run: () => post<PartsAnswer>({ image, parent: t }).then(resolve, () => resolve(null)) };
    if (urgent) waiting.unshift(job);
    else waiting.push(job);
    pump();
  });
  partsCache.set(key, p);
  void p.then((a) => !a && partsCache.delete(key));
  return p;
}

/** How many of the most prominent things get their parts looked for before anyone asks. */
const EAGER = 4;

/**
 * The things in a picture, found once it's on screen (the picture shows right away; boxes arrive
 * when they're found), and each thing's parts: the first few right after, any other on request.
 */
/** `eager`: how many things get their parts looked for right away (0 when only whole things matter). */
export function useThings(image: string | null, eager = EAGER) {
  const [state, setState] = useState<{ image: string | null; status: "loading" | "ready" | "error"; things: Found[]; error?: string }>({ image: null, status: "loading", things: [] });
  const current = useRef<string | null>(null);

  const setParts = useCallback((img: string, id: string, patch: Partial<Found>) => {
    if (current.current !== img) return;
    setState((s) => (s.image === img ? { ...s, things: s.things.map((t) => (t.id === id ? { ...t, ...patch } : t)) } : s));
  }, []);

  const load = useCallback(
    (img: string, t: Thing, urgent: boolean) => {
      setParts(img, t.id, { partsState: "loading" });
      void partsOf(img, t, urgent).then((a) => setParts(img, t.id, a ? { parts: a.parts, box: a.box, partsState: "done" } : { partsState: "error" }));
    },
    [setParts],
  );

  useEffect(() => {
    current.current = image;
    if (!image) return;
    let alive = true;
    void Promise.resolve().then(() => alive && setState({ image, status: "loading", things: [] }));
    void thingsOf(image).then((a) => {
      if (!alive) return;
      const things: Found[] = a.things.map((t) => ({ ...t, parts: null, partsState: "idle" }));
      setState({ image, status: a.error && !things.length ? "error" : "ready", things, error: a.error });
      for (const t of things.slice(0, eager)) load(image, t, false);
    });
    return () => {
      alive = false;
    };
  }, [image, load, eager]);

  /** Look for a thing's parts now (you clicked it). */
  const needParts = useCallback(
    (id: string) => {
      const img = current.current;
      const t = state.things.find((x) => x.id === id);
      if (!img || !t || t.partsState === "done") return;
      if (t.partsState === "loading") void partsOf(img, t, true);
      else load(img, t, true);
    },
    [state.things, load],
  );

  const mine = state.image === image;
  return { status: mine ? state.status : "loading", things: mine ? state.things : [], error: mine ? state.error : undefined, needParts } as const;
}
