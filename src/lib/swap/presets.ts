/**
 * Clips to try Swap on, all made by Crackio itself on open models (scripts/assets/templates.mjs: a still from a local
 * picture model, animated by LTX-2.5 on your GPU), so nobody's likeness or work is in them. Each suggests what to click.
 */
export type SwapPreset = {
  id: string;
  title: string;
  /** One line: what's in it and what to swap. */
  line: string;
  clip: string;
  poster: string;
  seconds: number;
  /** What to click in it, in words. */
  try: string[];
  /** A swap Crackio made on it (LTX-2.5 + Ripple), played on hover, and what was swapped. */
  example?: { clip: string; caption: string };
};

const A = "/assets/templates";
const preset = (id: string, title: string, line: string, seconds: number, tries: string[], swapped?: string): SwapPreset => ({
  id,
  title,
  line,
  clip: `${A}/${id}.mp4`,
  poster: `${A}/${id}.webp`,
  seconds,
  try: tries,
  ...(swapped ? { example: { clip: `${A}/${id}-swap.mp4`, caption: swapped } } : {}),
});

export const SWAP_PRESETS: SwapPreset[] = [
  preset("studio-dance", "Studio Dance", "A dancer in a bright studio: put anyone from your Cast in her place.", 8, ["the dancer"], "Juno, on a Tokyo street at night"),
  preset("city-walk", "City Walk", "A walk toward the camera on a sunny street: swap her, or just her coat's colour.", 8, ["the woman", "her coat"], "a royal-blue coat"),
  preset("cafe-duo", "Café Duo", "Two friends at a café: swap one, both, or the cups for your product.", 6, ["the woman on the left", "the woman on the right", "a cup"], "Juno & Noor"),
  preset("coastal-drive", "Coastal Drive", "A red convertible on a coast road: your car, or any colour.", 7, ["the car"], "Minty, a hatchback"),
  preset("moon-moonwalk", "Moonwalk on the Moon", "One small step, one flawless moonwalk: put anyone on the Moon, totally deadpan.", 8, ["the astronaut"]),
  preset("office-chair-race", "Office Chair Grand Prix", "The meeting can wait: put anyone in the office-chair grand prix.", 8, ["the woman on the chair"]),
  preset("trolley-surf", "Trolley Surf", "An empty supermarket at midnight, one trolley, perfect waves: put anyone on board.", 8, ["the woman surfing the trolley"]),
  preset("product-spin", "Product Spin", "A sneaker turning on a pedestal: drop in your own product.", 8, ["the sneaker"], "a leather tote"),
];
