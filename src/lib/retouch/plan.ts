import { ASPECTS, type AspectId } from "@/lib/shot";

/**
 * How Retouch makes a set of changes. Edit models do their best work on a clean picture and a
 * plain instruction, and they redraw everything they're shown; so each change is made "up close":
 * a crop around it, with enough of its surroundings for context, enlarged, edited on its own, then
 * blended back where it came from. Nearby changes share a crop. A change that covers most of the
 * picture (the background, the light) is made on the whole picture first, with words only.
 * The same plan runs on the server and prices the job on the page.
 */

/** x0, y0, x1, y1 in 0–1000 of the picture. */
export type Box = [number, number, number, number];

export type RetouchChange = {
  id: string;
  /** Where it is (the thing, its part, or the spot clicked). */
  box: Box;
  /** What it is, in words: "the orange beak of the grey pigeon". */
  target: string;
  /** What it should become. */
  text: string;
  /** A picture of how it should look, and its description for models that take words only. */
  image?: { url: string; description?: string };
};

export type RetouchSpec = {
  version: 2;
  /** "closeup": each change on a crop of its own; "whole": one edit of the whole picture. */
  mode: "closeup" | "whole";
  changes: RetouchChange[];
  /** General words: they apply to the whole picture. */
  extra?: string;
  /** In "whole" mode: keep the original's pixels outside the changes. */
  lock?: boolean;
};

/** One close-up: the crop (in 0–1000 of the picture, and in its pixels), its shape, and the changes made in it. */
export type Region = { crop: Box; aspect: AspectId; px: { left: number; top: number; width: number; height: number }; changes: RetouchChange[] };
export type RetouchPlan = { whole: { changes: RetouchChange[]; extra?: string } | null; regions: Region[] };

/** A change covering this much of the picture (or more) is made on the whole picture. */
const WHOLE = 0.45;

const area = (b: Box) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
const union = (a: Box, b: Box): Box => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];

/**
 * The crop around a box, in pixels of a `W`×`H` picture: the box with room around it (more, in
 * proportion, for small things, so the model sees what they belong to), in the nearest shape edit
 * models make, kept inside the picture.
 */
export function cropFor(box: Box, W: number, H: number): { crop: Box; aspect: AspectId; px: { left: number; top: number; width: number; height: number } } {
  const bx0 = (box[0] / 1000) * W;
  const by0 = (box[1] / 1000) * H;
  const bw = Math.max(4, ((box[2] - box[0]) / 1000) * W);
  const bh = Math.max(4, ((box[3] - box[1]) / 1000) * H);
  // Room around it: a ninth of the picture's short side each way (a lot, for a small thing), a quarter of its size for big ones.
  const pad = Math.max(0.25 * Math.max(bw, bh), 0.11 * Math.min(W, H));
  const cw0 = Math.min(W, bw + 2 * pad);
  const ch0 = Math.min(H, bh + 2 * pad);
  const r = cw0 / ch0;
  const toK = (v: number, of: number) => Math.round((v / of) * 1000);
  // The nearest shape a model makes that still holds the whole box inside the picture.
  const shapes = [...ASPECTS].sort((a, b) => Math.abs(Math.log(a.w / a.h / r)) - Math.abs(Math.log(b.w / b.h / r)));
  for (const shape of shapes) {
    const want = shape.w / shape.h;
    // Grow the short side to the shape; at the picture's edge, shrink the other side to keep it.
    let cw = cw0 / ch0 < want ? Math.min(W, ch0 * want) : cw0;
    let ch = cw0 / ch0 < want ? ch0 : Math.min(H, cw0 / want);
    if (cw / ch > want) cw = ch * want;
    else ch = cw / want;
    if (cw < bw - 1 || ch < bh - 1) continue;
    const width = Math.max(8, Math.round(cw));
    const height = Math.max(8, Math.round(ch));
    const left = Math.round(Math.min(Math.max(0, bx0 + bw / 2 - width / 2), W - width));
    const top = Math.round(Math.min(Math.max(0, by0 + bh / 2 - height / 2), H - height));
    return { crop: [toK(left, W), toK(top, H), toK(left + width, W), toK(top + height, H)], aspect: shape.id, px: { left, top, width, height } };
  }
  // Nothing smaller holds it: the whole picture, in its nearest shape.
  const whole = [...ASPECTS].sort((a, b) => Math.abs(Math.log(a.w / a.h / (W / H))) - Math.abs(Math.log(b.w / b.h / (W / H))))[0];
  return { crop: [0, 0, 1000, 1000], aspect: whole.id, px: { left: 0, top: 0, width: W, height: H } };
}

