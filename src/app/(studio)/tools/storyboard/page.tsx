import type { Metadata } from "next";
import { StoryboardClient } from "@/components/storyboard/StoryboardClient";

export const metadata: Metadata = {
  title: "Storyboard",
  description: "Direct your shots, cut them together on a timeline, make pictures move, and export the film.",
};

export default function Page() {
  return <StoryboardClient />;
}
