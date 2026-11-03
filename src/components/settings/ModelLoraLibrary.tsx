"use client";

import { LoraSection } from "@/components/loras/LoraSection";
import { useLocal } from "@/lib/hooks/use-local";
import { Heading } from "./parts";

/**
 * Settings → Models → LoRAs: Crackio's checked LoRAs for every open model and the rest of Hugging Face, installed on the
 * machines that have the model (the same library the model drawer's LoRAs button opens).
 */
export function ModelLoraLibrary() {
  const { status, catalog } = useLocal();
  return (
    <section id="loras" className="mt-12 scroll-mt-24 space-y-3">
      <Heading title="LoRAs" note="Small add-ons that teach a model a look, a subject or a skill. Switch them on per model; they install where the model is." />
      {status && catalog ? <LoraSection catalog={catalog} status={status} /> : <div className="skeleton h-40 rounded-[18px]" />}
    </section>
  );
}
