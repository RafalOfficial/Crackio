import { Suspense } from "react";
import type { Metadata } from "next";
import { LibraryFallback, LibraryView } from "@/components/library/LibraryView";

export const metadata: Metadata = { title: "Library" };

// The open folder is in the address (?project=…), which the page reads in the browser.
export default function LibraryPage() {
  return (
    <Suspense fallback={<LibraryFallback />}>
      <LibraryView />
    </Suspense>
  );
}
