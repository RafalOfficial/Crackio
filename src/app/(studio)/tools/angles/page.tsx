import type { Metadata } from "next";
import { toolBySlug } from "@/lib/tools";
import { AnglesTool } from "@/components/tools/AnglesTool";

const tool = toolBySlug("angles")!;
export const metadata: Metadata = { title: tool.name, description: tool.summary };

export default function Page() {
  return <AnglesTool />;
}
