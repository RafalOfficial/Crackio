"use client";

import { useState } from "react";
import { Check, Clapperboard, LoaderCircle, RefreshCw, Sparkles, Wand2 } from "lucide-react";
import { useStoryboards } from "@/lib/hooks/use-storyboards";
import { previewUrl } from "@/lib/media-url";
import { GeneratingField } from "@/components/ui/GeneratingField";
import type { Ask, BoardMessage, Storyboard, Treatment } from "@/lib/storyboard/types";
import { cn } from "@/lib/cn";

/** The director's latest turn: its questions, or the story it proposes. */
export const latestTurn = (b: Storyboard) => [...(b.messages ?? [])].reverse().find((m) => m.role === "director");

/**
 * Before any shot is made, the film is worked out with you on the main stage: where it happens
 * (three places to look at), how busy, how it plays, what the story hinges on, then the story
 * itself, which you approve or send back.
 */
export function Development({ board }: { board: Storyboard }) {
  const turn = latestTurn(board);
  const open = turn?.asks?.filter((a) => a.kind !== "approve") ?? [];
  const approve = turn?.asks?.find((a) => a.kind === "approve" && !a.answer);
  const waiting = turn?.pending || board.dev?.waiting;

  return (
    <div className="scroll-thin flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[1040px] px-5 py-7 lg:px-8">
        <p className="label flex items-center gap-1.5">
          <Clapperboard size={12} /> {turn?.treatment ? "The story" : "Setting it up"}
        </p>
        <p className="mt-1.5 max-w-[80ch] text-[13px] leading-relaxed text-haze">&ldquo;{board.dev?.brief ?? board.scene}&rdquo;</p>

        {waiting ? (
          <Working board={board} />
        ) : turn?.treatment && approve ? (
          <Pitch board={board} turn={turn} treatment={turn.treatment} approve={approve} />
        ) : open.length && open.some((a) => !a.answer) ? (
          <Questions board={board} turn={turn!} asks={open} />
        ) : (
          <Working board={board} />
        )}
      </div>
    </div>
  );
}

function Working({ board }: { board: Storyboard }) {
  const what =
    board.status === "planning"
      ? "Planning the shots and casting the film"
      : board.dev?.waiting === "treatment"
        ? "Writing the story: who these people are, the setup and the payoff"
        : "Reading your brief";
  return (
    <div className="mt-10 grid place-items-center text-center">
      <span className="grid size-14 place-items-center rounded-[18px] bg-white/[0.04] shadow-[inset_0_0_0_1px_var(--color-line)]">
        <LoaderCircle size={22} className="animate-spin text-tool-storyboard" />
      </span>
      <p className="mt-4 text-[15px] font-semibold">{what}</p>
      <p className="mt-1.5 max-w-[52ch] text-[13px] leading-relaxed text-haze">Say anything in the bar below meanwhile; I&apos;ll fold it in.</p>
    </div>
  );
}

/* ------------------------------------------------------------------ questions */

