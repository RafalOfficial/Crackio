import Link from "next/link";
import type { ComponentProps, CSSProperties, ReactNode } from "react";
import { cn } from "@/lib/cn";

type Variant = "primary" | "secondary" | "ghost" | "outline" | "spike" | "paper" | "subtle";
type Size = "sm" | "md" | "lg";

const variants: Record<Variant, string> = {
  // The one loud button on a screen.
  primary: "lip bg-spike text-spike-ink hover:bg-spike-hi uppercase tracking-[0.04em] font-bold [--lip:var(--color-spike-lip)]",
  secondary: "bg-white/[0.06] text-paper hover:bg-white/[0.1]",
  ghost: "text-fog hover:text-paper hover:bg-white/[0.05]",
  outline: "text-paper shadow-[inset_0_0_0_1px_var(--color-line-strong)] hover:bg-white/[0.04]",
  // Aliases kept for older call sites.
  spike: "lip bg-spike text-spike-ink hover:bg-spike-hi font-bold [--lip:var(--color-spike-lip)]",
  paper: "bg-paper text-[#16131b] hover:bg-white",
  subtle: "bg-white/[0.06] text-paper hover:bg-white/[0.1]",
};

// Squircle corners that grow with the button (see "Squircles" in globals.css).
const sizes: Record<Size, string> = {
  sm: "h-8 px-3.5 text-[12.5px] gap-1.5 rounded-[11px]",
  md: "h-10 px-4 text-[13px] gap-2 rounded-btn",
  lg: "h-12 px-6 text-[14px] gap-2 rounded-[16px]",
};

type Common = {
  variant?: Variant;
  size?: Size;
  className?: string;
  children?: ReactNode;
  style?: CSSProperties;
};

const base =
  "press squircle inline-flex select-none items-center justify-center whitespace-nowrap font-semibold disabled:pointer-events-none disabled:opacity-45";

export function Button({ variant = "secondary", size = "md", className, ...props }: Common & ComponentProps<"button">) {
  return <button className={cn(base, variants[variant], sizes[size], className)} {...props} />;
}

export function ButtonLink({ variant = "secondary", size = "md", className, href, ...props }: Common & ComponentProps<typeof Link>) {
  return <Link href={href} className={cn(base, variants[variant], sizes[size], className)} {...props} />;
}
