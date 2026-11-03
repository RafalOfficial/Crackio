import type { Metadata } from "next";
import { Suspense } from "react";
import { StorageView } from "@/components/settings/StorageView";

export const metadata: Metadata = { title: "Storage · Settings" };

export default function StoragePage() {
  return (
    <Suspense>
      <StorageView />
    </Suspense>
  );
}
