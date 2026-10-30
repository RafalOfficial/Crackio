import "server-only";
import fs from "node:fs/promises";
import sharp from "sharp";
import type { EngineOutput } from "@/lib/engines/types";

/** x0, y0, x1, y1 in 0–1000 of the picture. */
type Box = [number, number, number, number];

/** How different (0–255, on average) the result may be outside the changes and still line up with the original. */
const DRIFT = 14;

/**
 * Retouch's "only the marked areas": the result's pixels inside the changed areas (softened at the
 * edges), the original's everywhere else, so nothing outside a change moves. Skipped for a result
 * whose shape differs from the original's, or that redrew the rest of the picture (moved, shifted
 * colors): pasting areas of that onto the original would show seams.
 */
export async function keepOutside(sourcePath: string, outputs: EngineOutput[], boxes: Box[]): Promise<EngineOutput[]> {
  if (!boxes.length) return outputs;
  const original = await fs.readFile(sourcePath);
  const src = await sharp(original, { failOn: "none" }).rotate().toBuffer({ resolveWithObject: true });
  const ratio = src.info.width / src.info.height;

  return Promise.all(
    outputs.map(async (out) => {
      if (!out.mime.startsWith("image/")) return out;
      try {
        const meta = await sharp(out.data).metadata();
        const W = meta.width ?? 0;
        const H = meta.height ?? 0;
        if (!W || !H || Math.abs(Math.log(W / H / ratio)) > 0.02) return out;

        // Work at the result's size: changed areas keep its detail, the rest is the original's.
        const base = await sharp(src.data).resize(W, H, { fit: "fill", kernel: "lanczos3" }).removeAlpha().toBuffer();
        const edited = await sharp(out.data).removeAlpha().toBuffer();
        const long = Math.max(W, H);
        const pad = long * 0.025;
        const rects = boxes
          .map(([x0, y0, x1, y1]) => {
            const x = Math.max(0, (x0 / 1000) * W - pad);
            const y = Math.max(0, (y0 / 1000) * H - pad);
            const w = Math.min(W, (x1 / 1000) * W + pad) - x;
            const h = Math.min(H, (y1 / 1000) * H + pad) - y;
            return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="${(pad * 1.5).toFixed(1)}" fill="#fff"/>`;
          })
          .join("");
        const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="#000"/>${rects}</svg>`);
        const mask = await sharp(svg).removeAlpha().blur(Math.max(1, long * 0.012)).greyscale().raw().toBuffer({ resolveWithObject: true });

        // Does the rest of the result still line up with the original? Compare small copies outside the changes.
        const small = 96;
        const sw = W >= H ? small : Math.round((small * W) / H);
        const sh = W >= H ? Math.round((small * H) / W) : small;
        const [a, b, m] = await Promise.all([
          sharp(base).resize(sw, sh, { fit: "fill" }).greyscale().raw().toBuffer(),
          sharp(edited).resize(sw, sh, { fit: "fill" }).greyscale().raw().toBuffer(),
          sharp(mask.data, { raw: { width: mask.info.width, height: mask.info.height, channels: mask.info.channels } }).resize(sw, sh, { fit: "fill" }).raw().toBuffer(),
        ]);
        let diff = 0;
        let n = 0;
        for (let i = 0; i < a.length; i++) {
          if (m[i * (m.length / a.length)] > 8) continue;
          diff += Math.abs(a[i] - b[i]);
          n++;
        }
        if (n > a.length * 0.15 && diff / n > DRIFT) return out;

        const alpha = mask.info.channels === 1 ? mask.data : await sharp(mask.data, { raw: mask.info }).extractChannel(0).raw().toBuffer();
        const patch = await sharp(edited).joinChannel(alpha, { raw: { width: W, height: H, channels: 1 } }).png().toBuffer();
        const data = await sharp(base).composite([{ input: patch }]).png().toBuffer();
        return { ...out, data, mime: "image/png" };
      } catch {
        return out;
      }
    }),
  );
}