function Questions({ board, turn, asks }: { board: Storyboard; turn: BoardMessage; asks: Ask[] }) {
  const { answer } = useStoryboards();
  const [error, setError] = useState<string | null>(null);
  const run = (p: Promise<unknown>) => p.catch((err: Error) => setError(err.message));
  const first = asks.find((a) => !a.answer);
  return (
    <div className="mt-5">
      {turn.text ? <p className="max-w-[70ch] font-display text-[24px] leading-snug sm:text-[28px]">{turn.text}</p> : null}
      <div className="mt-7 space-y-8">
        {asks.map((ask) => (
          <section key={ask.id}>
            <h3 className="text-[14px] font-semibold text-paper">{ask.question}</h3>
            {ask.kind === "pictures" ? (
              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                {ask.options.map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    disabled={Boolean(ask.answer)}
                    onClick={() => void run(answer(board.id, ask.id, o.id))}
                    className={cn(
                      "press group overflow-hidden rounded-[16px] bg-white/[0.03] text-left transition-shadow",
                      ask.answer === o.id ? "shadow-[0_0_0_2px_var(--color-tool-storyboard)]" : "shadow-[inset_0_0_0_1px_var(--color-line)] hover:shadow-[inset_0_0_0_1px_rgb(255_255_255/0.3)]",
                      ask.answer && ask.answer !== o.id && "opacity-45",
                    )}
                  >
                    <span className="relative block bg-apple" style={{ aspectRatio: board.aspect.replace(":", " / ") }}>
                      {o.image ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={previewUrl(o.image, 640)} alt="" className="absolute inset-0 size-full object-cover transition-transform duration-500 group-hover:scale-[1.03]" />
                      ) : (
                        <GeneratingField bare />
                      )}
                      {ask.answer === o.id ? (
                        <span className="absolute right-2 top-2 grid size-6 place-items-center rounded-full bg-tool-storyboard text-[#16131b]">
                          <Check size={13} strokeWidth={3} />
                        </span>
                      ) : null}
                    </span>
                    <span className="block px-3 pb-3 pt-2.5">
                      <span className="block text-[13.5px] font-semibold">{o.label}</span>
                      {o.detail ? <span className="mt-0.5 block text-[12px] leading-snug text-haze">{o.detail}</span> : null}
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="mt-3 grid gap-2 sm:grid-cols-3">
                {ask.options.map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    disabled={Boolean(ask.answer)}
                    onClick={() => void run(answer(board.id, ask.id, o.id))}
                    className={cn(
                      "press rounded-[14px] px-3.5 py-3 text-left transition-shadow",
                      ask.answer === o.id ? "bg-white/[0.07] shadow-[0_0_0_2px_var(--color-tool-storyboard)]" : "bg-white/[0.03] shadow-[inset_0_0_0_1px_var(--color-line)] hover:bg-white/[0.05]",
                      ask.answer && ask.answer !== o.id && "opacity-45",
                    )}
                  >
                    <span className="flex items-center gap-1.5 text-[13.5px] font-semibold">
                      {ask.answer === o.id ? <Check size={13} strokeWidth={3} className="text-tool-storyboard" /> : null}
                      {o.label}
                    </span>
                    {o.detail ? <span className="mt-0.5 block text-[12px] leading-snug text-haze">{o.detail}</span> : null}
                  </button>
                ))}
              </div>
            )}
          </section>
        ))}
      </div>
      <div className="mt-8 flex flex-wrap items-center gap-3">
        {first ? (
          <button
            type="button"
            onClick={() => void run(answer(board.id, first.id, "director"))}
            className="press inline-flex h-9 items-center gap-1.5 rounded-full bg-white/[0.06] px-4 text-[13px] font-semibold text-fog hover:bg-white/[0.1] hover:text-paper"
          >
            <Wand2 size={14} /> Your call: just make it
          </button>
        ) : null}
        <span className="text-[12px] text-haze">Or answer in your own words below.</span>
        {error ? <span className="text-[12px] text-tally">{error}</span> : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ the pitch */

function Pitch({ board, turn, treatment: t, approve }: { board: Storyboard; turn: BoardMessage; treatment: Treatment; approve: Ask }) {
  const { answer } = useStoryboards();
  const [error, setError] = useState<string | null>(null);
  const run = (p: Promise<unknown>) => p.catch((err: Error) => setError(err.message));
  const place = board.dev?.place;
  return (
    <article className="mt-5">
      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="min-w-0">
          <h2 className="font-display text-[32px] leading-tight sm:text-[38px]">{t.title}</h2>
          <p className="mt-2 text-[15.5px] leading-relaxed text-paper">{t.logline}</p>
          {turn.text ? <p className="mt-3 text-[13.5px] leading-relaxed text-fog">{turn.text}</p> : null}
        </div>
        {place ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={previewUrl(place, 640)} alt="The place" className="w-full rounded-[14px] object-cover shadow-[0_0_0_1px_var(--color-line)]" style={{ aspectRatio: board.aspect.replace(":", " / ") }} />
        ) : null}
      </div>

      {t.world ? (
        <section className="mt-6">
          <h3 className="label">The world</h3>
          <p className="mt-1.5 max-w-[80ch] text-[13.5px] leading-relaxed text-fog">{t.world}</p>
        </section>
      ) : null}

      <section className="mt-6">
        <h3 className="label">Who&apos;s in it</h3>
        <div className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {t.characters.map((c) => (
            <div key={c.name} className="rounded-[14px] bg-white/[0.03] p-3 shadow-[inset_0_0_0_1px_var(--color-line)]">
              <p className="text-[13.5px] font-semibold">{c.name}</p>
              <p className="text-[12px] text-tool-storyboard">{c.role}</p>
              {c.want ? <p className="mt-1 text-[12px] leading-snug text-fog">Wants {c.want.replace(/^wants?\s+/i, "")}</p> : null}
              <p className="mt-1 line-clamp-3 text-[11.5px] leading-snug text-haze">{c.look}</p>
            </div>
          ))}
          {t.props?.map((p) => (
            <div key={p.name} className="rounded-[14px] bg-white/[0.03] p-3 shadow-[inset_0_0_0_1px_var(--color-line)]">
              <p className="text-[13.5px] font-semibold">{p.name}</p>
              <p className="text-[12px] text-tool-storyboard">{p.role}</p>
              <p className="mt-1 line-clamp-3 text-[11.5px] leading-snug text-haze">{p.look}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mt-6">
        <h3 className="label">How it plays</h3>
        <ol className="mt-2 space-y-2">
          {t.beats.map((beat, i) => (
            <li key={i} className="flex gap-3 text-[13.5px] leading-relaxed">
              <span className="tabular grid size-6 shrink-0 place-items-center rounded-full bg-white/[0.07] font-mono text-[11px] font-bold">{i + 1}</span>
              <span>
                <span className="font-semibold text-paper">{beat.title}.</span> <span className="text-fog">{beat.what}</span>
              </span>
            </li>
          ))}
        </ol>
        {t.ending ? (
          <p className="mt-3 flex gap-2 text-[13.5px] leading-relaxed text-fog">
            <Sparkles size={14} className="mt-1 shrink-0 text-tool-storyboard" /> {t.ending}
          </p>
        ) : null}
      </section>

      <div className="sticky bottom-0 mt-7 flex flex-wrap items-center gap-3 bg-gradient-to-t from-stage via-stage/95 to-transparent pb-1 pt-4">
        <button
          type="button"
          onClick={() => void run(answer(board.id, approve.id, "shoot"))}
          className="press inline-flex h-10 items-center gap-2 rounded-full bg-spike px-5 text-[13.5px] font-bold text-spike-ink hover:bg-spike-hi"
        >
          <Clapperboard size={15} /> Shoot it
        </button>
        <button
          type="button"
          onClick={() => void run(answer(board.id, approve.id, "another"))}
          className="press inline-flex h-10 items-center gap-2 rounded-full bg-white/[0.06] px-4 text-[13px] font-semibold text-fog hover:bg-white/[0.1] hover:text-paper"
        >
          <RefreshCw size={14} /> Another idea
        </button>
        <span className="text-[12px] text-haze">Or say what to change below.</span>
        {error ? <span className="text-[12px] text-tally">{error}</span> : null}
      </div>
    </article>
  );
}
