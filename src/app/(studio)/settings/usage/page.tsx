import type { Metadata } from "next";
import { UsageView } from "@/components/settings/UsageView";

export const metadata: Metadata = { title: "Usage · Settings" };

export default function UsagePage() {
  return <UsageView />;
}
