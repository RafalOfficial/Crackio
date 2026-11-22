import type { KitId } from "@/lib/setup/types";

/**
 * Add-ons: small extras that make a tool better, each one click to get (Settings → Tools → Add-ons). Each is a
 * requirement of a tool that the tool can do without (lib/setup/kits), so a tool's own set-up shows the same thing
 * from its side; here it is got by itself, without the rest of what that tool needs.
 *
 * Client-safe: Settings reads this list, the server judges the requirement on each machine.
 */
export type AddonId = "enhance" | "judge" | "eyes" | "chat";

export type Addon = {
  id: AddonId;
  name: string;
  /** One short line, plain words: what it does for you. */
  summary: string;
  /** The tool it helps, and that tool's requirement it fills. */
  kit: KitId;
  req: string;
  /** Where it's used: the words after "For", and the page. */
  usedIn: { label: string; href: string };
  /** Its colour (the tool's own), and the picture behind its preview. */
  hue: string;
  media: string;
};

export const ADDONS: Addon[] = [
  {
    id: "enhance",
    name: "Prompt enhancer",
    summary: "Turns a few words into a full prompt, on your own GPU.",
    kit: "image",
    req: "image.enhance",
    usedIn: { label: "Image and Video", href: "/create" },
    hue: "var(--color-spike)",
    media: "/assets/addon-prompt.webp",
  },
  {
    id: "judge",
    name: "Swap judge",
    summary: "Checks every swapped frame and redraws the ones that miss.",
    kit: "recast",
    req: "swap.judge",
    usedIn: { label: "Swap", href: "/tools/recast" },
    hue: "var(--color-tool-recast)",
    media: "/assets/tool-recast.webp",
  },
  {
    id: "eyes",
    name: "Retouch eyes",
    summary: "Finds each thing in a picture, so you can click it and change it.",
    kit: "retouch",
    req: "retouch.eyes",
    usedIn: { label: "Retouch", href: "/tools/retouch" },
    hue: "var(--color-tool-retouch)",
    media: "/assets/tool-retouch.webp",
  },
  {
    id: "chat",
    name: "Talk's chat voice",
    summary: "Makes Talk answer like a person: short and warm.",
    kit: "voice",
    req: "voice.chat",
    usedIn: { label: "Voice", href: "/tools/voice" },
    hue: "var(--color-tool-voice)",
    media: "/assets/tool-voice.webp",
  },
];
