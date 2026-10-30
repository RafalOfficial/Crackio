import ideas from "./previews.json";

/**
 * Product Studio's previews: every option shot with sample products through the real pipeline
 * (scripts/assets/product-previews.mjs), so a preview shows what the option does and how it fits
 * itself to very different products. `ideas` holds what the director made of each one; an option
 * has a preview for every sample listed there.
 *
 * The samples span what people sell (food, drinks, beauty, fashion, tech, home, pets), so the
 * page shows at a glance that any product works, and the previews look like the product you add.
 */
export const SAMPLES = [
  { id: "drink", label: "Sports drink", width: 683, height: 1024, like: ["drink"] },
  { id: "cookies", label: "Cookies", width: 1024, height: 1024, like: ["food", "kitchenware"] },
  { id: "capsules", label: "Supplement", width: 1024, height: 1024, like: ["supplement", "health"] },
  { id: "serum", label: "Skincare", width: 1024, height: 1024, like: ["skincare", "haircare", "cleaning", "baby"] },
  { id: "perfume", label: "Perfume", width: 1024, height: 1024, like: ["fragrance", "makeup"] },
  { id: "tee", label: "T-shirt", width: 1024, height: 1024, like: ["apparel"] },
  { id: "sneakers", label: "Sneakers", width: 1024, height: 683, like: ["footwear", "fitness", "outdoor"] },
  { id: "headphones", label: "Headphones", width: 1024, height: 1024, like: ["electronics", "tool", "vehicle"] },
  { id: "candle", label: "Candle", width: 1024, height: 1024, like: ["home", "furniture", "stationery", "book"] },
  { id: "watch", label: "Watch", width: 1024, height: 1024, like: ["watch", "jewelry", "eyewear", "accessory"] },
  { id: "bag", label: "Handbag", width: 1024, height: 1024, like: ["bag"] },
  { id: "treats", label: "Dog treats", width: 1024, height: 1024, like: ["pet"] },
].map((s) => ({ ...s, url: `/assets/product/samples/${s.id}.webp`, thumb: `/assets/product/samples/${s.id}-t.webp` }));

export type SampleId = "drink" | "cookies" | "capsules" | "serum" | "perfume" | "tee" | "sneakers" | "headphones" | "candle" | "watch" | "bag" | "treats";
export type PreviewAxis = "moment" | "scene" | "camera" | "light" | "finish";

export const sampleById = (id: SampleId) => SAMPLES.find((s) => s.id === id)!;

/**
 * The kind of shot the previews are made in. An option looks different on its own than in someone's
 * hands, so camera, light, finish and scene previews follow the shot you picked: "alone" for the
 * product on its own, "person" for someone using it. Each axis's first context is its original set.
 */
export type PreviewContext = "auto" | "alone" | "person";
const CONTEXTS: Record<PreviewAxis, PreviewContext[]> = {
  moment: ["auto"],
  scene: ["auto", "alone", "person"],
  camera: ["alone", "person"],
  light: ["alone", "person"],
  finish: ["person", "alone"],
};

const ALONE = ["still", "ingredients", "motion"];
const PERSON = ["hand", "use", "together", "creator"];

/** The previews to show for an axis, given the shot (moment) you picked. */
export function contextFor(axis: PreviewAxis, moment: string): PreviewContext {
  const kind: PreviewContext = ALONE.includes(moment) ? "alone" : PERSON.includes(moment) ? "person" : "auto";
  const list = CONTEXTS[axis];
  return list.includes(kind) ? kind : list[0];
}

/** How the previews are shown, in words, when they follow your shot. */
export function contextNote(ctx: PreviewContext): string | null {
  return ctx === "person" ? "Previews show someone using the product, like your shot" : ctx === "alone" ? "Previews show the product on its own, like your shot" : null;
}

const suffix = (axis: PreviewAxis, ctx?: PreviewContext) => (ctx && ctx !== CONTEXTS[axis][0] ? `-${ctx}` : "");
const IDEAS = ideas as Record<string, Partial<Record<SampleId, string>>>;

/** The context an option really has previews in: the one asked for, else the axis's original set. */
function have(axis: PreviewAxis, id: string, ctx?: PreviewContext): PreviewContext {
  return ctx && IDEAS[`${axis}-${id}${suffix(axis, ctx)}`] ? ctx : CONTEXTS[axis][0];
}

export function previewSrc(axis: PreviewAxis, id: string, sample: SampleId, thumb = false, ctx?: PreviewContext) {
  const c = suffix(axis, have(axis, id, ctx));
  return `/assets/product/${axis}-${id}${c}-${sample}${thumb ? "-t" : ""}.webp`;
}

export function previewIdea(axis: PreviewAxis, id: string, sample: SampleId, ctx?: PreviewContext): string {
  return IDEAS[`${axis}-${id}${suffix(axis, have(axis, id, ctx))}`]?.[sample] ?? "";
}

/** The samples an option has previews for (in this context), in the samples' order. */
export function previewSamples(axis: PreviewAxis, id: string, ctx?: PreviewContext): SampleId[] {
  const entry = IDEAS[`${axis}-${id}${suffix(axis, have(axis, id, ctx))}`];
  return entry ? SAMPLES.filter((s) => s.id in entry).map((s) => s.id as SampleId) : [];
}

/** The sample closest to your product (by its category), so the previews look like what you'll get. */
export function sampleFor(category?: string | null): SampleId | null {
  if (!category) return null;
  return (SAMPLES.find((s) => s.like.includes(category))?.id as SampleId | undefined) ?? null;
}

/**
 * Which sample an option's tile shows: yours (or the closest to it) when the option has one, else
 * a different one per tile so a grid shows the range of products at a glance.
 */
export function tileSample(available: SampleId[], mine: SampleId | null, index: number): SampleId | null {
  if (!available.length) return null;
  if (mine && available.includes(mine)) return mine;
  return available[(index * 5 + 1) % available.length];
}
