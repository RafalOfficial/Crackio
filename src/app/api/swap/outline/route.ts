import fs from "node:fs/promises";
import sharp from "sharp";
import { z } from "zod";
// The text models first: they reach the engine registry, which loads comfy-local whole (loaded first, comfy-local would
// reach the registry halfway through itself).
import { askText } from "@/lib/engines/refine";
import { downloadOutput, runWorkflow, uploadInput } from "@/lib/engines/comfy-local";
import { withTarget } from "@/lib/server/comfy-targets";
import { pickTarget } from "@/lib/server/local-models";
import { saveFileUpload, urlToPath } from "@/lib/server/media";

const Body = z.object({
  /** A frame of the clip, as saved by /api/recast/frame. */
  frame: z.string().min(1).max(500),
  /** Where it was clicked, 0–1 across and down (the first is the click; more points on the same thing help). */
  points: z.array(z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) })).min(1).max(5),
  /** Also say in words what was outlined ("the man in the pink shirt and black sunglasses"). */
  name: z.boolean().default(false),
  /** dim: the rest of the frame dimmed, an orange edge (one pick); tint: only this one, tinted in `color` with a solid edge, so several stack. */
  style: z.enum(["dim", "tint"]).default("dim"),
  color: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
});

const SAM = "sam3.1_multiplex_fp16.safetensors";
/** Crackio's orange, for the edge around what you picked. */
const TINT = { r: 255, g: 91, b: 46 };

const NAME = `Image 1 is a frame from a video; image 2 shows only one thing from it, cut out on black.
Say what that thing is in a short phrase that picks it out in the frame, starting with "the": who or what it is and what makes it stand out (clothes, colour, place), e.g. "the man in the pink shirt and black sunglasses", "the white car on the left", "the brown dog on the sofa". Answer with the phrase only.`;

/**
 * What you clicked in a frame, outlined by SAM 3.1 on the GPU that runs swaps: an overlay picture (clear over it, an
 * orange edge around it, the rest dimmed) laid over the frame, and its box (0–1000). With `name`, a vision model says
 * what it is.
 */
export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid request" }, { status: 400 });
  const { frame, points, name, style } = parsed.data;
  const hex = parsed.data.color ?? "#ff5b2e";
  const tint = { r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16) };
  const file = urlToPath(frame);
  if (!file) return Response.json({ error: "That frame isn't on this computer." }, { status: 400 });
  const picture = await fs.readFile(file).catch(() => null);
  const meta = picture ? await sharp(picture).metadata().catch(() => null) : null;
  if (!picture || !meta?.width || !meta.height) return Response.json({ error: "Couldn't read the frame." }, { status: 422 });
  const [W, H] = [meta.width, meta.height];
  // Long enough to wait for a render that's already running on the GPU.
  const signal = AbortSignal.timeout(420_000);
  try {
    const target = await pickTarget("ltx-2.5-ripple");
    const mask = await withTarget(target, async () => {
      const up = await uploadInput(await sharp(picture).rotate().png().toBuffer(), `outline-${Date.now().toString(36)}.png`, signal);
      const coords = JSON.stringify(points.map((p) => ({ x: Math.round(p.x * (W - 1)), y: Math.round(p.y * (H - 1)) })));
      const graph = {
        "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: SAM } },
        "2": { class_type: "LoadImage", inputs: { image: up.name } },
        "3": { class_type: "PrimitiveString", inputs: { value: coords } },
        "4": { class_type: "SAM3_Detect", inputs: { model: ["1", 0], image: ["2", 0], threshold: 0.4, refine_iterations: 2, individual_masks: false, positive_coords: ["3", 0] } },
        "5": { class_type: "MaskToImage", inputs: { mask: ["4", 0] } },
        "6": { class_type: "SaveImage", inputs: { images: ["5", 0], filename_prefix: "crackio/outline" } },
      };
      const { files } = await runWorkflow(graph, { signal, progress: () => undefined }, 8_000, "SAM 3.1 outline", true);
      const png = files.find((f) => /\.png$/i.test(f.filename));
      if (!png) throw new Error("SAM 3.1 didn't outline anything.");
      return (await downloadOutput(png, signal)).data;
    });
    // The outline at the frame's size, one byte a pixel; its box; the overlay: tint inside, a solid edge around.
    const gray = await sharp(mask).resize(W, H, { fit: "fill" }).extractChannel(0).raw().toBuffer();
    let [x0, y0, x1, y1, area] = [W, H, -1, -1, 0];
    for (let i = 0; i < gray.length; i++) {
      if (gray[i] < 128) continue;
      area++;
      const [x, y] = [i % W, Math.floor(i / W)];
      [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
    }
    if (!area) return Response.json({ error: "Nothing was found where you clicked. Click right on them." }, { status: 422 });
    // (A one-band raw buffer can come back from sharp as three bands: one channel taken out again.)
    const grown = await sharp(gray, { raw: { width: W, height: H, channels: 1 } }).blur(Math.max(1, W / 400)).extractChannel(0).raw().toBuffer();
    const rgba = Buffer.alloc(W * H * 4);
    for (let i = 0; i < W * H; i++) {
      const inside = gray[i] >= 128;
      const edge = !inside && grown[i] >= 24;
      if (style === "tint") {
        // Only what you picked: a light tint of its colour over it, and a solid edge around it.
        if (inside) rgba.set([tint.r, tint.g, tint.b, 56], i * 4);
        else if (edge) rgba.set([tint.r, tint.g, tint.b, 255], i * 4);
        continue;
      }
      if (inside) continue;
      // Everything else dimmed, and a solid edge around what you picked.
      const [r, g, b, a] = edge ? [TINT.r, TINT.g, TINT.b, 255] : [10, 8, 14, 125];
      rgba.set([r, g, b, a], i * 4);
    }
    const overlay = await saveFileUpload(await sharp(rgba, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer(), "png", "file");
    const box = [Math.round((x0 / W) * 1000), Math.round((y0 / H) * 1000), Math.round(((x1 + 1) / W) * 1000), Math.round(((y1 + 1) / H) * 1000)];
    let label: string | null = null;
    if (name) {
      // Only what was outlined, on black (built pixel by pixel: sharp would reorder a chain of these steps).
      const rgb = await sharp(picture).rotate().resize(W, H, { fit: "fill" }).removeAlpha().raw().toBuffer();
      const only = Buffer.alloc(W * H * 3);
      for (let i = 0; i < W * H; i++) if (gray[i] >= 128) rgb.copy(only, i * 3, i * 3, i * 3 + 3);
      const cut = await sharp(only, { raw: { width: W, height: H, channels: 3 } })
        .extract({ left: x0, top: y0, width: x1 + 1 - x0, height: y1 + 1 - y0 })
        .png()
        .toBuffer();
      const cutFile = `${file}.cut.png`;
      await fs.writeFile(cutFile, cut);
      try {
        const answer = await askText({
          instructions: NAME,
          text: "What is the cut-out thing?",
          references: [
            { path: file, label: "the frame" },
            { path: cutFile, label: "the thing, cut out" },
          ],
          imageEdge: 768,
          signal,
          timeoutMs: 45_000,
        }).catch(() => null);
        label = answer?.trim().replace(/^["'\s]+|["'.\s]+$/g, "").slice(0, 160) || null;
      } finally {
        await fs.rm(cutFile, { force: true }).catch(() => {});
      }
    }
    return Response.json({ overlay: overlay.url, box, share: area / (W * H), ...(label ? { name: label } : {}) });
  } catch (err) {
    return Response.json({ error: (err as Error).message || "Couldn't outline it." }, { status: 502 });
  }
}
