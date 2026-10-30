"use client";

import { create } from "zustand";
import { nanoid } from "nanoid";
import { useDirector } from "@/lib/director/store";
import { makeCutout, readSubject } from "@/lib/director/vision";
import { guessKind } from "@/lib/director/standin";
import { ELEMENT_DEFAULTS } from "@/lib/director/vocab";
import type { ElementKind, SceneElement } from "@/lib/director/types";
import { useShotModel } from "./shot-model";

/**
 * Getting photos onto the set: upload, lift people and things off their backgrounds, then
 * place them. While that runs, a pending card shows in the cast list.
 */
export type Pending = { id: string; name: string; thumb: string; stage: string; error?: string };

export const useIntake = create<{ pending: Pending[]; note: string | null; placeError: string | null; placeBusy: boolean; drawing: string[]; casting: string[] }>(() => ({
  pending: [],
  note: null,
  placeError: null,
  placeBusy: false,
  /** Subjects being drawn from every side. */
  drawing: [],
  /** People and pets whose Cast sheet is being made from their photo. */
  casting: [],
}));

const patch = (id: string, p: Partial<Pending>) =>
  useIntake.setState((s) => ({ pending: s.pending.map((x) => (x.id === id ? { ...x, ...p } : x)) }));
const drop = (id: string) => useIntake.setState((s) => ({ pending: s.pending.filter((x) => x.id !== id) }));

export function dismissPending(id: string) {
  const item = useIntake.getState().pending.find((x) => x.id === id);
  if (item?.thumb.startsWith("blob:")) URL.revokeObjectURL(item.thumb);
  drop(id);
}

type Uploaded = { url: string; width: number; height: number; hasAlpha: boolean };

export async function uploadImage(file: File): Promise<Uploaded> {
  const body = new FormData();
  body.append("file", file);
  const res = await fetch("/api/uploads", { method: "POST", body });
  const data = (await res.json()) as { items?: Uploaded[]; error?: string };
  if (!res.ok || !data.items?.[0]) throw new Error(data.error ?? "Upload failed");
  return data.items[0];
}

const nameOf = (file: File) => file.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim().slice(0, 32) || "Subject";

/** Cut out a picture that's already stored and put it on set. */
export async function addToCast(src: { url: string; name: string; thumb?: string; kind?: ElementKind; look?: string; height?: number; cast?: SceneElement["cast"]; read?: SceneElement["read"]; views?: SceneElement["views"] }) {
  const id = nanoid(6);
  useIntake.setState((s) => ({ pending: [...s.pending, { id, name: src.name, thumb: src.thumb ?? src.url, stage: "Cutting out" }] }));
  try {
    const cut = await makeCutout(src.url);
    // A first guess at what it is (its name, its shape) until a vision model has looked at it.
    const kind = src.kind ?? guessKind(src.name, cut.cutout ? cut.width / cut.height : undefined) ?? "person";
    const added = useDirector.getState().addElement({
      kind,
      kindAuto: !src.kind,
      name: src.name,
      look: src.look,
      ...(src.height ? { height: src.height } : kind !== "person" ? { height: ELEMENT_DEFAULTS[kind].height } : {}),
      image: { url: cut.url, width: cut.width, height: cut.height, cutout: cut.cutout, sourceUrl: src.url },
      ...(src.cast ? { cast: src.cast } : {}),
      ...(src.read ? { read: src.read } : {}),
      ...(src.views?.length ? { views: src.views } : {}),
    });
    if (cut.note) useIntake.setState({ note: `${src.name}: ${cut.note}` });
    dismissPending(id);
    // A Cast member is already known (its sheet's front view faces the camera); anyone else is read first.
    if (!src.read) void learnWhatItIs(added, src.url);
  } catch (err) {
    patch(id, { stage: "", error: (err as Error).message });
  }
}

/**
 * A vision model reads the picture: what it is ("a matte black Tesla Cybertruck"), what makes it look like itself,
 * its real height and which side of it the photo shows. A kind or height you set yourself stays. Learning the side
 * turns the subject, not its card: the card stays as it stood, and `yaw` becomes where the subject really faces.
 */
export async function learnWhatItIs(id: string, url: string) {
  const read = await readSubject(url);
  const el = read && useDirector.getState().scene.elements.find((e) => e.id === id);
  if (!read || !el) return;
  const around = read.around ?? 0;
  const patch: Partial<SceneElement> = { read: { noun: read.noun, identity: read.identity, around } };
  if (el.read?.around === undefined && around) patch.yaw = Math.round((((el.yaw - around + 540) % 360) + 360) % 360) - 180;
  const kind = el.kindAuto ? read.kind : el.kind;
  if (kind !== el.kind) patch.kind = kind;
  // Its height, unless you changed it (it's still the default for the kind it was given).
  if (el.height === ELEMENT_DEFAULTS[el.kind].height || kind !== el.kind) patch.height = read.height ?? ELEMENT_DEFAULTS[kind].height;
  useDirector.getState().updateElement(id, patch, true);
  void drawAllSides(id);
  if ((kind === "person" || kind === "animal") && !el.cast) void castFromPhoto(id);
}

export type CastMember = { id: string; name: string; handle: string; kind: string; portrait?: string; sheet?: string; noun?: string; traits?: string; height?: number };

