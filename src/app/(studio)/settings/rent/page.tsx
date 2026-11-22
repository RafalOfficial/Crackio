import type { Metadata } from "next";
import { Suspense } from "react";
import { RentView } from "@/components/settings/RentView";

export const metadata: Metadata = { title: "Rent · Settings" };

export default function RentPage() {
  return (
    <Suspense>
      <RentView />
    </Suspense>
  );
}
