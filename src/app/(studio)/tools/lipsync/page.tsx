import type { Metadata } from "next";
import { toolBySlug } from "@/lib/tools";
import { LipsyncStudio } from "@/components/lipsync/LipsyncStudio";

const tool = toolBySlug("lipsync")!;
export const metadata: Metadata = { title: tool.name, description: tool.summary };

export default function Page() {
  return <LipsyncStudio />;
}
