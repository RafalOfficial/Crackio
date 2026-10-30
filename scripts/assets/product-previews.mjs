#!/usr/bin/env node
// Makes Product Studio's previews through a running Crackio and the plans you've connected:
// three sample products (a sports drink, longevity capsules, a t-shirt), then every option shot
// with each of them through the real Product Studio pipeline (read → direct → shoot), so a preview
// shows exactly what the option does, and how it fits itself to different products.
//
// Usage: node scripts/assets/product-previews.mjs [samples] [<axis>[:<id>] ...] [--force] [--out=<dir>]
//   node scripts/assets/product-previews.mjs samples          the three sample products
//   node scripts/assets/product-previews.mjs scene:beach      one option, all three samples
//   node scripts/assets/product-previews.mjs scene:beach:tee  one option, one sample
//   node scripts/assets/product-previews.mjs camera --context=person   one context of an axis
//   node scripts/assets/product-previews.mjs thumbs           square thumbnails of the samples
//   node scripts/assets/product-previews.mjs moment camera    whole axes
//   node scripts/assets/product-previews.mjs all              everything still missing
// Writes public/assets/product/<axis>-<id>-<sample>.webp (640 px) and -t.webp (thumbnails), and the
// ideas the director wrote to src/lib/product/previews.json. Needs Crackio on http://127.0.0.1:3210.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const BASE = process.env.CRACKIO_URL ?? "http://127.0.0.1:3210";
const MODEL = process.env.IMAGE_MODEL ?? "codex:gpt-image-2";
const PARALLEL = Number(process.env.PARALLEL ?? 3);
const args = process.argv.slice(2);
const force = args.includes("--force");
const outArg = args.find((a) => a.startsWith("--out="));
const outDir = outArg ? path.resolve(outArg.slice(6)) : path.join(root, "public", "assets", "product");
const manifestFile = outArg ? path.join(outDir, "previews.json") : path.join(root, "src", "lib", "product", "previews.json");
const wanted = args.filter((a) => !a.startsWith("--"));

const LOOK = "The whole product is in frame with generous space around it. Seamless light grey background, soft even studio light, a soft contact shadow. A sharp, true-to-life e-commerce packshot. No other objects and no other text.";
const SAMPLES = [
  {
    id: "drink",
    aspect: "2:3",
    prompt: `A clean studio product photograph of one 500 ml sports drink bottle standing upright, front view, centered, the whole bottle from the top of its cap to its base in frame, with empty grey space above and below it: a slim translucent ice-blue PET bottle with a white sport cap with a pull-up spout; a matte white wraparound label printed with the bold navy wordmark "KOVA", beneath it "HYDRATE" in small spaced capitals beside a small orange citrus-slice icon, and along the bottom "ELECTROLYTE WATER · CITRUS · 500 ML" in tiny capitals. ${LOOK}`,
  },
  {
    id: "capsules",
    prompt: `A clean studio product photograph of one supplement jar standing upright, front view, centered: a squat amber glass bottle with a matte black screw cap and a cream uncoated paper label printed with the elegant serif wordmark "EVERA", beneath it "LONGEVITY" in small spaced capitals and "NAD+ Complex" in a light italic, and "60 CAPSULES" along the bottom. Two beige capsules lie on the surface in front of the jar. ${LOOK.replace("No other objects and no other text.", "No other text.")}`,
  },
  {
    id: "tee",
    prompt: `A clean studio product photograph of one sage-green heavyweight cotton crew-neck t-shirt on an invisible ghost mannequin, front view, centered: short sleeves, a ribbed collar, natural fabric folds, and a small white embroidered wordmark "OASE" on the left chest. ${LOOK}`,
  },
  // The range beyond the first three: one product for each big kind of thing people sell.
  {
    id: "cookies",
    extra: true,
    prompt: `A clean studio product photograph of one stand-up kraft-paper pouch of cookies, front view, centered: a clear window shows chunky chocolate chip cookies inside; a matte cream label printed with the hand-drawn wordmark "MILLO", beneath it "BROWN BUTTER CHOCOLATE CHIP" in small capitals and "8 COOKIES · 240 g" at the bottom. Two cookies rest on the surface in front of the pouch. ${LOOK.replace("No other objects and no other text.", "No other text.")}`,
  },
  {
    id: "serum",
    extra: true,
    prompt: `A clean studio product photograph of one 30 ml skincare serum standing upright, front view, centered: a frosted glass dropper bottle with a white rubber bulb and a thin gold collar, filled with a pale amber serum; a clean white label printed "LUMEN" in thin modern capitals and "VITAMIN C SERUM · 30 ml" beneath it. ${LOOK}`,
  },
  {
    id: "perfume",
    extra: true,
    prompt: `A clean studio product photograph of one perfume bottle standing upright, front view, centered: a thick rectangular faceted clear glass bottle with pale champagne liquid and a heavy brushed-gold square cap; a small black label on the front printed "NOIRÉ" in elegant capitals and "EAU DE PARFUM · 50 ML" beneath it. ${LOOK}`,
  },
  {
    id: "sneakers",
    extra: true,
    aspect: "3:2",
    prompt: `A clean studio product photograph of one pair of low-top sneakers side by side, the right one turned slightly toward the camera: off-white smooth leather uppers with sand-colored suede toe and heel overlays, white laces, natural gum rubber soles, and a small embossed wordmark "STRIDE" on each heel tab. ${LOOK}`,
  },
  {
    id: "headphones",
    extra: true,
    prompt: `A clean studio product photograph of one pair of over-ear wireless headphones standing upright, front three-quarter view, centered: matte sand-beige ear cups and headband, brushed aluminum sliders, soft cushions, and a small debossed wordmark "AURAL" on the outer ear cup. ${LOOK}`,
  },
  {
    id: "candle",
    extra: true,
    prompt: `A clean studio product photograph of one scented candle, front view, centered: cream wax in a matte terracotta ceramic vessel, a round wooden lid leaning against it, and a cream paper label printed "HEARTH" in a warm serif and "CEDAR & FIG · 220 g" beneath it. ${LOOK.replace("No other objects and no other text.", "No other text.")}`,
  },
  {
    id: "watch",
    extra: true,
    prompt: `A clean studio product photograph of one minimalist wristwatch standing upright on an invisible stand, front view, centered: a 38 mm brushed steel case, a white dial with thin black hour markers and slim black hands, a tan leather strap closed in a loop, and "TEMPO" printed small in capitals on the dial. ${LOOK}`,
  },
  {
    id: "bag",
    extra: true,
    prompt: `A clean studio product photograph of one structured tote bag standing upright, front view, centered: smooth tan leather, two slim handles, a top zip, and a small gold-foil debossed wordmark "MARLO" on the front. ${LOOK}`,
  },
  {
    id: "treats",
    extra: true,
    prompt: `A clean studio product photograph of one stand-up pouch of dog treats, front view, centered: matte forest-green pouch with a resealable top, printed with the playful rounded wordmark "BARKLEY", "CHICKEN & SWEET POTATO DOG TREATS" beneath it and "200 g" at the bottom. A few small bone-shaped treats lie on the surface in front of it. ${LOOK.replace("No other objects and no other text.", "No other text.")}`,
  },
];
const CLASSIC = SAMPLES.filter((s) => !s.extra).map((s) => s.id);
const EXTRA = SAMPLES.filter((s) => s.extra).map((s) => s.id);

