#!/usr/bin/env node
// Makes Product Studio's Video previews through a running Crackio and the plans you've connected.
//
// 1. stills: the pictures the previews start from, shot through Product Studio's own image pipeline
//    (read → direct → shoot → check) with the sample products, as a person would make them in Image
//    mode: creators holding the product for talking ads, the product on its own for hero shots and
//    living photos, someone using it for lifestyle clips.
// 2. clips: every Video option filmed from those stills through the real film pipeline, so a preview
//    shows exactly what the option does.
//
// Usage: node scripts/assets/film-previews.mjs stills [<still-id> ...] [--force]
//        node scripts/assets/film-previews.mjs clips [<axis>[:<id>[:<still>]] ...] [--force]
// Writes public/assets/product/film/<name>.webp|mp4, ideas to src/lib/product/film-previews.json,
// and keeps originals plus prompts in assets-src/product-film. Needs Crackio on http://127.0.0.1:3210.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const BASE = process.env.CRACKIO_URL ?? "http://127.0.0.1:3210";
const IMAGE_MODEL = process.env.IMAGE_MODEL ?? "codex:gpt-image-2";
const PARALLEL = Number(process.env.PARALLEL ?? 3);
const args = process.argv.slice(2);
const force = args.includes("--force");
const [command, ...wanted] = args.filter((a) => !a.startsWith("--"));
const outDir = path.join(root, "public", "assets", "product", "film");
const srcDir = path.join(root, "assets-src", "product-film");
const manifestFile = path.join(root, "src", "lib", "product", "film-previews.json");

/**
 * The stills. Women, products, objects and animals only (Crackio's showcase rule); wardrobe any brand
 * would run. `notes` go to Product Studio's director as the client's own words.
 */
