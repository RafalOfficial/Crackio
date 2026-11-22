import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { customAlphabet } from "nanoid";
import { jobPath, touch } from "./store";
import type { TrainImage, TrainJob } from "@/lib/train/types";
import { MAX_IMAGES, captionFor, trainable } from "@/lib/train/plan";

/**
 * A training job's pictures. Each one you add is kept turned upright as a JPEG (PNG's see-through parts on white), at
 * most 2048 px on its long side: bigger than any model trains at, small enough to send to a rented GPU quickly. Crackio
 * leaves out what can't teach anything (the same picture twice, pictures under 256 px) and says why.
 *
 * An edit LoRA's set is pairs: the same picture before a change and after it. The "after" picture is the pair's
 * picture (what the model learns to make) and carries its "before" picture as `source`. Pictures pair up by their file
 * names ("cat_before.jpg" with "cat_after.jpg", or the same name added as a before and as an after picture), else in the
 * order they're added. A before picture whose after picture hasn't come yet waits (`waiting`), and one that never gets
 * one is redone as a test picture.
 */

const newId = customAlphabet("abcdefghijkmnpqrstuvwxyz23456789", 8);
const LONG_EDGE = 2048;
const TOO_SMALL = 256;

/** A 64-bit fingerprint of how a picture looks (difference hash): the same picture resized or re-saved gives the same one. */
async function fingerprint(img: ReturnType<typeof sharp>): Promise<string> {
  const { data } = await img.clone().greyscale().resize(9, 8, { fit: "fill" }).raw().toBuffer({ resolveWithObject: true });
  let bits = "";
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits += data[y * 9 + x] > data[y * 9 + x + 1] ? "1" : "0";
  return BigInt(`0b${bits}`).toString(16).padStart(16, "0");
}

function distance(a: string, b: string) {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let n = 0;
  const one = BigInt(1);
  while (x) {
    n += Number(x & one);
    x >>= one;
  }
  return n;
}

export type AddResult = { added: TrainImage[]; refused: { name: string; why: string }[] };

const SIDES = "before|after|source|src|input|output|original|orig|target|tgt|result|edited";
const SIDE_LAST = new RegExp(`^(.*?)[\\s._-]+(${SIDES})$`, "i");
const SIDE_FIRST = new RegExp(`^(${SIDES})[\\s._-]+(.*)$`, "i");
const IS_BEFORE = /^(before|source|src|input|original|orig)$/i;

/**
 * A file's name as what pairs it up, and the side of the pair it names, if it names one: "Cat_before.jpg" is the before
 * picture of "cat", "after-cat.png" its after picture, "cat.jpg" just "cat".
 */
export function pairName(name: string): { key: string; side: "before" | "after" | null } {
  const stem = name.replace(/\.[^.]+$/, "").trim();
  const last = stem.match(SIDE_LAST);
  const first = last ? null : stem.match(SIDE_FIRST);
  const word = last ? last[2] : first ? first[1] : null;
  return { key: (last ? last[1] : first ? first[2] : stem).toLowerCase(), side: word ? (IS_BEFORE.test(word) ? "before" : "after") : null };
}

/**
 * Adds pictures to a job. One that can't be read as a picture is refused by name; the rest go in. For an edit LoRA,
 * `as` says which side of a pair they are when their names don't ("before": the pictures before the change).
 */