/** The plan for a set of changes on a `W`×`H` picture. */
export function planRetouch(spec: Pick<RetouchSpec, "changes" | "extra" | "mode">, W: number, H: number): RetouchPlan {
  const changes = spec.changes.filter((c) => c.text.trim());
  const extra = spec.extra?.trim() || undefined;
  if (spec.mode === "whole") return { whole: changes.length || extra ? { changes, extra } : null, regions: [] };

  const big = changes.filter((c) => area(c.box) >= WHOLE * 1e6);
  const local = changes.filter((c) => area(c.box) < WHOLE * 1e6);
  const whole = big.length || extra ? { changes: big, extra } : null;

  // Changes side by side share a close-up, when the shared crop isn't much bigger than either one's
  // own: an eye and the beak next to it, yes; a leg and the big pumpkin under it, no.
  let groups = local.map((c) => ({ box: c.box, changes: [c] }));
  for (let merged = true; merged && groups.length > 1; ) {
    merged = false;
    outer: for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        const a = area(cropFor(groups[i].box, W, H).crop);
        const b = area(cropFor(groups[j].box, W, H).crop);
        const both = area(cropFor(union(groups[i].box, groups[j].box), W, H).crop);
        if (both <= 1.8 * Math.min(a, b)) {
          groups[i] = { box: union(groups[i].box, groups[j].box), changes: [...groups[i].changes, ...groups[j].changes] };
          groups = groups.filter((_, k) => k !== j);
          merged = true;
          break outer;
        }
      }
    }
  }
  // A group that grew to most of the picture is made with the whole picture after all.
  const regions: Region[] = [];
  const wholeToo: RetouchChange[] = [];
  for (const g of groups) {
    if (area(g.box) >= WHOLE * 1e6) wholeToo.push(...g.changes);
    else regions.push({ ...cropFor(g.box, W, H), changes: g.changes });
  }
  const wholeAll = whole || wholeToo.length ? { changes: [...(whole?.changes ?? []), ...wholeToo], extra } : null;
  // Bigger close-ups first: smaller ones are blended in after, on top, where they overlap.
  regions.sort((a, b) => area(b.crop) - area(a.crop));
  return { whole: wholeAll, regions };
}

/** How many edits a plan makes (each one is a model call, and priced as one). */
export const editsIn = (p: RetouchPlan) => (p.whole ? 1 : 0) + p.regions.length;

/** "the top left (x 25–40%, y 10–35%)" of a box inside a frame. */
export function placeIn(box: Box, frame: Box = [0, 0, 1000, 1000], of = "picture") {
  const fx = (v: number) => ((v - frame[0]) / Math.max(1, frame[2] - frame[0])) * 1000;
  const fy = (v: number) => ((v - frame[1]) / Math.max(1, frame[3] - frame[1])) * 1000;
  const [x0, y0, x1, y1] = [fx(box[0]), fy(box[1]), fx(box[2]), fy(box[3])].map((n) => Math.min(1000, Math.max(0, n)));
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const h = cx < 333 ? "left" : cx < 667 ? "center" : "right";
  const v = cy < 333 ? "top" : cy < 667 ? "middle" : "bottom";
  const spot = v === "middle" && h === "center" ? "the center" : v === "middle" ? `the ${h} side` : `the ${v} ${h === "center" ? "middle" : h}`;
  const pct = (n: number) => Math.round(n / 10);
  return `${spot} of the ${of} (x ${pct(x0)}–${pct(x1)}%, y ${pct(y0)}–${pct(y1)}%)`;
}
