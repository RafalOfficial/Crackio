import type { Metadata } from "next";
import { MotionAgent } from "@/components/motion/MotionAgent";

export const metadata: Metadata = { title: "Motion", description: "Talk to an agent that designs motion graphics, ads and edits, rendered on your computer." };

export default function Page() {
  return <MotionAgent />;
}
