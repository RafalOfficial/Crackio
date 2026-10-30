/**
 * The hosted live demo: Crackio on one shared GPU, for people trying it without installing anything (judges, giveaway
 * codes). It's built and run with CRACKIO_DEMO=1 (docs/DEMO.md) and is off everywhere else, where nothing here applies.
 *
 * In the demo only the box's own ComfyUI models run, behind access codes that carry credits. Settings, machines,
 * installs, the ComfyUI relay, Motion's agent and URL downloads stay out of reach, and each code sees only its own work.
 * Pages learn the switch at build time (next.config.ts); the server also reads it at run time, so a build made without
 * it still locks down when it's started as a demo.
 */

/** In the browser: set when the demo was built. */
export const DEMO = process.env.NEXT_PUBLIC_CRACKIO_DEMO === "1";

/** On the server: the live switch. */
export const demoOn = () => process.env.CRACKIO_DEMO === "1" || process.env.NEXT_PUBLIC_CRACKIO_DEMO === "1";

/**
 * The full demo (CRACKIO_DEMO_FULL=1 with the demo on): one Crackio process and data folder per access code, so every store
 * is that code's own. It also offers Director, Cast, Product Studio and Storyboard, and Connections for the visitor's own
 * Comfy, RunPod and vast keys and serverless endpoints, whose jobs cost no credits. Motion, installs, the ComfyUI relay,
 * URL downloads and the lab stay out. Pages learn it at build time (NEXT_PUBLIC_CRACKIO_DEMO_FULL), the server at run time.
 */
export const DEMO_FULL = DEMO && process.env.NEXT_PUBLIC_CRACKIO_DEMO_FULL === "1";
export const demoFull = () => demoOn() && (process.env.CRACKIO_DEMO_FULL === "1" || process.env.NEXT_PUBLIC_CRACKIO_DEMO_FULL === "1");

/**
 * Words about "your GPU" as the demo should say them: there the open models run on the demo's own GPU, not on the
 * visitor's machine. "FLUX 3 Klein (your GPU)" → "FLUX 3 Klein", "free on your own GPU" → "on the demo's GPU" (demo
 * jobs spend the code's credits, so nothing there is "free"). Unchanged outside the demo. `on` is the server's live
 * switch where it's known (demoOn()).
 */
export function demoWords(text: string, on = DEMO): string {
  if (!on) return text;
  return text
    .replace(/\s*\(your GPU\)/g, "")
    .replace(/\bQwen on your GPU\b/g, "Qwen on the demo's GPU")
    .replace(/\b([Ff])ree on your own GPU\b/g, (_, f: string) => (f === "F" ? "On" : "on") + " the demo's GPU")
    .replace(/^Free: an /, "An ")
    .replace(/\byour own (GPU|card)\b/g, "the demo's GPU")
    .replace(/\byour own ComfyUI\b/g, "the demo's ComfyUI")
    .replace(/\byour GPU\b/g, "the demo's GPU")
    .replace(/\bYour GPU\b/g, "The demo's GPU");
}

/** Where the demo strip sends people to get Crackio. */
export const DEMO_REPO = process.env.NEXT_PUBLIC_CRACKIO_REPO || "https://github.com/RafalOfficial/Crackio";

/**
 * Tools a demo can offer: each runs entirely on the box's ComfyUI. Director, Cast, Product Studio and Storyboard keep their
 * own stores, which aren't split per code, so only the full demo (one process per code) offers them.
 */
export const DEMO_TOOL_IDS = ["image", "video", "templates", "recast", "upscale", "retouch", "relight", "angles"] as const;
export const DEMO_FULL_TOOL_IDS = ["director", "cast", "product", "storyboard"] as const;
export type DemoTool = (typeof DEMO_TOOL_IDS)[number] | (typeof DEMO_FULL_TOOL_IDS)[number];

/** The tools this demo offers: CRACKIO_DEMO_TOOLS (comma-separated) or all of them. */
export function demoTools(raw = process.env.CRACKIO_DEMO_TOOLS || process.env.NEXT_PUBLIC_CRACKIO_DEMO_TOOLS || ""): Set<DemoTool> {
  const asked = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const all: readonly DemoTool[] = demoFull() ? [...DEMO_TOOL_IDS, ...DEMO_FULL_TOOL_IDS] : DEMO_TOOL_IDS;
  const known = new Set<string>(all);
  return new Set((asked.length ? asked.filter((t) => known.has(t)) : all) as DemoTool[]);
}

/** Page addresses per tool (Home and Library are always there). */
export const DEMO_PAGES: Record<DemoTool, string[]> = {
  image: ["/create"],
  video: ["/video"],
  templates: ["/templates"],
  recast: ["/tools/recast"],
  upscale: ["/tools/upscale"],
  retouch: ["/tools/retouch"],
  relight: ["/tools/relight"],
  angles: ["/tools/angles"],
  director: ["/director"],
  cast: ["/cast"],
  product: ["/tools/product"],
  storyboard: ["/tools/storyboard"],
};

/** Whether a page address belongs to the demo (`/templates` also covers `/templates/<id>`). */
export function demoPage(pathname: string, tools = demoTools()): boolean {
  if (pathname === "/" || pathname === "/library" || pathname === "/demo") return true;
  // The full demo's Connections: the visitor's own keys and machines.
  if (pathname === "/settings/connections" && demoFull()) return true;
  for (const tool of tools) {
    for (const base of DEMO_PAGES[tool]) if (pathname === base || pathname.startsWith(`${base}/`)) return true;
  }
  return false;
}

/** The sidebar's "Tools" list, by slug (lib/tools), shows only these in a demo. */
export const demoToolSlug = (slug: string, tools = demoTools()) => (tools as Set<string>).has(slug);
