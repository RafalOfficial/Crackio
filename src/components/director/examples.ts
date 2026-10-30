import type { ElementKind } from "@/lib/director/types";

/** Ready-made locations and cast to try Director without your own photos. */
export const EXAMPLE_PLACES = [
  { label: "Rainy street", url: "/assets/stage-street.webp", width: 1400, height: 788, text: "an empty narrow side street at night after rain, glowing shop windows and paper lanterns" },
  { label: "Photo studio", url: "/assets/stage-studio.webp", width: 1400, height: 788, text: "a clean photo studio with a light grey seamless backdrop and softboxes" },
  { label: "Neon gas station", url: "/assets/gallery-08.webp", width: 1200, height: 800, text: "a retro roadside gas station at dusk, pink and teal neon, wet asphalt, the sea behind" },
  { label: "Cliff house", url: "/assets/gallery-05.webp", width: 1200, height: 800, text: "a modern glass house on a rocky cliff above a stormy sea" },
];

export const EXAMPLE_CAST: { name: string; kind: ElementKind; url: string; height: number; look: string }[] = [
  { name: "Mila", kind: "person", url: "/assets/stage-woman.webp", height: 1.7, look: "long rust-red wool coat, white sneakers" },
  { name: "Biscuit", kind: "animal", url: "/assets/stage-dog.webp", height: 0.66, look: "a golden retriever" },
  { name: "Lounge chair", kind: "object", url: "/assets/stage-chair.webp", height: 0.82, look: "mid-century tan leather lounge chair" },
];
