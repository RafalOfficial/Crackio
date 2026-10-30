"use client";

import Link from "next/link";
import { Check, X } from "lucide-react";
import { useConnections } from "@/lib/hooks/use-connections";
import { useGenerations } from "@/lib/hooks/use-generations";
import { useShell } from "@/components/shell/shell-store";
import { cn } from "@/lib/cn";

/** Three steps for a new setup; hides itself once they're done (or dismissed). */
export function GetStarted() {
  const { usable, loaded } = useConnections();
  const genLoaded = useGenerations((s) => s.loaded);
  const madeOne = useGenerations((s) => s.items.some((g) => g.status === "done"));
  const stagedOne = useGenerations((s) => s.items.some((g) => g.tool === "director" && g.status === "done"));
  const { dismissedTips, dismissTip } = useShell();

  const steps = [
    {
      title: "Connect a plan",
      body: "Sign in with ChatGPT or Grok to use the subscription you already pay for, or add a Comfy key.",
      done: usable.length > 0,
      href: "/settings/connections",
      cta: "Open Connections",
    },
    {
      title: "Make your first shot",
      body: "Type an idea above in your own words, or drop in a photo you want to build on.",
      done: madeOne,
      href: "#composer",
      cta: "Go to the composer",
    },
    {
      title: "Stage one in Director",
      body: "Place a subject, choose the lens and the light, and compare it with your typed attempt.",
      done: stagedOne,
      href: "/director",
      cta: "Open Director",
    },
  ];
  const doneCount = steps.filter((s) => s.done).length;

  if (!loaded || !genLoaded || dismissedTips.includes("get-started") || doneCount === steps.length) return null;

  return (
    <section aria-labelledby="setup-heading" className="surface relative rounded-panel p-5 sm:p-6">
      <button
        onClick={() => dismissTip("get-started")}
        className="absolute right-4 top-4 grid size-8 place-items-center rounded-[10px] text-haze hover:bg-apple-2 hover:text-paper"
        aria-label="Hide setup steps"
      >
        <X size={16} />
      </button>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pr-10">
        <h2 id="setup-heading" className="font-display text-[24px]">
          Get set up
        </h2>
        <div className="flex items-center gap-2.5 text-[13px] text-fog">
          <div className="h-1.5 w-28 overflow-hidden rounded-full bg-apple-2">
            <div className="h-full rounded-full bg-spike transition-[width] duration-700" style={{ width: `${(doneCount / steps.length) * 100}%` }} />
          </div>
          <span className="tabular">
            {doneCount} of {steps.length} done
          </span>
        </div>
      </div>
      <ol className="mt-5 grid gap-3 md:grid-cols-3">
        {steps.map((s, i) => (
          <li key={s.title} className={cn("flex flex-col rounded-card p-4 shadow-[inset_0_0_0_1px_var(--color-line)]", s.done ? "bg-transparent" : "bg-apple-2/60")}>
            <div className="flex items-center gap-2.5">
              <span
                className={cn(
                  "tabular grid size-6 shrink-0 place-items-center rounded-full text-[12px] font-bold",
                  s.done ? "bg-chroma text-[#062b16]" : "bg-gaffer text-paper",
                )}
              >
                {s.done ? <Check size={13} strokeWidth={3} /> : i + 1}
              </span>
              <h3 className={cn("text-[15px] font-semibold", s.done && "text-fog line-through decoration-haze")}>{s.title}</h3>
            </div>
            <p className="mt-2 flex-1 text-[13px] leading-relaxed text-fog">{s.body}</p>
            {!s.done ? (
              <Link href={s.href} className="press mt-3 inline-flex h-9 w-fit items-center rounded-btn bg-paper px-4 text-[13px] font-semibold text-[#16131b] hover:bg-white">
                {s.cta}
              </Link>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
}