export async function addImages(job: TrainJob, files: { name: string; data: Buffer }[], as?: "before" | "after"): Promise<AddResult> {
  const added: TrainImage[] = [];
  const refused: AddResult["refused"] = [];
  const edit = job.goal === "edit";
  await fs.mkdir(/*turbopackIgnore: true*/ jobPath(job.id, "images"), { recursive: true });
  for (const f of files) {
    if (job.images.length >= MAX_IMAGES) {
      refused.push({ name: f.name, why: `A set holds up to ${MAX_IMAGES} pictures.` });
      continue;
    }
    try {
      const upright = sharp(f.data, { failOn: "none" }).rotate();
      const meta = await upright.metadata();
      if (!meta.width || !meta.height) throw new Error("not a picture");
      const flat = upright.flatten({ background: "#ffffff" }).resize({ width: LONG_EDGE, height: LONG_EDGE, fit: "inside", withoutEnlargement: true });
      const { data, info } = await flat.jpeg({ quality: 95, chromaSubsampling: "4:4:4" }).toBuffer({ resolveWithObject: true });
      const hash = await fingerprint(sharp(data));
      const id = newId();
      const image: TrainImage = { id, name: f.name.slice(0, 120), file: `${id}.jpg`, width: info.width, height: info.height, bytes: data.length, hash };
      await fs.writeFile(/*turbopackIgnore: true*/ jobPath(job.id, "images", image.file), data);
      if (edit) {
        // Pairs find each other by name; pictures whose names say nothing pair in the order they came.
        const named = pairName(f.name);
        const side = named.side ?? as ?? "after";
        const same = (i: TrainImage) => pairName(i.name).key === named.key;
        // By order, only a picture whose own name names no pair: "dog.jpg" took the before picture "cat_before.jpg"
        // was waiting with, and "cat_after.jpg" then had none.
        const plain = (i: TrainImage) => pairName(i.name).side === null;
        if (side === "before") {
          const open = job.images.filter((i) => !i.waiting && !i.source);
          const mate = open.find(same) ?? (named.side ? undefined : open.find(plain));
          if (mate) mate.source = { file: image.file, name: image.name, width: image.width, height: image.height };
          else job.images.push({ ...image, waiting: true });
          added.push(image);
          continue;
        }
        const waiting = job.images.filter((i) => i.waiting);
        const mate = waiting.find(same) ?? (named.side ? undefined : waiting.find(plain));
        if (mate) {
          image.source = { file: mate.file, name: mate.name, width: mate.width, height: mate.height };
          job.images = job.images.filter((i) => i !== mate);
        }
        // (No look for doubles here: a pair's two pictures, and the pairs of one series, are meant to look alike.)
        if (Math.min(info.width, info.height) < TOO_SMALL) image.skip = `Too small to learn from (${info.width}×${info.height})`;
      } else {
        const twin = job.images.find((i) => !i.skip && !i.waiting && distance(i.hash, hash) <= 2);
        if (Math.min(info.width, info.height) < TOO_SMALL) image.skip = `Too small to learn from (${info.width}×${info.height})`;
        else if (twin) image.skip = `The same picture as ${twin.name}`;
      }
      job.images.push(image);
      added.push(image);
    } catch {
      refused.push({ name: f.name, why: "Crackio couldn't read it as a picture." });
    }
  }
  if (added.length) await touch(job, true);
  return { added, refused };
}

export async function removeImages(job: TrainJob, ids: string[]) {
  const gone = job.images.filter((i) => ids.includes(i.id));
  job.images = job.images.filter((i) => !ids.includes(i.id));
  // A double of one that's gone is no longer a double.
  for (const i of job.images) {
    if (!i.skip?.startsWith("The same picture")) continue;
    if (!job.images.some((o) => o !== i && !o.skip && distance(o.hash, i.hash) <= 2)) delete i.skip;
  }
  await Promise.all(
    gone.flatMap((i) => [
      fs.rm(/*turbopackIgnore: true*/ jobPath(job.id, "images", i.file), { force: true }),
      fs.rm(/*turbopackIgnore: true*/ jobPath(job.id, "thumbs", `${i.id}.webp`), { force: true }),
      ...(i.source ? [fs.rm(/*turbopackIgnore: true*/ jobPath(job.id, "images", i.source.file), { force: true })] : []),
    ]),
  );
  await touch(job, true);
  return gone.length;
}

/** Takes the before picture off some pairs (their after pictures stay, waiting for another). */
export async function removeBefore(job: TrainJob, ids: string[]) {
  const gone: string[] = [];
  for (const i of job.images) {
    if (!ids.includes(i.id) || !i.source) continue;
    gone.push(i.source.file);
    delete i.source;
  }
  await Promise.all(gone.map((file) => fs.rm(/*turbopackIgnore: true*/ jobPath(job.id, "images", file), { force: true })));
  await touch(job, true);
  return gone.length;
}

/**
 * A picture of the set, or a small copy of it (`width` px wide, kept in thumbs/). `before`: its pair's before picture.
 * Null when it isn't one of the job's.
 */
export async function imageFile(job: TrainJob, imageId: string, width?: number, before = false): Promise<{ file: string; mime: string } | null> {
  const image = job.images.find((i) => i.id === imageId);
  if (!image || (before && !image.source)) return null;
  const stored = before ? image.source!.file : image.file;
  const original = jobPath(job.id, "images", stored);
  if (!width) return { file: original, mime: "image/jpeg" };
  const w = width <= 200 ? 200 : width <= 480 ? 480 : 960;
  const thumb = jobPath(job.id, "thumbs", `${before ? stored.replace(/\.jpg$/, "") : image.id}-${w}.webp`);
  if (!(await fs.stat(/*turbopackIgnore: true*/ thumb).catch(() => null))) {
    await fs.mkdir(/*turbopackIgnore: true*/ path.dirname(thumb), { recursive: true });
    await sharp(original).resize({ width: w, height: w, fit: "inside", withoutEnlargement: true }).webp({ quality: 80 }).toFile(thumb);
  }
  return { file: thumb, mime: "image/webp" };
}

/**
 * The pictures a run trains on (the ones not left out), each with the words it goes in with. An edit LoRA's are its
 * pairs: `source` is the before picture's file.
 */
export function trainingSet(job: TrainJob) {
  return trainable(job.images, job.goal).map((i) => ({
    image: i,
    path: jobPath(job.id, "images", i.file),
    caption: captionFor(job, i),
    source: job.goal === "edit" && i.source ? jobPath(job.id, "images", i.source.file) : null,
  }));
}
