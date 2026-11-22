"use client";

import { LoraSection } from "@/components/loras/LoraSection";
import { useLocalStore, useLocalWatch } from "@/lib/hooks/use-local";
import { Verdict } from "./parts";

/**
 * Settings → LoRAs: the LoRA library as its own page (it used to sit at the foot of Models, past every model list).
 * Pick a model and browse the LoRAs made for it, most popular first, each with an example; one button adds one. Until
 * your machines are read, its place is held with cards to come.
 */
export function LorasView() {
  useLocalWatch(true);
  const status = useLocalStore((s) => s.status);
  const catalog = useLocalStore((s) => s.catalog);
  return (
    <div>
      <Verdict title="LoRAs" facts="Small add-ons that change how one model draws: a look, a camera move, an effect. Add one and it's on for everything that model makes." />
      {status && catalog ? (
        <LoraSection catalog={catalog} status={status} />
      ) : (
        <div className="mt-6 grid grid-cols-[repeat(auto-fill,minmax(212px,1fr))] gap-3">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="skeleton aspect-[4/5] rounded-[18px]" />
          ))}
        </div>
      )}
    </div>
  );
}