/** Put a Cast member on set: their sheet's front view stands there, their sheet is who they are to the model. */
export async function addFromCast(member: CastMember) {
  const res = await fetch("/api/director/cast", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: member.id }) });
  const data = (await res.json().catch(() => ({}))) as { stage?: string; cast?: SceneElement["cast"]; noun?: string; traits?: string; height?: number; views?: SceneElement["views"]; error?: string };
  if (!res.ok || !data.stage) {
    useIntake.setState({ note: `${member.name}: ${data.error ?? "couldn't be added"}` });
    return;
  }
  const kind: ElementKind = member.kind === "pet" ? "animal" : member.kind === "object" ? (guessKind(member.noun ?? member.name) ?? "object") : "person";
  await addToCast({
    url: data.stage,
    thumb: member.portrait,
    name: member.name,
    kind,
    height: data.height,
    cast: data.cast,
    read: data.noun ? { noun: data.noun, identity: data.traits ?? "", around: 0 } : undefined,
    views: data.views,
  });
}

/** A Cast member on set without its sheet's views (put there before they existed) gets them. */
export async function castViews(id: string) {
  const el = useDirector.getState().scene.elements.find((e) => e.id === id);
  if (!el?.cast?.id || el.views?.length || useIntake.getState().drawing.includes(id)) return;
  useIntake.setState((s) => ({ drawing: [...s.drawing, id] }));
  try {
    const res = await fetch("/api/director/cast", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: el.cast.id, viewsOnly: true }) });
    const data = (await res.json().catch(() => ({}))) as { views?: SceneElement["views"] };
    if (res.ok && data.views?.length) useDirector.getState().updateElement(id, { views: data.views }, true);
  } finally {
    useIntake.setState((s) => ({ drawing: s.drawing.filter((x) => x !== id) }));
  }
}

/**
 * People and pets come from Cast: one put on set from a photo gets a Cast entry made from it (its reference sheet: front,
 * three-quarter and side), linked once it's ready. Until then the photo stands in for them.
 */
async function castFromPhoto(id: string) {
  const el = useDirector.getState().scene.elements.find((e) => e.id === id);
  if (!el?.image || el.cast || useIntake.getState().casting.includes(id)) return;
  useIntake.setState((s) => ({ casting: [...s.casting, id] }));
  try {
    const res = await fetch("/api/cast", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: el.name.slice(0, 40), kind: el.kind === "animal" ? "pet" : "person", photos: [el.image.sourceUrl ?? el.image.url], model: useShotModel.getState().model }),
    });
    const made = (await res.json().catch(() => ({}))) as { item?: { id: string } };
    if (!made.item) return;
    for (let i = 0; i < 150; i++) {
      await new Promise((r) => setTimeout(r, 4000));
      const list = (await (await fetch("/api/cast", { cache: "no-store" })).json().catch(() => ({}))) as { items?: { id: string; handle: string; status: string; sheet?: string; portrait?: string }[] };
      const c = list.items?.find((x) => x.id === made.item!.id);
      if (!c || c.status === "error") return;
      if (c.status === "ready" && c.sheet) {
        useDirector.getState().updateElement(id, { cast: { id: c.id, handle: c.handle, sheet: c.sheet, portrait: c.portrait } }, true);
        return;
      }
    }
  } finally {
    useIntake.setState((s) => ({ casting: s.casting.filter((x) => x !== id) }));
  }
}

/**
 * Draw a subject from every side with the model you shoot with, for the camera view (server/director drawTurnaround).
 * Once per picture and model; a subject with drawings keeps them.
 */
export async function drawAllSides(id: string) {
  const el = useDirector.getState().scene.elements.find((e) => e.id === id);
  if (!el?.image || el.views?.length || useIntake.getState().drawing.includes(id)) return;
  useIntake.setState((s) => ({ drawing: [...s.drawing, id] }));
  try {
    const res = await fetch("/api/director/views", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ element: el, model: useShotModel.getState().model }),
    });
    const data = (await res.json().catch(() => ({}))) as { views?: SceneElement["views"]; error?: string };
    const now = useDirector.getState().scene.elements.find((e) => e.id === id);
    // Only for the same picture: a subject given another photo meanwhile is drawn again from that one.
    if (res.ok && data.views?.length && now?.image?.url === el.image.url) useDirector.getState().updateElement(id, { views: data.views }, true);
  } finally {
    useIntake.setState((s) => ({ drawing: s.drawing.filter((x) => x !== id) }));
  }
}

export async function addFilesToCast(files: File[]) {
  const images = files.filter((f) => f.type.startsWith("image/")).slice(0, 8);
  await Promise.all(
    images.map(async (file) => {
      const id = nanoid(6);
      const thumb = URL.createObjectURL(file);
      useIntake.setState((s) => ({ pending: [...s.pending, { id, name: nameOf(file), thumb, stage: "Uploading" }] }));
      try {
        const item = await uploadImage(file);
        drop(id);
        // The local preview stays as the thumbnail until the cutout lands (dismissPending frees it).
        await addToCast({ url: item.url, name: nameOf(file), thumb });
      } catch (err) {
        patch(id, { stage: "", error: (err as Error).message });
      }
    }),
  );
}

/** Another photo of the location from the same spot, facing another way (behind, beside). */
export async function addPlacePhotoFile(file: File) {
  if (!file.type.startsWith("image/")) return;
  useIntake.setState({ placeError: null, placeBusy: true });
  try {
    useDirector.getState().addPlacePhoto(await uploadImage(file));
  } catch (err) {
    useIntake.setState({ placeError: (err as Error).message });
  } finally {
    useIntake.setState({ placeBusy: false });
  }
}

/** Use a photo as the location. Its 3D set is built on the stage as soon as its depth arrives. */
export async function setPlaceFile(file: File) {
  if (!file.type.startsWith("image/")) return;
  useIntake.setState({ placeError: null, placeBusy: true });
  try {
    const item = await uploadImage(file);
    useDirector.getState().setPlace(item);
  } catch (err) {
    useIntake.setState({ placeError: (err as Error).message });
  } finally {
    useIntake.setState({ placeBusy: false });
  }
}
