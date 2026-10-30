import type { Metadata } from "next";
import { ModelsView } from "@/components/settings/ModelsView";

export const metadata: Metadata = { title: "Models" };

export default function ModelsPage() {
  return <ModelsView />;
}
