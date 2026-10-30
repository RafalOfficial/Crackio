import type { Metadata } from "next";
import { toolBySlug } from "@/lib/tools";
import { RetouchTool } from "@/components/tools/RetouchTool";

const tool = toolBySlug("retouch")!;
export const metadata: Metadata = { title: tool.name, description: tool.summary };

export default function Page() {
  return <RetouchTool />;
}
