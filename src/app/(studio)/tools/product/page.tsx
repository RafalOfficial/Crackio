import { Suspense } from "react";
import type { Metadata } from "next";
import { toolBySlug } from "@/lib/tools";
import { ProductStudio } from "@/components/product/ProductStudio";

const tool = toolBySlug("product")!;
export const metadata: Metadata = { title: tool.name, description: tool.summary };

// Image or Video mode is in the address (?mode=video), which the page reads in the browser.
export default function Page() {
  return (
    <Suspense fallback={null}>
      <ProductStudio />
    </Suspense>
  );
}
