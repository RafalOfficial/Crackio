"use client";

/* eslint-disable @next/next/no-img-element */
import { useState } from "react";
import Link from "next/link";
import { motion } from "motion/react";
import { Check, LoaderCircle, Plus, UserRound } from "lucide-react";
import { useCast } from "@/lib/hooks/use-cast";
import { previewUrl } from "@/lib/media-url";
import { WHO, type WhoId } from "@/lib/product/vocab";
import type { Character } from "@/lib/cast/types";
import { cn } from "@/lib/cn";

export type WhoChoice = WhoId | "cast" | "custom";

const KIND: Record<Character["kind"], string | null> = { person: null, pet: "Pet", character: "Character", object: "Object" };

/**
 * Who's in the shot, three ways: a quick pick (Crackio casts them), someone from your Cast (the same
 * face in every ad, your brand's own creator), or someone you describe.
 */
export function WhoPicker({
  who,
  castId,
  text,
  onQuick,
  onCast,
  onDescribe,
}: {
  who: WhoChoice;
  castId: string | null;
  text: string;
  onQuick: (id: WhoId) => void;
  onCast: (c: Character) => void;
  onDescribe: (text: string) => void;
}) {
  const { items, loaded } = useCast();
  const [draft, setDraft] = useState(text);
  const usable = items.filter((c) => c.kind !== "object" && (c.portrait || c.status === "building"));

  return (
    <div className="space-y-4">
      <div>
        <Heading>Quick pick</Heading>
        <div role="radiogroup" className="grid grid-cols-4 gap-1.5">
          {WHO.map((o) => {
            const active = who === o.id;
            return (
              <button
                key={o.id}
                type="button"
                role="radio"
                aria-checked={active}
                title={o.caption}
                onClick={() => onQuick(o.id)}
                className={cn(
                  "press relative h-11 whitespace-nowrap rounded-[12px] px-1 text-[12px] font-semibold transition-colors sm:text-[12.5px]",
                  active ? "text-[#16131b]" : "bg-white/[0.04] text-fog hover:bg-white/[0.08] hover:text-paper",
                )}
              >
                {active ? <motion.span layoutId="who-pill" className="absolute inset-0 rounded-[12px] bg-paper" transition={{ type: "spring", bounce: 0.18, duration: 0.38 }} /> : null}
                <span className="relative">{o.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <div className="mb-1.5 flex items-baseline justify-between gap-2">
          <Heading inline>From your Cast</Heading>
          <Link href="/cast" className="inline-flex items-center gap-1 text-[11.5px] font-semibold text-fog hover:text-paper">
            <Plus size={12} /> New character
          </Link>
        </div>
        {!loaded ? (
          <div className="grid grid-cols-4 gap-1.5">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="skeleton aspect-square rounded-[12px]" />
            ))}
          </div>
        ) : usable.length ? (
          <div className="grid grid-cols-4 gap-1.5">
            {usable.map((c) => {
              const active = who === "cast" && castId === c.id;
              const ready = Boolean(c.portrait) && c.status !== "building";
              return (
                <button
                  key={c.id}
                  type="button"
                  disabled={!ready}
                  onClick={() => onCast(c)}
                  aria-pressed={active}
                  title={c.traits ?? c.name}
                  className={cn(
                    "press group relative aspect-square overflow-hidden rounded-[12px] bg-apple-2 text-left disabled:cursor-wait",
                    active ? "" : "shadow-[inset_0_0_0_1px_var(--color-line)]",
                  )}
                >
                  {c.portrait ? (
                    <img src={previewUrl(c.portrait, 320)} alt="" className="absolute inset-0 size-full object-cover transition-transform duration-700 ease-[var(--ease-out-quint)] group-hover:scale-[1.06]" />
                  ) : (
                    <span className="absolute inset-0 grid place-items-center text-haze">
                      <LoaderCircle size={16} className="animate-spin" />
                    </span>
                  )}
                  <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/40 to-transparent px-2 pb-1.5 pt-6">
                    <span className="block truncate text-[11.5px] font-semibold leading-tight text-white">{c.name}</span>
                    {KIND[c.kind] ? <span className="block text-[10px] leading-tight text-white/60">{KIND[c.kind]}</span> : null}
                  </span>
                  {active ? (
                    <span className="pointer-events-none absolute inset-0 rounded-[12px] shadow-[inset_0_0_0_2px_var(--color-spike)]">
                      <span className="absolute right-1.5 top-1.5 grid size-[18px] place-items-center rounded-full bg-spike text-spike-ink">
                        <Check size={11} strokeWidth={3} />
                      </span>
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        ) : (
          <div className="flex items-center gap-3 rounded-[12px] bg-white/[0.03] p-3 shadow-[inset_0_0_0_1px_var(--color-line)]">
            <span className="grid size-9 shrink-0 place-items-center rounded-full bg-white/[0.06] text-fog">
              <UserRound size={16} />
            </span>
            <p className="min-w-0 flex-1 text-[12px] leading-snug text-haze">
              Save the face you promote with once, from a photo or a description, and pick them here for every ad.
            </p>
            <Link href="/cast" className="press shrink-0 rounded-full bg-white/[0.08] px-3 py-1.5 text-[12px] font-semibold text-paper hover:bg-white/[0.12]">
              Open Cast
            </Link>
          </div>
        )}
      </div>

      <div>
        <Heading>Or describe someone</Heading>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value.slice(0, 400))}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && draft.trim()) {
              e.preventDefault();
              onDescribe(draft.trim());
            }
          }}
          rows={2}
          placeholder="A woman in her 40s with silver curls and freckles, in a linen shirt… (any language)"
          className={cn(
            "w-full resize-none rounded-[12px] bg-white/[0.03] px-3 py-2.5 text-[13.5px] leading-snug outline-none placeholder:text-haze",
            who === "custom" ? "shadow-[inset_0_0_0_1.5px_var(--color-spike)]" : "shadow-[inset_0_0_0_1px_var(--color-line)] focus:shadow-[inset_0_0_0_1px_var(--color-line-strong)]",
          )}
        />
        <div className="mt-1.5 flex items-center justify-between gap-2">
          <span className="text-[11.5px] text-haze">{who === "custom" ? "Using your description" : "Press Enter or tap Use"}</span>
          <button
            type="button"
            disabled={!draft.trim()}
            onClick={() => onDescribe(draft.trim())}
            className="press h-8 rounded-full bg-paper px-3.5 text-[12px] font-bold text-[#16131b] disabled:cursor-not-allowed disabled:bg-white/[0.06] disabled:text-haze"
          >
            Use this person
          </button>
        </div>
      </div>
    </div>
  );
}

function Heading({ children, inline }: { children: string; inline?: boolean }) {
  return <p className={cn("text-[11px] font-bold uppercase tracking-[0.08em] text-haze", !inline && "mb-1.5")}>{children}</p>;
}
