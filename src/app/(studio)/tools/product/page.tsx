import { Suspense } from "react";
import type { Metadata } from "next";
import { toolBySlug } from "@/lib/tools";
import { ProductStudio } from "@/components/product/ProductStudio";

const tool = toolBySlug("product")!;
export const metadata: Metadata = { title: tool.name, description: tool.summary };

/** While the studio loads in the browser: its header and two panels, not a blank page. */
function Loading() {
  return (
    <div className="mx-auto max-w-[1440px] px-4 pb-16 pt-6 sm:px-6 lg:px-10 lg:pt-10" aria-hidden>
      <div className="flex items-start gap-3">
        <div className="skeleton mt-1 size-9 rounded-[10px]" />
        <div className="min-w-0 flex-1 space-y-2.5">
          <div className="skeleton h-8 w-56 rounded-[10px]" />
          <div className="skeleton h-4 w-full max-w-[560px] rounded" />
        </div>
      </div>
      <div className="mt-7 grid grid-cols-1 gap-4 lg:grid-cols-[minmax(380px,460px)_minmax(0,1fr)]">
        <div className="skeleton h-[70vh] rounded-panel" />
        <div className="skeleton hidden h-[70vh] rounded-panel lg:block" />
      </div>
    </div>
  );
}

// Image or Video mode is in the address (?mode=video), which the page reads in the browser.
export default function Page() {
  return (
    <Suspense fallback={<Loading />}>
      <ProductStudio />
    </Suspense>
  );
}
