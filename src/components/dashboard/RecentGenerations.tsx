"use client";

import Link from "next/link";
import { GenerationCard } from "@/components/generations/GenerationCard";
import { useGenerations } from "@/lib/hooks/use-generations";
import { takeKey, useLibrary } from "@/lib/hooks/use-library";

/** The Library's viewer on this take, in the folder it's filed in (if the Library knows yet). */
function viewHref(id: string, index: number, placements: Record<string, string>) {
  const key = takeKey(id, index);
  const folder = placements[key];
  return `/library?${folder ? `project=${encodeURIComponent(folder)}&` : ""}view=${encodeURIComponent(key)}`;
}

export function RecentGenerations() {
  const { items, loaded } = useGenerations();
  const placements = useLibrary((s) => s.placements);
  // The dashboard shows finished and rendering takes; failed ones stay in the Library.
  const shown = items.filter((g) => g.status !== "error" && g.tool !== "showcase");
  if (!loaded || shown.length === 0) return null;

  // Flatten multi-image generations so every output gets its own tile.
  const tiles = shown.flatMap((gen) => (gen.status === "done" ? gen.outputs.map((_, i) => ({ gen, i })) : [{ gen, i: 0 }])).slice(0, 15);

  return (
    <section aria-labelledby="recent-heading" id="recent" className="scroll-mt-24">
      <div className="flex items-baseline justify-between gap-4">
        <h2 id="recent-heading" className="font-display text-[28px] sm:text-[34px]">
          Recent
        </h2>
        <Link href="/library" className="text-[14px] font-medium text-fog hover:text-paper">
          Open library
        </Link>
      </div>
      <div className="mt-5 columns-2 gap-3 sm:columns-3 lg:columns-4 xl:columns-5 [&>*]:mb-3">
        {tiles.map(({ gen, i }) => (
          <div key={`${gen.id}-${i}`} className="break-inside-avoid">
            <GenerationCard gen={gen} index={i} href={gen.status === "done" ? viewHref(gen.id, i, placements) : undefined} />
          </div>
        ))}
      </div>
    </section>
  );
}