const STILLS = [
  // Creators holding the product, phone selfie: the start of a talking ad.
  {
    id: "ugc-capsules",
    product: "capsules",
    aspect: "9:16",
    spec: { moment: "creator", scene: "kitchen", finish: "phone" },
    notes:
      "A vertical phone selfie a creator takes to start a video: she holds her own phone at arm's length (her outstretched arm runs off the edge of the frame toward the lens; the phone itself is never visible), the jar in her other hand at chest height, label toward the lens. Morning in her own kitchen, a mug of coffee on the counter behind her. Relaxed, mouth closed, a small natural smile, looking into the lens. Her face fills the upper half of the frame.",
  },
  {
    id: "ugc-tee",
    product: "tee",
    aspect: "9:16",
    spec: { moment: "creator", scene: "street", finish: "phone" },
    notes:
      "A vertical phone selfie on a sunny city sidewalk: she wears the t-shirt (worn, the wordmark visible on her chest) with light jeans, holding her own phone at arm's length (her outstretched arm runs off the edge of the frame; the phone itself is never visible); her free hand is relaxed at her side. Mid-step, looking into the lens with an easy smile, mouth closed. Her head and the whole front of the shirt are in frame.",
  },
  {
    id: "ugc-serum",
    product: "serum",
    aspect: "9:16",
    spec: { moment: "creator", scene: "bathroom", finish: "phone" },
    notes:
      "A vertical phone selfie in her bathroom in soft daylight after cleansing, hair up in a claw clip, fresh bare skin: she holds her own phone at arm's length (her outstretched arm runs off the edge of the frame; the phone itself is never visible) and the serum bottle in her other hand near her cheek, label toward the lens. Calm, mouth closed, looking into the lens.",
  },
  {
    id: "ugc-drink",
    product: "drink",
    aspect: "9:16",
    spec: { moment: "creator", scene: "gym", finish: "phone" },
    notes:
      "A vertical phone selfie right after a workout, sitting on a gym bench in a fitted zip-up training top, a little flushed, a towel over one shoulder: she holds her own phone at arm's length (her outstretched arm runs off the edge of the frame; the phone itself is never visible) and the sealed bottle in her other hand at chest height, label toward the lens. Catching her breath, a tired happy smile, mouth closed.",
  },
  {
    id: "ugc-cookies",
    product: "cookies",
    aspect: "9:16",
    spec: { moment: "creator", scene: "living", finish: "phone" },
    notes:
      "A vertical phone selfie on her sofa in the evening, in a cozy knit sweater, warm lamp light: she holds her own phone at arm's length (her outstretched arm runs off the edge of the frame; the phone itself is never visible) and the open cookie pouch in her other hand, label toward the lens. A playful guilty smile, mouth closed.",
  },
  {
    id: "ugc-headphones",
    product: "headphones",
    aspect: "9:16",
    spec: { moment: "creator", scene: "desk", finish: "phone" },
    notes:
      "A vertical phone selfie at her desk by a window, the headphones resting around her neck (worn, not held): she holds her own phone at arm's length (her outstretched arm runs off the edge of the frame; the phone itself is never visible), her free hand touching one ear cup. Late afternoon daylight, a laptop and a mug behind her. Easy smile, mouth closed, looking into the lens.",
  },
  {
    id: "ugc-treats",
    product: "treats",
    aspect: "9:16",
    spec: { moment: "creator", scene: "park", finish: "phone" },
    notes:
      "A vertical phone selfie in a sunny park: she crouches beside her golden retriever, who sits looking up at the treat pouch in her free hand; she holds her own phone at arm's length (her outstretched arm runs off the edge of the frame; the phone itself is never visible). Both her face and the dog's head are in frame; the pouch label faces the lens. Laughing softly, mouth closed.",
  },
  // The other ways a creator films: each camera option starts from a picture taken that way.
  {
    id: "ugc-mirror",
    product: "tee",
    aspect: "9:16",
    spec: { moment: "creator", scene: "living", finish: "phone" },
    notes:
      "A vertical mirror selfie: she stands in front of a full-length mirror in her bright apartment hallway, wearing the t-shirt tucked into light jeans, filming her reflection on her phone held at chest height in one hand (the back of the phone faces the mirror, it covers only her chin, her face fully visible above it); her other hand rests on her hip. We see her reflection in the mirror, the wordmark readable on her chest, mid-afternoon daylight, a plant and a coat rack beside the mirror.",
  },
  {
    id: "ugc-car",
    product: "drink",
    aspect: "9:16",
    spec: { moment: "creator", scene: "street", finish: "phone" },
    notes:
      "A vertical phone selfie in the driver's seat of her parked car: daylight through the windshield and the side window, seat belt off, sunglasses pushed up on her head, holding her own phone at arm's length (her outstretched arm runs off the edge of the frame; the phone itself is never visible) and the sealed bottle in her other hand, label toward the lens. The car's grey interior and headrest behind her. A relaxed half-smile, mouth closed.",
  },
  {
    id: "ugc-propped",
    product: "serum",
    aspect: "9:16",
    spec: { moment: "creator", scene: "bathroom", finish: "phone" },
    notes:
      "A vertical frame from a phone propped up on her bathroom vanity facing her, nobody holding it: she sits on a stool at the vanity in a soft robe, hair in a towel turban, both hands free, holding the serum bottle at chest height in one hand, the label toward the lens, smiling at the phone. Medium shot from the counter's height, her head and shoulders and the counter edge in frame, soft daylight.",
  },
  {
    id: "ugc-friend",
    product: "cookies",
    aspect: "9:16",
    spec: { moment: "creator", scene: "cafe", finish: "phone" },
    notes:
      "A vertical phone video still filmed by her friend across a small café table (the friend is behind the camera, never visible): she sits facing the camera in a denim jacket, both hands free, holding up the open cookie pouch with one hand and a broken cookie in the other, mid-laugh, looking at the friend just past the lens. A flat white and a plate on the table, the café softly out of focus.",
  },
  // The product on its own: hero shots and living photos.
  {
    id: "banner-cookies",
    product: "cookies",
    aspect: "16:9",
    spec: { moment: "still", scene: "kitchen", light: "window", finish: "commercial" },
    notes:
      "A wide website banner: a tray of the cookies just out of the oven on a wooden board, still warm (a faint wisp of steam rising from them), the pouch standing beside the tray, label toward us. Morning window light, a warm kitchen softly out of focus. Lots of calm space on the left.",
  },
  {
    id: "banner-candle",
    product: "candle",
    aspect: "16:9",
    spec: { moment: "still", scene: "living", light: "moody", finish: "editorial" },
    notes:
      "A wide banner on a cozy autumn evening: the candle is burning, a small bright flame standing on its wick above a shallow pool of melted wax, its warm glow on the rim and the label. It stands on a walnut side table beside a stack of books and a knitted throw, the lid leaning against it. Dim warm lamp light, the room falling into soft shadow. Calm space on the right.",
  },
  {
    id: "hero-perfume",
    product: "perfume",
    aspect: "9:16",
    spec: { moment: "still", scene: "luxe", light: "moody", finish: "commercial" },
    notes: "A vertical hero shot: the bottle alone on black marble, one narrow beam of warm light catching the glass and the gold cap, deep shadow around it, a faint reflection on the stone.",
  },
  {
    id: "hero-drink",
    product: "drink",
    aspect: "9:16",
    spec: { moment: "still", scene: "beach", light: "sun", finish: "commercial" },
    notes:
      "A vertical shot: the sealed bottle standing on a weathered wooden beach-bar counter, beaded with cold condensation, ice cubes melting beside it, the sea glittering softly out of focus behind. Bright midday sun, crisp shadows.",
  },
  {
    id: "hero-sneakers",
    product: "sneakers",
    aspect: "9:16",
    spec: { moment: "still", scene: "color", light: "soft", finish: "commercial" },
    notes: "A vertical hero shot: the pair standing on a seamless sand-colored set, the right shoe turned slightly toward us, soft even light and a soft floor shadow, plenty of space above.",
  },
  {
    id: "hero-headphones",
    product: "headphones",
    aspect: "16:9",
    spec: { moment: "still", scene: "desk", light: "window", finish: "commercial" },
    notes: "A wide banner: the headphones standing on a tidy oak desk beside a laptop and a ceramic mug, soft side light from a window, calm space on the left.",
  },
  {
    id: "hero-watch",
    product: "watch",
    aspect: "9:16",
    spec: { moment: "still", scene: "cafe", light: "window", finish: "editorial" },
    notes: "A vertical shot: the watch lying on a marble café table beside a small espresso cup, morning window light raking across the dial, the street softly out of focus.",
  },
  // Hands at work: unboxing and demo clips.
  {
    id: "demo-serum",
    product: "serum",
    aspect: "9:16",
    spec: { moment: "hand", scene: "bathroom", light: "window", finish: "natural" },
    notes: "A vertical close shot: her hand holds the serum bottle over a stone vanity, the dropper lifted a little out of the bottle with a drop of serum at its tip; soft daylight, a folded towel and a plant behind. Hands only, no face.",
  },
  {
    id: "demo-cookies",
    product: "cookies",
    aspect: "9:16",
    spec: { moment: "hand", scene: "cafe", light: "window", finish: "natural" },
    notes: "A vertical top-down close shot: two hands on a café table, one holding the sealed cookie pouch, the other pinching the top edge of the pouch, about to tear it open; a flat white beside it. Hands only, no face.",
  },
  // Someone using it, no talking: lifestyle clips.
  {
    id: "life-tee",
    product: "tee",
    aspect: "9:16",
    spec: { moment: "use", scene: "street", light: "golden", finish: "natural" },
    notes: "A vertical shot of her walking toward the camera on a city sidewalk in golden afternoon light, wearing the t-shirt with light jeans, the wordmark visible, a tote over one shoulder, looking past the camera.",
  },
  {
    id: "life-drink",
    product: "drink",
    aspect: "9:16",
    spec: { moment: "use", scene: "park", light: "golden", finish: "natural" },
    notes: "A vertical shot: she stands on a park path after a run in a fitted training top, the cap of the bottle open, the bottle just lowered from her lips, catching her breath, looking off to the side, golden late light.",
  },
];

