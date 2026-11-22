import type { Metadata } from "next";
import { LorasView } from "@/components/settings/LorasView";

export const metadata: Metadata = { title: "LoRAs" };

export default function LorasPage() {
  return <LorasView />;
}
