import type { LucideIcon } from "lucide-react";
import {
  Clapperboard,
  Expand,
  GalleryHorizontalEnd,
  Package,
  Replace,
  Rotate3d,
  Brush,
  Sun,
  Users,
  Video,
} from "lucide-react";

export type ToolSlug =
  | "director"
  | "angles"
  | "relight"
  | "cast"
  | "retouch"
  | "product"
  | "motion"
  | "recast"
  | "upscale"
  | "storyboard";

export type Tool = {
  slug: ToolSlug;
  name: string;
  /** One line, plain words: what the tool does for you. */
  summary: string;
  /** Longer explanation for tool pages and hover cards. */
  description: string;
  /** CSS custom property holding this tool's hue. */
  hue: string;
  /** Line icon, kept as a fallback; the app shows `glyph`. */
  icon: LucideIcon;
  /** White glyph image for the tool's app icon: public/icons/<slug>.png (scripts/assets/icons.mjs). */
  glyph: string;
  media: string;
  output: "image" | "video" | "character";
  badge?: "Core" | "New" | "Video" | "Beta";
  href: string;
};

export const TOOLS: Tool[] = ([
  {
    slug: "director",
    name: "Director",
    summary: "Stage people, products and places, aim the camera, and generate.",
    description:
      "Drop your reference photos onto a 3D set, move them where they belong, pick the lens and the light. Crackio turns the scene into a precise prompt and a layout guide, so the first result already looks like what you pictured.",
    hue: "var(--color-tool-director)",
    icon: Clapperboard,
    media: "/assets/tool-director.webp",
    output: "image",
    badge: "Core",
    href: "/director",
  },
  {
    slug: "angles",
    name: "Angles",
    summary: "Re-shoot any image from a new camera angle.",
    description:
      "Orbit a virtual camera around your image — higher, lower, closer, around the side — and get the same scene photographed from there.",
    hue: "var(--color-tool-angles)",
    icon: Rotate3d,
    media: "/assets/tool-angles.webp",
    output: "image",
    badge: "New",
    href: "/tools/angles",
  },
  {
    slug: "relight",
    name: "Relight",
    summary: "Move the light around your subject until it looks right.",
    description:
      "Drag a light across a sphere to set its direction, then dial softness, color temperature and strength. Your subject stays the same; only the light changes.",
    hue: "var(--color-tool-relight)",
    icon: Sun,
    media: "/assets/tool-relight.webp",
    output: "image",
    href: "/tools/relight",
  },
  {
    slug: "cast",
    name: "Cast",
    summary: "Characters that look like themselves in every shot.",
    description:
      "Upload one to three photos of a person, pet or mascot. Crackio builds a reference sheet you can call into any tool with @name.",
    hue: "var(--color-tool-cast)",
    icon: Users,
    media: "/assets/tool-cast.webp",
    output: "character",
    href: "/cast",
  },
  {
    slug: "retouch",
    name: "Retouch",
    summary: "Point at what should change and say how.",
    description:
      "Crackio finds every thing in your picture, and its parts. Click one, say how it should change (add a picture of how, if you like), and everything you didn't mark keeps its exact pixels.",
    hue: "var(--color-tool-retouch)",
    icon: Brush,
    media: "/assets/tool-retouch.webp",
    output: "image",
    href: "/tools/retouch",
  },
  {
    slug: "product",
    name: "Product Studio",
    summary: "Ads for any product, in any scene, shot the way it's really used.",
    description:
      "Upload a photo of anything you sell: food, drinks, beauty, fashion, tech, home, pets. Crackio works out what it is and how people use it, then fits every scene, shot, angle and light to it. The label, shape and colors stay true.",
    hue: "var(--color-tool-product)",
    icon: Package,
    media: "/assets/tool-product.webp",
    output: "image",
    href: "/tools/product",
  },
  {
    slug: "motion",
    name: "Motion",
    summary: "An agent that makes any video you describe: it generates, designs, edits and renders.",
    description:
      "Describe an ad, a trailer, a lyric video or an edit, and attach photos, clips, music or scripts. Motion works like a studio with real tools: it generates images and clips on your own GPU or your Comfy key, designs motion graphics in code, cuts and mixes with ffmpeg, checks its own work and renders on this computer. It keeps working if you close the tab.",
    hue: "var(--color-tool-motion)",
    icon: Video,
    media: "/assets/feature-motion.webp",
    output: "video",
    badge: "New",
    href: "/tools/motion",
  },
  {
    slug: "recast",
    name: "Swap",
    summary: "Click anything in a clip and swap it: someone from your Cast, a product, a car, a colour.",
    description:
      "Drop any clip and click what should change. SAM 3.1 outlines it through the whole clip, and LTX-2.5 swaps it for someone from your Cast, a picture, a colour or anything you describe, while the motion, camera and sound stay exactly as they were. Runs on your own GPU.",
    hue: "var(--color-tool-recast)",
    icon: Replace,
    media: "/assets/tool-recast.webp",
    output: "video",
    badge: "Beta",
    href: "/tools/recast",
  },
  {
    slug: "upscale",
    name: "Upscale",
    summary: "Make any image or clip bigger and sharper, or reframe a picture to a new shape.",
    description:
      "Upscale pictures 2× or 4× and clips to 1080p, 2K or 4K with real texture, or reframe a picture to a new aspect ratio by extending the scene around it. Pick the upscaler you like.",
    hue: "var(--color-tool-upscale)",
    icon: Expand,
    media: "/assets/tool-upscale.webp",
    output: "image",
    href: "/tools/upscale",
  },
  {
    slug: "storyboard",
    name: "Storyboard",
    summary: "Plan a film shot by shot: stage scenes in Director, then cut the takes on a timeline and export one video.",
    description:
      "Each film is a project folder. Stage the place, cast and camera in Director and every shot lands in it; then cut them together on a timeline, make any picture move with a camera preset, and export one MP4.",
    hue: "var(--color-tool-storyboard)",
    icon: GalleryHorizontalEnd,
    media: "/assets/tool-storyboard.webp",
    output: "image",
    badge: "New",
    href: "/tools/storyboard",
  },
] satisfies Omit<Tool, "glyph">[]).map((t) => ({ ...t, glyph: `/icons/${t.slug}.png` }));

export const toolBySlug = (slug: string) => TOOLS.find((t) => t.slug === slug);
