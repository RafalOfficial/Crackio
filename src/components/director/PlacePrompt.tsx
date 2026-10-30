"use client";

import { useState } from "react";
import { LoaderCircle, Sparkles } from "lucide-react";
import { generateLocation, useLocation } from "./location";
import { cn } from "@/lib/cn";

/** Say what the place is and it's made: one wide picture, then the world all around it. */
export function PlacePrompt({ className, autoFocus }: { className?: string; autoFocus?: boolean }) {
  const [words, setWords] = useState("");
  const { busy, error } = useLocation();
  const go = () => void generateLocation(words);
  return (
    <div className={className}>
      <div className="squircle flex items-center gap-1 rounded-[14px] bg-white/[0.05] p-1 shadow-[inset_0_0_0_1px_var(--color-line)] focus-within:shadow-[inset_0_0_0_1.5px_var(--color-spike)]">
        <input
          autoFocus={autoFocus}
          value={words}
          disabled={busy}
          onChange={(e) => setWords(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && go()}
          placeholder="Describe a place: a rainy neon alley at night"
          className="h-9 min-w-0 flex-1 bg-transparent px-2.5 text-[13.5px] outline-none placeholder:text-haze disabled:opacity-60"
        />
        <button
          type="button"
          onClick={go}
          disabled={busy || !words.trim()}
          className={cn("press squircle flex h-9 shrink-0 items-center gap-1.5 rounded-[10px] bg-spike px-3 text-[13px] font-semibold text-spike-ink", "disabled:opacity-50")}
        >
          {busy ? <LoaderCircle size={14} className="animate-spin" /> : <Sparkles size={14} />}
          {busy ? "Making it" : "Generate"}
        </button>
      </div>
      {error ? <p className="mt-1.5 text-left text-[12px] text-tally">{error}</p> : null}
    </div>
  );
}
