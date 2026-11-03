import type { Metadata } from "next";
import { Suspense } from "react";
import { MachinesView } from "@/components/settings/MachinesView";

export const metadata: Metadata = { title: "Machines · Settings" };

export default function MachinesPage() {
  return (
    <Suspense>
      <MachinesView />
    </Suspense>
  );
}
