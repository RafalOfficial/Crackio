import "server-only";
import type { LocalModel } from "@/lib/local/types";

/**
 * The picture model a training run's test pictures are drawn with ("the drawer"): which one a machine would get, and
 * whether it's there. One rule for the run (which sets it up before training) and for the Train page (which says, before
 * you press Start, what the machine still needs).
 */

type Gpu = { memoryGb?: number | null; compute?: number | null } | null | undefined;

/**
 * The version of the family's picture model to set up on a machine that has none: the smallest that runs there as it
 * is. None that needs an extra ComfyUI node (a GGUF one's test pictures failed with "CLIPLoaderGGUF not found") or a
 * newer kind of card than this one is known to be.
 */
export function pickDrawer(uses: string[], gpu: Gpu, models: LocalModel[]) {
  const wanted = models.find((x) => x.id === uses[0] && x.crackio);
  const mem = gpu?.memoryGb ?? 0;
  const compute = gpu?.compute;
  const bytes = (v: { files: { bytes: number }[] }) => v.files.reduce((n, f) => n + f.bytes, 0);
  const variant = wanted?.variants
    .filter((v) => v.needGb <= mem - 1.2 && !v.requires?.customNodes?.length && (!v.requires?.compute || (compute != null && compute >= v.requires.compute)))
    .sort((x, y) => bytes(x) - bytes(y))[0];
  return wanted && variant ? { model: wanted, variant } : null;
}

/** What the Train page shows of it for one machine. */
export type DrawerNeed = {
  /** The model's name ("Qwen-Image 2.1"). */
  name: string;
  /** The version a run would download ("INT8"); null when the model is there already, or none runs there. */
  variant: string | null;
  /** Bytes a run downloads for it first, past what the training weights' download brings anyway (0: it's there, or it all comes with those). */
  bytes: number;
  there: boolean;
  /** Not there yet, and nothing more to download: its files are the training weights' own (SDXL's one checkpoint). */
  shared?: true;
  /** None of its versions runs on this machine as it is: a run there draws no test pictures until you set one up. */
  none?: true;
};

/**
 * On the current machine (inside its `withTarget`): the drawer's state for a model family's `uses`. Null: the family has
 * none. `coming` are the files ("folder/name") the run's training weights download anyway: not counted twice.
 */
export async function drawerNeed(uses: string[], gpu: Gpu, coming = new Set<string>()): Promise<DrawerNeed | null> {
  if (!uses.length) return null;
  const [{ allLocalModels }, { hasModelHere, installedFiles }] = await Promise.all([import("../local-templates"), import("../local-models")]);
  const models = allLocalModels();
  for (const id of uses) {
    const m = models.find((x) => x.id === id && x.crackio);
    if (m && (await hasModelHere(m).catch(() => false))) return { name: m.name, variant: null, bytes: 0, there: true };
  }
  const name = models.find((x) => x.id === uses[0])?.name ?? "the picture model";
  const pick = pickDrawer(uses, gpu, models);
  if (!pick) return { name, variant: null, bytes: 0, there: false, none: true };
  const have = await installedFiles().catch(() => new Set<string>());
  const bytes = pick.variant.files.filter((f) => !have.has(`${f.folder}/${f.name}`) && !coming.has(`${f.folder}/${f.name}`)).reduce((n, f) => n + f.bytes, 0);
  return { name: pick.model.name, variant: pick.variant.label, bytes, there: false, ...(bytes ? {} : { shared: true as const }) };
}
