import data from "../../scripts/assets/examples.json";
import { aspectById, sizeFor, type AspectId } from "./shot";

export const EXAMPLE_CATEGORIES = ["People", "Places", "Nature", "Product", "Food", "Cinematic", "Art"] as const;
export type ExampleCategory = (typeof EXAMPLE_CATEGORIES)[number];

export type Example = {
  id: string;
  title: string;
  category: ExampleCategory;
  src: string;
  prompt: string;
  aspect: AspectId;
  width: number;
  height: number;
};

/** "Prompts that worked": every image was made from exactly the prompt shown with it. */
export const EXAMPLES: Example[] = data.examples.map((e) => {
  const aspect = aspectById(e.aspect).id;
  return { ...e, category: e.category as ExampleCategory, aspect, src: `/assets/${e.id}.webp`, ...sizeFor(aspect) };
});