// Which picks each preview changes, and what the others are held at so options compare fairly.
// Previews show women, products and objects only (Crackio's showcase rule).
const BASE_SPEC = { moment: "auto", scene: "auto", camera: "auto", light: "auto", finish: "auto", who: "woman", copySpace: false };
// Moment previews hold each product in a place it belongs, so the moments compare fairly.
const HOME = { drink: "beach", capsules: "kitchen", tee: "street", cookies: "cafe", serum: "bathroom", perfume: "luxe", sneakers: "street", headphones: "desk", candle: "living", watch: "cafe", bag: "street", treats: "park" };
// Each axis is previewed in the kinds of shot it's seen in, so Product Studio can show the one that
// matches the shot you picked: the product on its own ("alone"), or someone using it ("person").
// The first context of each axis is the original set, named <axis>-<id>-<sample>; the others add their
// name: <axis>-<id>-<context>-<sample>. Keep these in step with CONTEXTS in src/lib/product/previews.ts.
const AXES = {
  moment: { ids: ["auto", "still", "hand", "use", "together", "creator", "ingredients", "motion"], contexts: { "": (id, s) => ({ moment: id, scene: HOME[s] }) } },
  scene: {
    ids: ["auto", "white", "color", "podium", "luxe", "kitchen", "bathroom", "living", "desk", "cafe", "gym", "street", "night", "beach", "pool", "park", "forest", "mountains", "snow", "desert"],
    contexts: { "": (id) => ({ scene: id }), alone: (id) => ({ scene: id, moment: "still" }), person: (id) => ({ scene: id, moment: "use" }) },
  },
  camera: {
    ids: ["auto", "eye", "three", "low", "high", "top", "close", "wide"],
    contexts: { "": (id) => ({ camera: id, moment: "still", scene: "color", light: "soft" }), person: (id, s) => ({ camera: id, moment: "use", scene: HOME[s] }) },
  },
  light: {
    ids: ["auto", "soft", "window", "golden", "sun", "overcast", "moody", "neon"],
    contexts: { "": (id) => ({ light: id, moment: "still", camera: "three" }), person: (id) => ({ light: id, moment: "use" }) },
  },
  finish: {
    ids: ["auto", "commercial", "editorial", "natural", "phone", "film", "cinematic", "minimal"],
    contexts: { "": (id) => ({ finish: id, moment: "use" }), alone: (id) => ({ finish: id, moment: "still" }) },
  },
};
const contextArg = args.find((a) => a.startsWith("--context="))?.slice(10);

