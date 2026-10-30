import { Suspense } from "react";
import type { Metadata } from "next";
import { ComfyView } from "@/components/comfy/ComfyView";

export const metadata: Metadata = { title: "ComfyUI", description: "ComfyUI itself on each of your machines that's online, with Crackio's jobs opening as their own tab of nodes." };

// The machine and job to open are in the address (?machine=…&job=…), which the page reads in the browser.
export default function Page() {
  return (
    <Suspense>
      <ComfyView />
    </Suspense>
  );
}
