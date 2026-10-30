import { ASPECTS } from "@/lib/shot";

/** Tiny rectangle drawn at the aspect ratio, so the shape reads before the numbers. */
export function AspectGlyph({ id, max = 14 }: { id: string; max?: number }) {
  const a = ASPECTS.find((x) => x.id === id) ?? ASPECTS[4];
  const w = a.w >= a.h ? max : Math.round((max * a.w) / a.h);
  const h = a.h >= a.w ? max : Math.round((max * a.h) / a.w);
  return (
    <span className="grid shrink-0 place-items-center" style={{ width: max + 2, height: max + 2 }} aria-hidden="true">
      <span className="rounded-[2px] border-[1.5px] border-current opacity-80" style={{ width: w, height: h }} />
    </span>
  );
}
