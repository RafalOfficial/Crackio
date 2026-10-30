import type { Metadata } from "next";
import { toolBySlug } from "@/lib/tools";
import { SwapStudio } from "@/components/swap/SwapStudio";

const tool = toolBySlug("recast")!;
export const metadata: Metadata = { title: tool.name, description: tool.summary };

export default function Page() {
  return <SwapStudio />;
}
