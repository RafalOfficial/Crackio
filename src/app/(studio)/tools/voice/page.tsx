import type { Metadata } from "next";
import { toolBySlug } from "@/lib/tools";
import { VoiceStudio } from "@/components/voice/VoiceStudio";

const tool = toolBySlug("voice")!;
export const metadata: Metadata = { title: tool.name, description: tool.summary };

export default function Page() {
  return <VoiceStudio />;
}
