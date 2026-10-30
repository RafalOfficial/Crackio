import type { Metadata } from "next";
import { toolBySlug } from "@/lib/tools";
import { UpscaleTool } from "@/components/tools/UpscaleTool";

const tool = toolBySlug("upscale")!;
export const metadata: Metadata = { title: tool.name, description: tool.summary };

export default function Page() {
  return <UpscaleTool />;
}
