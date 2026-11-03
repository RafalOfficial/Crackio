import type { Metadata } from "next";
import { Suspense } from "react";
import { ToolsView } from "@/components/settings/ToolsView";

export const metadata: Metadata = { title: "Tools · Settings" };

export default function ToolsPage() {
  return (
    <Suspense>
      <ToolsView />
    </Suspense>
  );
}
