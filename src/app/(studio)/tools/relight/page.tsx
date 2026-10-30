import type { Metadata } from "next";
import { toolBySlug } from "@/lib/tools";
import { RelightTool } from "@/components/tools/RelightTool";

const tool = toolBySlug("relight")!;
export const metadata: Metadata = { title: tool.name, description: tool.summary };

export default function Page() {
  return <RelightTool />;
}