await fs.mkdir(path.join(outDir, "stills"), { recursive: true });
await fs.mkdir(path.join(srcDir, "stills"), { recursive: true });
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
      console.log(`done ${label} in ${Math.round((Date.now() - started) / 1000)}s`);
      return g;
    }
    if (g.status === "error") throw new Error(`${label}: ${g.error} ${g.stage ?? ""}`);
  }
}

const exists = (f) => fs.stat(f).then(
  () => true,
  () => false,
);
const fileOf = (url) => path.join(root, "data", "media", path.basename(url.split("?")[0]));

let saving = Promise.resolve();
function saveManifest() {
  saving = saving.then(() => fs.writeFile(manifestFile, `${JSON.stringify(Object.fromEntries(Object.keys(manifest).sort().map((k) => [k, manifest[k]])), null, 2)}\n`));
  return saving;
}

async function still(s) {
  const dest = path.join(outDir, "stills", `${s.id}.webp`);
  if (!force && (await exists(dest))) return;
  const spec = { version: 2, moment: "auto", scene: "auto", camera: "auto", light: "auto", finish: "auto", who: "woman", copySpace: false, ...s.spec, noted: true, productImages: 1, check: true };
  const g = await generate(
    {
      tool: "showcase",
      prompt: s.notes,
      aspect: s.aspect,
      count: 1,
      model: IMAGE_MODEL,
      refine: false,
      references: [{ url: `/assets/product/samples/${s.product}.webp`, label: "the product", role: "product" }],
      params: { kind: "image", studio: spec, options: { longEdge: 1920 } },
    },
    `still ${s.id}`,
  );
  const file = fileOf(g.outputs[0].url);
  const shot = g.params?.shots?.[0];
  // Full HD for the clips to start from; a light copy for tiles.
  await sharp(file).resize({ width: 1920, height: 1920, fit: "inside" }).webp({ quality: 88 }).toFile(dest);
  await sharp(file).resize({ width: 360, height: 360, fit: "inside" }).webp({ quality: 78 }).toFile(path.join(outDir, "stills", `${s.id}-t.webp`));
  await fs.copyFile(file, path.join(srcDir, "stills", `${s.id}${path.extname(file)}`));
  await fs.writeFile(path.join(srcDir, "stills", `${s.id}.txt`), `${shot?.idea ?? ""}\n\n${g.compiledPrompt ?? ""}\n${shot?.check ? `\ncheck: ${JSON.stringify(shot.check)}\n` : ""}`);
  manifest[`still-${s.id}`] = { product: s.product, aspect: s.aspect, idea: shot?.idea ?? "" };
  await saveManifest();
}

