import { cn } from "@/lib/cn";

const tones = {
  Core: "bg-spike text-spike-ink",
  New: "bg-paper text-[#16171a]",
  Video: "bg-[#5b8cff] text-white",
  Beta: "text-fog shadow-[inset_0_0_0_1px_var(--color-line-strong)]",
} as const;

export type BadgeTone = keyof typeof tones;

export function Badge({ tone, className }: { tone: BadgeTone; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-[18px] items-center rounded-[6px] px-1.5 text-[11px] font-bold leading-none italic tracking-[0.01em]",
        tones[tone],
        className,
      )}
    >
      {tone}
    </span>
  );
}
