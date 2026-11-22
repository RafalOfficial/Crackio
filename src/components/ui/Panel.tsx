import type { ComponentProps, ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";

/** The basic surface: a hairline-bordered panel. */
export function Panel({ className, ...props }: ComponentProps<"section">) {
  return <section className={cn("surface rounded-panel", className)} {...props} />;
}

export function PanelHeader({ title, children, className }: { title: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex min-h-12 items-center justify-between gap-3 border-b border-line px-4 py-2", className)}>
      <h2 className="text-[14px] font-semibold text-paper">{title}</h2>
      {children ? <div className="flex items-center gap-2">{children}</div> : null}
    </div>
  );
}

/** A bordered group of setting rows, separated by hairlines. */
export function RowGroup({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("squircle divide-y divide-line overflow-hidden rounded-[16px] shadow-[inset_0_0_0_1px_var(--color-line)]", className)}
      {...props}
    />
  );
}

/**
 * One setting: a small picture, a quiet label, the current value, optional detail tags,
 * and a chevron when it opens something.
 */
export function Row({
  thumb,
  label,
  value,
  tags,
  chevron = true,
  className,
  ...props
}: {
  thumb?: ReactNode;
  label: ReactNode;
  value?: ReactNode;
  tags?: ReactNode[];
  chevron?: boolean;
} & Omit<ComponentProps<"button">, "value">) {
  return (
    <button
      type="button"
      className={cn(
        "flex min-h-12 w-full items-center gap-3 px-3 py-2 text-left transition-colors duration-150 hover:bg-white/[0.03] focus-visible:bg-white/[0.04] active:bg-white/[0.06] disabled:pointer-events-none disabled:opacity-50",
        className,
      )}
      {...props}
    >
      {thumb ? <span className="squircle grid h-7 w-10 shrink-0 place-items-center overflow-hidden rounded-[8px] bg-apple-2">{thumb}</span> : null}
      <span className="w-[76px] shrink-0 text-[13px] text-haze">{label}</span>
      <span className="min-w-0 flex-1 truncate text-[14px] font-semibold text-paper">{value}</span>
      {tags?.length ? (
        <span className="hidden shrink-0 items-center gap-1 sm:flex">
          {tags.map((t, i) => (
            <span key={i} className="rounded-[6px] bg-apple-2 px-1.5 py-0.5 font-mono text-[11px] text-fog">
              {t}
            </span>
          ))}
        </span>
      ) : null}
      {chevron ? <ChevronRight size={15} className="shrink-0 text-haze" /> : null}
    </button>
  );
}

/** The Segmented control's sizes: a chip-row "sm", the usual "md", a roomy "lg". */
const SEGMENT = {
  sm: { track: "rounded-[10px]", item: "h-6 rounded-[8px] px-2.5 text-[11.5px]" },
  md: { track: "rounded-[12px]", item: "h-7 rounded-[10px] px-3 text-[12px]" },
  lg: { track: "rounded-[14px]", item: "h-8 rounded-[12px] px-3.5 text-[13px]" },
} as const;

/**
 * Two or three options in a pill track. Like a set of radio buttons: Tab lands on the chosen one, the arrow keys
 * (and Home/End) choose another. `label` names the group for screen readers.
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  size = "md",
  label,
  className,
}: {
  value: T;
  options: { id: T; label: ReactNode; disabled?: boolean; title?: string }[];
  onChange: (v: T) => void;
  size?: keyof typeof SEGMENT;
  label?: string;
  className?: string;
}) {
  const s = SEGMENT[size];
  const enabled = options.filter((o) => !o.disabled);
  // The chosen option takes Tab; with none chosen (or it's off), the first one that's on.
  const tabStop = enabled.some((o) => o.id === value) ? value : enabled[0]?.id;
  const step = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const keys: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    if (!(e.key in keys) && e.key !== "Home" && e.key !== "End") return;
    if (!enabled.length) return;
    e.preventDefault();
    const at = enabled.findIndex((o) => o.id === value);
    const next =
      e.key === "Home" ? enabled[0] : e.key === "End" ? enabled[enabled.length - 1] : enabled[(Math.max(0, at) + keys[e.key] + enabled.length) % enabled.length];
    onChange(next.id);
    e.currentTarget.querySelector<HTMLElement>(`[data-segment="${CSS.escape(next.id)}"]`)?.focus();
  };
  return (
    <div role="radiogroup" aria-label={label} onKeyDown={step} className={cn("squircle inline-flex bg-white/[0.05] p-0.5", s.track, className)}>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          data-segment={o.id}
          aria-checked={value === o.id}
          tabIndex={o.id === tabStop ? 0 : -1}
          disabled={o.disabled}
          title={o.title}
          onClick={() => onChange(o.id)}
          className={cn(
            "press squircle font-semibold transition-[background-color,color,box-shadow] duration-150 disabled:cursor-not-allowed disabled:opacity-40",
            s.item,
            value === o.id ? "bg-white/[0.14] text-paper shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)]" : "text-fog hover:text-paper",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  title,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: ReactNode;
  title?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      title={title}
      onClick={() => onChange(!checked)}
      className="inline-flex items-center gap-2 text-[13px] font-medium text-fog hover:text-paper"
    >
      <span className={cn("relative h-[18px] w-8 rounded-full transition-colors", checked ? "bg-spike" : "bg-gaffer")}>
        {/* The knob slides by transform (no layout per frame). */}
        <span
          className={cn(
            "absolute left-[3px] top-[3px] size-3 rounded-full bg-paper shadow transition-transform duration-200 ease-[var(--ease-out-quint)]",
            checked ? "translate-x-[14px]" : "translate-x-0",
          )}
        />
      </span>
      {label}
    </button>
  );
}

export function EmptyState({ eyebrow, title, children }: { eyebrow?: ReactNode; title: ReactNode; children?: ReactNode }) {
  return (
    <div className="grid h-full place-items-center p-8 text-center">
      <div className="max-w-[340px]">
        {eyebrow ? <p className="font-mono text-[11px] text-haze">{eyebrow}</p> : null}
        <p className="mt-1.5 text-[16px] font-semibold text-paper">{title}</p>
        {children ? <div className="mt-1.5 text-[14px] leading-relaxed text-haze">{children}</div> : null}
      </div>
    </div>
  );
}