/* ------------------------------------------------------------------ clips */

const VIDEO_MODEL = process.env.VIDEO_MODEL ?? "grok:grok-imagine-video-1.5";
// What every preview of a style starts from; each option changes only its own pick, so options compare fairly.
const STYLE_BASE = {
  creator: { style: "creator", camera: "auto", hook: "none", mood: "warm", pace: "natural", story: "one", words: "auto", seconds: 10 },
  lifestyle: { style: "lifestyle", camera: "auto", hook: "none", mood: "warm", pace: "natural", story: "one", words: "none", seconds: 8 },
  living: { style: "living", camera: "still", hook: "none", mood: "calm", pace: "calm", story: "auto", words: "none", seconds: 6 },
  hero: { style: "hero", camera: "push", hook: "none", mood: "calm", pace: "calm", story: "sweep", words: "none", seconds: 8 },
  demo: { style: "demo", camera: "side", hook: "none", mood: "calm", pace: "natural", story: "unbox", words: "none", seconds: 8 },
  campaign: { style: "campaign", camera: "push", hook: "none", mood: "warm", pace: "punchy", story: "cuts", words: "none", seconds: 12 },
};
// Several pictures of one brand, for Campaign previews.
const SETS = { kova: ["ugc-drink", "hero-drink", "life-drink"], millo: ["demo-cookies", "ugc-cookies", "ugc-friend"], oase: ["life-tee", "ugc-mirror", "ugc-tee"] };
/** Every option's previews: the style it's filmed in, and the pictures (or sets) it's filmed from. */
const CLIPS = {
  style: {
    creator: ["creator", ["ugc-capsules", "ugc-tee", "ugc-serum"]],
    lifestyle: ["lifestyle", ["life-tee", "life-drink"]],
    living: ["living", ["banner-cookies", "banner-candle", "hero-drink"]],
    hero: ["hero", ["hero-perfume", "hero-sneakers", "hero-headphones"]],
    demo: ["demo", ["demo-serum", "demo-cookies"]],
    campaign: ["campaign", ["kova", "millo"]],
  },
  camera: {
    auto: ["creator", ["ugc-friend", "ugc-headphones"]],
    selfie: ["creator", ["ugc-capsules", "ugc-headphones"]],
    walk: ["creator", ["ugc-tee"]],
    propped: ["creator", ["ugc-propped"]],
    friend: ["creator", ["ugc-friend"]],
    mirror: ["creator", ["ugc-mirror"]],
    car: ["creator", ["ugc-car"]],
    handheld: ["lifestyle", ["life-tee"]],
    tripod: ["lifestyle", ["life-drink"]],
    pov: ["demo", ["demo-cookies"]],
    push: ["hero", ["hero-perfume"]],
    orbit: ["hero", ["hero-sneakers"]],
    macro: ["hero", ["hero-watch"]],
    rise: ["hero", ["hero-headphones"]],
    locked: ["hero", ["hero-drink"]],
    still: ["living", ["banner-cookies"]],
    drift: ["living", ["banner-candle"]],
    top: ["demo", ["demo-cookies"]],
    side: ["demo", ["demo-serum"]],
  },
  hook: {
    none: ["creator", ["ugc-headphones"]],
    zoom: ["creator", ["ugc-tee"]],
    lens: ["creator", ["ugc-serum"]],
    toss: ["creator", ["ugc-drink"]],
    wait: ["creator", ["ugc-cookies"]],
    fumble: ["creator", ["ugc-capsules"]],
    sound: ["demo", ["demo-cookies"]],
    question: ["creator", ["ugc-serum"]],
    callout: ["creator", ["ugc-drink"]],
    contrarian: ["creator", ["ugc-cookies"]],
    reveal: ["creator", ["ugc-treats"]],
    drop: ["hero", ["hero-perfume"]],
    lights: ["hero", ["hero-headphones"]],
  },
  mood: Object.fromEntries(["excited", "warm", "calm", "honest", "amazed", "whisper", "secret", "skeptic", "relieved", "deadpan"].map((id) => [id, ["creator", ["ugc-capsules", "ugc-headphones"]]])),
  pace: Object.fromEntries(["calm", "natural", "punchy"].map((id) => [id, ["hero", ["hero-watch", "hero-sneakers"]]])),
  story: {
    one: ["creator", ["ugc-headphones"]],
    punch: ["creator", ["ugc-tee"]],
    show: ["creator", ["ugc-serum"]],
    use: ["creator", ["ugc-drink"]],
    before: ["creator", ["ugc-capsules"]],
    handoff: ["creator", ["ugc-cookies"]],
    joins: ["creator", ["ugc-treats"]],
    auto: ["living", ["hero-drink"]],
    steam: ["living", ["banner-cookies"]],
    light: ["living", ["hero-watch"]],
    breeze: ["living", ["life-tee"]],
    drops: ["living", ["hero-drink"]],
    glow: ["living", ["banner-candle"]],
    sweep: ["hero", ["hero-perfume"]],
    splash: ["hero", ["hero-drink"]],
    unveil: ["hero", ["hero-headphones"]],
    turn: ["hero", ["hero-sneakers"]],
    elements: ["hero", ["banner-cookies"]],
    unbox: ["demo", ["demo-cookies"]],
    pour: ["demo", ["demo-serum"]],
    apply: ["demo", ["demo-serum"]],
    detail: ["demo", ["hero-headphones"]],
    cuts: ["campaign", ["kova"]],
    flow: ["campaign", ["millo"]],
    story: ["campaign", ["oase"]],
  },
};

