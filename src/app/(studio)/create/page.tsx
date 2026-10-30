import type { Metadata } from "next";
import { CreatePanel } from "@/components/create/CreatePanel";
import { OutputPanel } from "@/components/create/OutputPanel";

export const metadata: Metadata = { title: "Image", description: "Make images and edits with any model you've connected." };

export default function CreatePage() {
  return (
    <div className="mx-auto max-w-[1440px] px-4 pb-24 pt-6 sm:px-6 lg:px-10 lg:pt-10">
      <header className="max-w-[720px]">
        <h1 className="font-display text-[34px] sm:text-[40px]">Image</h1>
        <p className="mt-2 text-[15px] leading-relaxed text-haze">
          Write the shot in your own words, add reference photos, pick the model and the frame. Every take lands in Output.
        </p>
      </header>
      <div className="mt-7 grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(380px,460px)_minmax(0,1fr)]">
        <CreatePanel />
        <div className="lg:sticky lg:top-6">
          <OutputPanel />
        </div>
      </div>
    </div>
  );
}