await fs.mkdir(path.join(outDir, "samples"), { recursive: true });
const made = [];
let manifest = {};
try {
  manifest = JSON.parse(await fs.readFile(manifestFile, "utf8"));
} catch {
  /* first run */
}

async function api(route, init) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${BASE}${route}`, { ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
      const data = await res.json();
      if (!res.ok) throw new Error(`${route} ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
      return data;
    } catch (err) {
      // The dev server recompiles now and then; give it a moment.
      if (attempt >= 4 || /^\/api\/generations 4/.test(String(err.message))) throw err;
      await new Promise((r) => setTimeout(r, 2500));
    }
  }
}

async function generate(body, label) {
  const { item } = await api("/api/generations", { method: "POST", body: JSON.stringify(body) });
  made.push(item.id);
  const started = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 3000));
    const { items } = await api(`/api/generations?ids=${item.id}`);
    const g = items[0];
    if (g.status === "done") {
      const c = g.params?.shots?.[0]?.check;
      const verdict = c ? ` · ${c.pass ? "checked" : "FLAGGED"}${c.retried ? " (re-shot)" : ""}${c.issues?.length ? `: ${c.issues.join(" ")}` : ""}` : "";
      console.log(`done ${label} in ${Math.round((Date.now() - started) / 1000)}s${g.params?.shots?.[0]?.idea ? ` · ${g.params.shots[0].idea}` : ""}${verdict}`);
      return g;
    }
    if (g.status === "error") throw new Error(`${label}: ${g.error} ${g.stage ?? ""}`);
  }
}

const exists = (f) => fs.stat(f).then(() => true, () => false);
const fileOf = (url) => path.join(root, "data", "media", path.basename(url.split("?")[0]));

async function sample(s) {
  const dest = path.join(outDir, "samples", `${s.id}.webp`);
  if (!force && (await exists(dest))) return;
  const g = await generate(
    { tool: "showcase", prompt: "", compiledPrompt: s.prompt, aspect: s.aspect ?? "1:1", count: 1, model: MODEL, refine: false, references: [], params: { kind: "image", options: { longEdge: 1024 } } },
    `sample ${s.id}`,
  );
  await sharp(fileOf(g.outputs[0].url)).resize({ width: 1024, height: 1024, fit: "inside" }).webp({ quality: 90 }).toFile(dest);
}

async function preview(axis, id, s, ctx = "") {
  const name = ctx ? `${axis}-${id}-${ctx}-${s}` : `${axis}-${id}-${s}`;
  const dest = path.join(outDir, `${name}.webp`);
  if (!force && (await exists(dest))) return;
  // Previews go through the same quality check as your takes (CHECK=0 skips it).
  const spec = { version: 2, ...BASE_SPEC, ...AXES[axis].contexts[ctx](id, s), noted: false, productImages: 1, check: process.env.CHECK !== "0" };
  const g = await generate(
    {
      tool: "showcase",
      prompt: `${axis} ${id} · ${s}`,
      aspect: "4:5",
      count: 1,
      model: MODEL,
      refine: false,
      references: [{ url: `/assets/product/samples/${s}.webp`, label: "the product", role: "product" }],
      params: { kind: "image", studio: spec, options: { longEdge: 1024 } },
    },
    name,
  );
  const file = fileOf(g.outputs[0].url);
  await sharp(file).resize({ width: 640 }).webp({ quality: 82 }).toFile(dest);
  await sharp(file).resize({ width: 220 }).webp({ quality: 78 }).toFile(path.join(outDir, `${name}-t.webp`));
  const key = ctx ? `${axis}-${id}-${ctx}` : `${axis}-${id}`;
  manifest[key] = { ...manifest[key], [s]: g.params?.shots?.[0]?.idea ?? "" };
  await saveManifest();
  // Keep the full prompt beside the original for review (not shipped).
  await fs.mkdir(path.join(root, "assets-src", "product-previews"), { recursive: true });
  await fs.copyFile(file, path.join(root, "assets-src", "product-previews", `${name}${path.extname(file)}`));
  await fs.writeFile(path.join(root, "assets-src", "product-previews", `${name}.txt`), `${g.params?.shots?.[0]?.idea ?? ""}\n\n${g.compiledPrompt ?? ""}\n${g.params?.shots?.[0]?.check ? `\ncheck: ${JSON.stringify(g.params.shots[0].check)}\n` : ""}`);
}

