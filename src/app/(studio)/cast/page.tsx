import type { Metadata } from "next";
import { toolBySlug } from "@/lib/tools";
import { CastStudio } from "@/components/cast/CastStudio";

const tool = toolBySlug("cast")!;
export const metadata: Metadata = { title: tool.name, description: tool.summary };

export default function CastPage() {
  return <CastStudio />;
}
