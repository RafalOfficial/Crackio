import type { Metadata } from "next";
import { Suspense } from "react";
import { OverviewView } from "@/components/settings/OverviewView";

export const metadata: Metadata = { title: "Settings" };

export default function SettingsPage() {
  return (
    <Suspense>
      <OverviewView />
    </Suspense>
  );
}
