import type { Metadata } from "next";
import { Suspense } from "react";
import { AgentsView } from "@/components/settings/AgentsView";

export const metadata: Metadata = { title: "Agents · Settings" };

export default function AgentsPage() {
  return (
    <Suspense>
      <AgentsView />
    </Suspense>
  );
}
