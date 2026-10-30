"use client";

/* eslint-disable @next/next/no-img-element */
import Link from "next/link";
import { AtSign, LoaderCircle, Plus, X } from "lucide-react";
import { Popover } from "@/components/ui/Popover";
import { useCast } from "@/lib/hooks/use-cast";
import { MENTION, formatHeight, mentionedHandles, type Character } from "@/lib/cast/types";
import { cn } from "@/lib/cn";

/** "@mia" out of a prompt, with the space after it. */
const without = (prompt: string, handle: string) =>
  prompt
    .replace(MENTION, (all, lead: string, h: string) => (h.toLowerCase() === handle ? lead : all))
    .replace(/\s{2,}/g, " ")
    .trimStart();

/**
 * Who from your Cast is in this shot: the people, animals and things the prompt @mentions, a way to add more, and how
 * the model that will run takes them (`how`).
 */
export function CastStrip({ prompt, onChange, how, className }: { prompt: string; onChange: (next: string) => void; how?: string | null; className?: string }) {
  const { items } = useCast();
  const handles = mentionedHandles(prompt);
  const inShot = handles.map((h) => items.find((c) => c.handle === h)).filter((c): c is Character => Boolean(c));
  const others = items.filter((c) => !handles.includes(c.handle) && c.status !== "error");
  if (!items.length) return null;

  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex flex-wrap items-center gap-1.5">
        {inShot.map((c) => (
          <span key={c.id} className="inline-flex h-8 items-center gap-1.5 rounded-full bg-white/[0.06] pl-1 pr-1.5 text-[12.5px] font-semibold text-paper">
            <span className="relative size-6 overflow-hidden rounded-full bg-apple">
              {c.portrait || c.photos[0] ? <img src={c.portrait ?? c.photos[0]} alt="" className="size-full object-cover" /> : null}
              {c.status === "building" ? <LoaderCircle size={12} className="absolute inset-0 m-auto animate-spin text-paper" /> : null}
            </span>
            {c.name}
            {c.height ? <span className="font-normal text-haze">{formatHeight(c.height)}</span> : null}
            <button type="button" onClick={() => onChange(without(prompt, c.handle))} className="grid size-5 place-items-center rounded-full text-haze hover:bg-white/10 hover:text-paper" aria-label={`Take ${c.name} out`}>
              <X size={11} strokeWidth={2.6} />
            </button>
          </span>
        ))}
        <Popover
          placement="bottom-start"
          panelClassName="w-[300px] p-1.5"
          trigger={({ open, toggle }) => (
            <button
              type="button"
              onClick={toggle}
              aria-expanded={open}
              className={cn("press inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-semibold text-fog shadow-[inset_0_0_0_1px_var(--color-line-strong)] hover:text-paper", open && "bg-white/[0.06] text-paper")}
            >
              <Plus size={13} /> {inShot.length ? "Add" : "Add from Cast"}
            </button>
          )}
        >
          {(close) => (
            <div className="max-h-[min(360px,calc(var(--popover-max-h,60vh)-16px))] overflow-y-auto">
              <p className="flex items-center gap-1.5 px-2 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-haze">
                <AtSign size={11} /> Cast
              </p>
              {others.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => {
                    onChange(`${prompt.trimEnd()}${prompt.trim() ? " " : ""}@${c.handle} `);
                    close();
                  }}
                  className="squircle flex w-full items-center gap-2.5 rounded-[12px] px-2 py-1.5 text-left text-fog hover:bg-gaffer hover:text-paper"
                >
                  <span className="relative size-8 shrink-0 overflow-hidden rounded-[9px] bg-apple">
                    {c.portrait || c.photos[0] ? <img src={c.portrait ?? c.photos[0]} alt="" className="size-full object-cover" /> : null}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-semibold text-paper">{c.name}</span>
                    <span className="block truncate font-mono text-[11px] text-haze">
                      @{c.handle}
                      {c.height ? ` · ${formatHeight(c.height)}` : ""}
                    </span>
                  </span>
                  {c.status === "building" ? <span className="text-[11px] text-haze">Building</span> : null}
                </button>
              ))}
              {!others.length ? <p className="px-2 py-2 text-[12.5px] text-fog">Everyone in your cast is in this shot.</p> : null}
              <Link href="/cast" onClick={close} className="mt-1 flex items-center gap-1.5 rounded-[12px] px-2 py-1.5 text-[12px] font-semibold text-fog hover:bg-gaffer/60 hover:text-paper">
                <Plus size={13} /> Add someone or something new
              </Link>
            </div>
          )}
        </Popover>
      </div>
      {inShot.length && how ? <p className="text-[12px] leading-relaxed text-haze">{how}</p> : null}
    </div>
  );
}
