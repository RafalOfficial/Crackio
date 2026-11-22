import { Suspense } from "react";
import type { Metadata } from "next";
import { TrainStudio } from "@/components/train/TrainStudio";

export const metadata: Metadata = { title: "Train", description: "Train a LoRA of your own from a set of pictures, on your own GPU." };

// The open LoRA is in the address (?job=…), which the page reads in the browser.
export default function TrainPage() {
  return (
    <Suspense fallback={<div className="mx-auto max-w-[1680px] px-8 pt-6"><div className="skeleton h-[420px] rounded-[22px]" /></div>}>
      <TrainStudio />
    </Suspense>
  );
}