const PRODUCT_OF = Object.fromEntries(STILLS.map((s) => [s.id, s.product]));
const ASPECT_OF = Object.fromEntries(STILLS.map((s) => [s.id, s.aspect]));
const FFMPEG = (await import("node:module")).createRequire(path.join(root, "package.json"))("ffmpeg-static");
const { execFile } = await import("node:child_process");
const ffmpeg = (args) => new Promise((resolve, reject) => execFile(FFMPEG, ["-y", "-hide_banner", "-loglevel", "error", ...args], { maxBuffer: 1 << 26 }, (err) => (err ? reject(err) : resolve())));

async function clip(axis, id, styleId, still) {
  const name = `${axis}-${id}-${still}`;
  const dest = path.join(outDir, `${name}.mp4`);
  if (!force && (await exists(dest))) return;
  const base = STYLE_BASE[styleId];
  // SHORT=1: a lighter preview: 6 s clips, two pictures per campaign (RES sets the resolution, e.g. 720p).
  const short = process.env.SHORT === "1";
  const stills = (SETS[still] ?? [still]).slice(0, short ? 2 : 3);
  const pictures = stills.map((s) => ({ url: `/assets/product/film/stills/${s}.webp` }));
  const product = PRODUCT_OF[stills[0]];
  const { seconds, ...picks } = base;
  const spec = {
    version: 1,
    ...picks,
    ...(axis === "style" ? {} : { [axis]: id }),
    language: "en-US",
    seconds: short ? 6 : SETS[still] ? 12 : seconds,
    ...(process.env.RES ? { resolution: process.env.RES } : {}),
    ...(styleId === "living" ? { loop: false } : {}),
    // Someone from Cast joining is the user's own person; previews use a friend Crackio casts.
    noted: false,
    check: process.env.CHECK !== "0",
    pictures,
    productUrl: `/assets/product/samples/${product}.webp`,
  };
  const g = await generate(
    {
      tool: "showcase",
      prompt: name,
      aspect: ASPECT_OF[stills[0]] ?? "9:16",
      count: 1,
      model: VIDEO_MODEL,
      refine: false,
      references: pictures.map((p, i) => ({ url: p.url, label: i === 0 ? "the start frame" : `picture ${i + 1}`, role: "subject" })),
      params: { kind: "video", startUrl: pictures[0].url, film: spec, options: {} },
    },
    name,
  );
  const file = fileOf(g.outputs[0].url);
  const clips = g.params?.clips ?? [];
  const checks = clips.map((c) => c.check).filter(Boolean);
  // A light copy for previews (432 px on the short side is sharp in a hover card on a retina screen), and its first frame.
  const wide = (ASPECT_OF[stills[0]] ?? "9:16") === "16:9";
  await ffmpeg(["-i", file, "-vf", wide ? "scale=768:-2" : "scale=432:-2", "-c:v", "libx264", "-preset", "slow", "-crf", "27", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "64k", "-ac", "1", "-movflags", "+faststart", dest]);
  const posterPng = path.join(srcDir, `${name}-poster.png`);
  await ffmpeg(["-ss", "0.25", "-i", file, "-frames:v", "1", posterPng]);
  await sharp(posterPng).resize({ width: wide ? 640 : 360 }).webp({ quality: 78 }).toFile(path.join(outDir, `${name}.webp`));
  await fs.rm(posterPng, { force: true });
  // The original, kept smaller for review (not shipped).
  await ffmpeg(["-i", file, "-c:v", "libx264", "-preset", "medium", "-crf", "22", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", path.join(srcDir, `${name}.mp4`)]);
  await fs.writeFile(
    path.join(srcDir, `${name}.txt`),
    `${g.params?.idea ?? ""}\n\n${clips.map((c) => `SCRIPT: ${c.script ?? ""}\nCHECK: ${JSON.stringify(c.check ?? null)}\n\n${c.prompt}`).join("\n\n---\n\n")}\n`,
  );
  const key = `${axis}-${id}`;
  manifest[key] = { ...(manifest[key] ?? {}), [still]: { idea: g.params?.idea ?? "", seconds: spec.seconds } };
  await saveManifest();
  console.log(`  ${name}: ${g.params?.idea ?? ""}${checks.length ? ` · ${checks.every((c) => c.pass) ? "checked" : `FLAGGED: ${checks.flatMap((c) => c.issues).join(" ")}`}${checks.some((c) => c.retried) ? " (re-filmed)" : ""}` : ""}`);
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

const tasks = [];
if (command === "stills") {
  for (const s of STILLS.filter((x) => !wanted.length || wanted.includes(x.id))) tasks.push({ label: `still ${s.id}`, run: () => still(s) });
} else if (command === "voices") {
  // A short sample of every preset voice, so you can hear one before you pick it (xAI's speech, on your Grok sign-in).
  const VOICE_IDS = ["ara", "eve", "aurora", "carina", "celeste", "iris", "liora", "luna", "ursa", "leo", "rex", "sal", "atlas", "orion", "cosmo", "kepler", "lux"];
  const os = await import("node:os");
  const auth = JSON.parse(await fs.readFile(path.join(os.homedir(), ".grok", "auth.json"), "utf8"));
  const token = Object.values(auth).find((e) => e && e.key)?.key;
  await fs.mkdir(path.join(outDir, "voices"), { recursive: true });
  for (const id of VOICE_IDS.filter((v) => !wanted.length || wanted.includes(v))) {
    tasks.push({
      label: `voice ${id}`,
      run: async () => {
        const dest = path.join(outDir, "voices", `${id}.mp3`);
        if (!force && (await exists(dest))) return;
        const res = await fetch("https://api.x.ai/v1/tts", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ text: "Okay, so I've been using this every single morning… and honestly? I'm not going back.", voice_id: id, language: "en", output_format: { codec: "mp3", sample_rate: 24000, bit_rate: 64000 } }),
        });
        if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
        await fs.writeFile(dest, Buffer.from(await res.arrayBuffer()));
        console.log(`voice ${id}`);
      },
    });
  }
} else if (command === "clips") {
  // <axis>, <axis>:<id> or <axis>:<id>:<still>; nothing means every clip still missing.
  for (const [axis, options] of Object.entries(CLIPS)) {
    for (const [id, [styleId, stills]] of Object.entries(options)) {
      const asked = !wanted.length || wanted.includes(axis) || wanted.includes(`${axis}:${id}`);
      const only = wanted.filter((w) => w.startsWith(`${axis}:${id}:`)).map((w) => w.split(":")[2]);
      for (const still of stills) if (asked || only.includes(still)) tasks.push({ label: `${axis}-${id}-${still}`, run: () => clip(axis, id, styleId, still) });
    }
  }
} else {
  console.log("Usage: node scripts/assets/film-previews.mjs stills|clips [<id> | <axis>[:<id>[:<still>]] ...] [--force]");
  process.exit(1);
}

let failed = [];
try {
  failed = await pool(tasks, PARALLEL);
} finally {
  for (const id of made) await fetch(`${BASE}/api/generations/${id}`, { method: "DELETE" }).catch(() => {});
}
console.log(failed.length ? `finished with ${failed.length} failures:\n${failed.join("\n")}` : "all finished");