// Takes finish together: one write at a time, so the file is never half-written.
let saving = Promise.resolve();
function saveManifest() {
  saving = saving.then(() => fs.writeFile(manifestFile, `${JSON.stringify(sortKeys(manifest), null, 2)}\n`));
  return saving;
}

/**
 * A square, centered thumbnail of a sample: the product lifted off its photo with Crackio's own cutout
 * model, on one even backdrop with a soft contact shadow, so every sample sits the same way in a grid
 * whatever the shape and backdrop of its photo.
 */
async function thumb(s) {
  const dest = path.join(outDir, "samples", `${s.id}-t.webp`);
  if (!force && (await exists(dest))) return;
  const { url } = await api("/api/vision", { method: "POST", body: JSON.stringify({ task: "cutout", url: `/assets/product/samples/${s.id}.webp` }) });
  const cut = path.join(root, "data", "uploads", path.basename(url));
  const S = 384;
  const inner = await sharp(cut).resize({ width: Math.round(S * 0.76), height: Math.round(S * 0.76), fit: "inside" }).png().toBuffer({ resolveWithObject: true });
  const left = Math.round((S - inner.info.width) / 2);
  const top = Math.round((S - inner.info.height) / 2);
  const shadowH = Math.round(S * 0.045);
  const shadow = `<svg width="${S}" height="${S}" xmlns="http://www.w3.org/2000/svg"><defs><filter id="b" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${shadowH * 0.7}"/></filter></defs><ellipse cx="${S / 2}" cy="${top + inner.info.height - shadowH * 0.25}" rx="${inner.info.width * 0.46}" ry="${shadowH / 2}" fill="rgba(0,0,0,0.2)" filter="url(#b)"/></svg>`;
  await sharp({ create: { width: S, height: S, channels: 3, background: "#e6e6e8" } })
    .composite([{ input: Buffer.from(shadow) }, { input: inner.data, left, top }])
    .webp({ quality: 88 })
    .toFile(dest);
  console.log(`thumb ${s.id}`);
}

function sortKeys(o) {
  return Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
}

async function pool(tasks, limit) {
  const failed = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, tasks.length) }, async () => {
      while (next < tasks.length) {
        const t = tasks[next++];
        try {
          await t.run();
        } catch (err) {
          failed.push(`${t.label}: ${err.message ?? err}`);
          console.log(`FAILED ${t.label}: ${err.message ?? err}`);
        }
      }
    }),
  );
  return failed;
}

/** The products an option is previewed with: the first three, plus three of the others in turn. */
function samplesFor(axis, id) {
  const k = Object.entries(AXES).flatMap(([a, d]) => d.ids.map((i) => `${a}:${i}`)).indexOf(`${axis}:${id}`);
  return [...CLASSIC, ...[0, 1, 2].map((j) => EXTRA[(3 * k + j) % EXTRA.length])];
}

const tasks = [];
const all = wanted.includes("all");
if (all || wanted.includes("samples")) for (const s of SAMPLES) tasks.push({ label: `sample ${s.id}`, run: () => sample(s).then(() => thumb(s)) });
if (wanted.includes("thumbs")) for (const s of SAMPLES) tasks.push({ label: `thumb ${s.id}`, run: () => thumb(s) });
const sampleTasks = tasks.length;
for (const [axis, def] of Object.entries(AXES)) {
  for (const id of def.ids) {
    const asked = all || wanted.includes(axis) || wanted.includes(`${axis}:${id}`);
    // <axis>:<id>:<sample> picks one sample.
    const only = wanted.filter((w) => w.startsWith(`${axis}:${id}:`)).map((w) => w.split(":")[2]);
    if (!asked && !only.length) continue;
    for (const ctx of Object.keys(def.contexts)) {
      // --context=<name> limits a run to one context ("base" for the original set).
      if (contextArg && contextArg !== (ctx || "base")) continue;
      for (const s of SAMPLES.filter((x) => (asked && samplesFor(axis, id).includes(x.id)) || only.includes(x.id)))
        tasks.push({ label: ctx ? `${axis}-${id}-${ctx}-${s.id}` : `${axis}-${id}-${s.id}`, run: () => preview(axis, id, s.id, ctx) });
    }
  }
}
let failed = [];
try {
  // Samples first: every preview starts from them.
  failed = failed.concat(await pool(tasks.slice(0, sampleTasks), PARALLEL));
  failed = failed.concat(await pool(tasks.slice(sampleTasks), PARALLEL));
} finally {
  for (const id of made) await fetch(`${BASE}/api/generations/${id}`, { method: "DELETE" }).catch(() => {});
}
console.log(failed.length ? `finished with ${failed.length} failures:\n${failed.join("\n")}` : "all finished");
