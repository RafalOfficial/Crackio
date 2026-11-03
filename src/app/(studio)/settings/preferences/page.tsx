import type { Metadata } from "next";
import { Suspense } from "react";
import { PreferencesView } from "@/components/settings/PreferencesView";

export const metadata: Metadata = { title: "Preferences · Settings" };

export default function PreferencesPage() {
  return (
    <Suspense>
      <PreferencesView />
    </Suspense>
  );
}
