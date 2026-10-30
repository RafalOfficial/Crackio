"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, Download, Film, LoaderCircle, MoreHorizontal, Pause, Play, Plus, Sparkles, Trash } from "lucide-react";
import { AppIcon } from "@/components/ui/ToolTile";
import { Popover, MenuItem } from "@/components/ui/Popover";
import { ModelPicker } from "@/components/models/ModelPicker";
import { ResolutionChip } from "@/components/models/ResolutionChip";
import { isBusy, useStoryboards, useStoryboardsLive } from "@/lib/hooks/use-storyboards";
import { lookById, screenTime, shotDone, type Storyboard } from "@/lib/storyboard/types";
import { previewUrl } from "@/lib/media-url";
import { cn } from "@/lib/cn";
import { SequencePlayer, clock, type PlayerHandle } from "./SequencePlayer";
import { Timeline } from "./Timeline";
import { DirectorPanel } from "./DirectorPanel";
import { PromptBar } from "./PromptBar";
import { Development, latestTurn } from "./Development";
import { shotState } from "./shot-state";

const IDEAS = [
  {
    title: "Rooftop getaway",
    prompt: "@sigeon lands on a tall roof in a night thunderstorm, finds @hamster sheltering by the chimney, the hamster climbs onto his back and they fly off into the storm over the city",
  },
  { title: "Lighthouse keeper", prompt: "An old keeper climbs the spiral stairs of a lighthouse at dusk and lights the great lamp just as a storm rolls in over the sea" },
  { title: "Street race", prompt: "Two kids race homemade wooden go-karts down a steep sunny street in Lisbon, neck and neck, and crash laughing into a pile of cardboard boxes at the bottom" },
  { title: "First snow", prompt: "A golden retriever puppy steps outside into its first snow, sniffs it, sneezes, then bounds through the garden throwing snow everywhere while the family watches from the window" },
];

/** What the board is doing right now, in one line. */
function statusLine(b: Storyboard) {
  if (b.status === "developing") {
    if (b.dev?.waiting === "treatment") return "Writing the story";
    if (b.dev?.waiting === "develop") return "Reading your brief";
    return latestTurn(b)?.treatment ? "Story ready: shoot it?" : "Waiting for your choices";
  }
  if (b.status === "planning") return "Planning";
  if (b.status === "error") return "Couldn't plan";
  if (b.version !== 3) return "Old storyboard";
  if (b.messages?.some((m) => m.pending)) return "Reading your message";
  if (b.paused) return "Paused";
  const i = b.shots.findIndex((s) => !shotDone(s));
  if (i >= 0) return `Shot ${i + 1} of ${b.shots.length} · ${shotState(b, b.shots[i], i).label}`;
  if (b.finalJob) return "Putting the film together";
  return b.final ? "Film ready" : "Done";
}

/**
 * Storyboard as an editor: the film plays on top, its shots run along a timeline under it, the
 * director you're talking to sits on the right, and you type at the bottom. Every film you start
 * is a project here; switch between them from the top left.
 */
export function StoryboardStudio() {
  useStoryboardsLive();
  const { items, loaded, current, open } = useStoryboards();
  const board = items.find((b) => b.id === current) ?? null;
  const [selected, setSelected] = useState<string | null>(null);
  const [t, setT] = useState(0);
  const player = useRef<PlayerHandle>(null);

  // Open the most recent film the first time.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || !loaded) return;
    opened.current = true;
    if (!current && items[0]) open(items[0].id);
  }, [loaded, items, current, open]);

  const onTime = useCallback((time: number) => setT(time), []);
  const seek = useCallback((time: number) => player.current?.seek(time), []);

  return (
    <div className="flex flex-col lg:h-dvh">
      <TopBar board={board} />

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {!loaded ? (
            <div className="flex-1 p-4">
              <div className="skeleton h-full min-h-[320px] rounded-panel" />
            </div>
          ) : board && board.status !== "planning" && board.shots.length ? (
            <>
              <SequencePlayer key={board.id} ref={player} board={board} onTime={onTime} className="min-h-[220px] flex-1 px-4 pb-3 pt-4 lg:px-6" />
              <div className="border-t border-line px-2 pb-1 pt-1.5 lg:px-4">
                <Timeline board={board} t={t} selected={selected} onSeek={seek} onSelect={setSelected} />
              </div>
            </>
          ) : board && (board.status === "developing" || (board.status === "planning" && board.dev)) ? (
            <Development board={board} />
          ) : board ? (
            <Planning board={board} />
          ) : (
            <Welcome />
          )}
          <div className="sticky bottom-0 z-20 px-3 pb-3 pt-2 lg:static lg:px-6 lg:pb-5">
            <div className="mx-auto max-w-[920px]">
              <PromptBar board={board} />
            </div>
          </div>
        </div>

        {board ? (
          <aside className="flex max-h-[70dvh] min-h-[320px] flex-col border-t border-line lg:max-h-none lg:w-[400px] lg:shrink-0 lg:border-l lg:border-t-0 xl:w-[440px]">
            <DirectorPanel board={board} selected={selected} onSelect={setSelected} />
          </aside>
        ) : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ top bar */

function TopBar({ board }: { board: Storyboard | null }) {
  const { update, stitch, remove } = useStoryboards();
  const [error, setError] = useState<string | null>(null);
  const run = (p: Promise<unknown>) => p.catch((err: Error) => setError(err.message));
  const total = board ? board.shots.reduce((s, x) => s + screenTime(x), 0) : 0;
  const v3 = board?.version === 3;
  const working = board ? isBusy(board) : false;

  return (
    <header className="flex min-h-14 flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-3 py-2 lg:px-4">
      <AppIcon glyph="/icons/storyboard.png" hue="var(--color-tool-storyboard)" size={30} />
      <Projects board={board} />

      {board ? (
        <div className="min-w-0 flex-1">
          <TitleField key={`${board.id}:${board.title}`} title={board.title} onSave={(title) => void run(update(board.id, { title }))} />
          <p className="flex flex-wrap items-center gap-x-2 text-[11.5px] text-haze">
            <span>
              {lookById(board.look).label} · {board.aspect} · {board.shots.length} shots · {clock(total)}
              {board.target ? ` of ${clock(board.target)}` : ""}
            </span>
            <span className={cn("inline-flex items-center gap-1", working ? "text-paper" : "")}>
              {working && !board.paused ? <LoaderCircle size={10} className="animate-spin" /> : null}
              {statusLine(board)}
            </span>
            {error ? <span className="text-tally">{error}</span> : null}
          </p>
        </div>
      ) : (
        <p className="flex-1 text-[15px] font-semibold">New film</p>
      )}

      {board && v3 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="hidden items-center gap-1 xl:flex" title="The model that draws the frames">
            <span className="label">Frames</span>
            <ModelPicker kind="image" value={board.models?.image ?? "auto"} onChange={(id) => void run(update(board.id, { models: { image: id === "auto" ? null : id } }))} variant="chip" placement="bottom-end" />
            <ResolutionChip model={board.models?.image ?? "auto"} value={board.models?.resolution ?? null} onChange={(r) => void run(update(board.id, { models: { resolution: r } }))} />
          </span>
          <span className="hidden items-center gap-1 xl:flex" title="The model that animates the clips">
            <span className="label">Clips</span>
            <ModelPicker kind="video" value={board.models?.video ?? "auto"} onChange={(id) => void run(update(board.id, { models: { video: id === "auto" ? null : id } }))} variant="chip" placement="bottom-end" />
          </span>
          {board.status === "ready" && board.shots.some((s) => !shotDone(s)) ? (
            <button
              type="button"
              onClick={() => void run(update(board.id, { paused: !board.paused }))}
              className="press inline-flex h-8 items-center gap-1.5 rounded-full bg-white/[0.06] px-3 text-[12.5px] font-semibold text-fog hover:bg-white/[0.1] hover:text-paper"
            >
              {board.paused ? <Play size={13} /> : <Pause size={13} />} {board.paused ? "Go on" : "Pause"}
            </button>
          ) : null}
          {board.final ? (
            <a
              href={board.final}
              download={`${board.title}.mp4`}
              className="press inline-flex h-8 items-center gap-1.5 rounded-full bg-paper px-3 text-[12.5px] font-semibold text-[#16131b] hover:bg-white"
            >
              <Download size={13} /> MP4
            </a>
          ) : board.finalJob ? (
            <span className="inline-flex h-8 items-center gap-1.5 rounded-full bg-white/[0.06] px-3 text-[12.5px] font-semibold text-fog">
              <LoaderCircle size={13} className="animate-spin" /> Exporting
            </span>
          ) : null}
        </div>
      ) : null}

      {board ? (
        <Popover
          placement="bottom-end"
          trigger={({ open, toggle }) => (
            <button type="button" onClick={toggle} aria-expanded={open} className="press grid size-8 place-items-center rounded-full text-fog hover:bg-white/[0.06] hover:text-paper" aria-label="More">
              <MoreHorizontal size={16} />
            </button>
          )}
        >
          {(close) => (
            <div role="menu">
              <MenuItem
                disabled={!board.shots.some((s) => s.frame || s.clip) || Boolean(board.finalJob)}
                onSelect={() => {
                  close();
                  void run(stitch(board.id));
                }}
              >
                <Film size={13} /> Export the film again
              </MenuItem>
              <MenuItem
                onSelect={() => {
                  close();
                  if (window.confirm(`Delete “${board.title}”? Its frames and clips stay in the Library.`)) void run(remove(board.id));
                }}
              >
                <Trash size={13} /> Delete this film
              </MenuItem>
            </div>
          )}
        </Popover>
      ) : null}
    </header>
  );
}

function TitleField({ title, onSave }: { title: string; onSave: (title: string) => void }) {
  const [value, setValue] = useState(title);
  return (
    <input
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => value.trim() && value.trim() !== title && onSave(value.trim())}
      onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
      aria-label="Title"
      className="w-full min-w-0 truncate rounded-[8px] bg-transparent text-[15px] font-semibold text-paper outline-none focus:bg-white/[0.04]"
    />
  );
}

function Projects({ board }: { board: Storyboard | null }) {
  const { items, open } = useStoryboards();
  return (
    <Popover
      placement="bottom-start"
      panelClassName="w-[340px] p-1.5"
      trigger={({ open: shown, toggle }) => (
        <button type="button" onClick={toggle} aria-expanded={shown} className="press inline-flex h-8 shrink-0 items-center gap-1 rounded-full bg-white/[0.06] px-3 text-[12.5px] font-semibold text-fog hover:bg-white/[0.1] hover:text-paper">
          Films <span className="tabular text-haze">{items.length}</span> <ChevronDown size={12} />
        </button>
      )}
    >
      {(close) => (
        <div role="menu" className="scroll-thin max-h-[420px] overflow-y-auto">
          <MenuItem
            selected={!board}
            onSelect={() => {
              open(null);
              close();
            }}
          >
            <span className="grid h-9 w-14 shrink-0 place-items-center rounded-[7px] bg-white/[0.05]">
              <Plus size={14} />
            </span>
            New film
          </MenuItem>
          {items.map((b) => {
            const cover = b.shots.find((s) => s.frame)?.frame ?? b.plate;
            return (
              <MenuItem
                key={b.id}
                selected={b.id === board?.id}
                onSelect={() => {
                  open(b.id);
                  close();
                }}
              >
                <span className="relative h-9 w-14 shrink-0 overflow-hidden rounded-[7px] bg-apple">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  {cover ? <img src={previewUrl(cover, 160)} alt="" className="size-full object-cover" /> : null}
                  {isBusy(b) && !b.paused ? <LoaderCircle size={12} className="absolute inset-0 m-auto animate-spin text-paper" /> : null}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[13px] font-semibold text-paper">{b.title}</span>
                  <span className="block truncate text-[11.5px] text-haze">{statusLine(b)}</span>
                </span>
              </MenuItem>
            );
          })}
        </div>
      )}
    </Popover>
  );
}

/* ------------------------------------------------------------------ empty states */

function Welcome() {
  return (
    <div className="scroll-thin flex flex-1 flex-col items-center justify-center overflow-y-auto px-6 py-10">
      <div className="w-full max-w-[860px]">
        <p className="font-display text-[34px] leading-tight sm:text-[44px]">What&apos;s the film?</p>
        <p className="mt-2 max-w-[66ch] text-[14px] leading-relaxed text-fog">
          Describe it in your own words, even in one line. The director works it out with you first (where it happens, how it plays, the story behind it), casts it, then makes it one shot at a
          time: each shot starts from the exact frame the last one was cut on, every frame is checked and every take is watched before it moves on. Talk to it any time to change anything.
        </p>
        <div className="mt-7 grid gap-2 sm:grid-cols-2">
          {IDEAS.map((idea) => (
            <button
              key={idea.title}
              type="button"
              onClick={() => window.dispatchEvent(new CustomEvent("storyboard:prompt", { detail: idea.prompt }))}
              className="press rounded-[14px] p-3.5 text-left shadow-[inset_0_0_0_1px_var(--color-line)] transition-colors hover:bg-white/[0.04]"
            >
              <span className="flex items-center gap-1.5 text-[13px] font-semibold">
                <Sparkles size={12} className="text-tool-storyboard" /> {idea.title}
              </span>
              <span className="mt-1 block text-[12px] leading-snug text-haze">{idea.prompt}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function Planning({ board }: { board: Storyboard }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 py-10 text-center">
      {board.status === "error" ? (
        <>
          <p className="text-[15px] font-semibold text-tally">The plan didn&apos;t come through</p>
          <p className="mt-1.5 max-w-[60ch] text-[13px] text-fog">{board.error}</p>
          <p className="mt-1 text-[12.5px] text-haze">Send a message below to try again, with more detail if you like.</p>
        </>
      ) : (
        <>
          <span className="grid size-14 place-items-center rounded-[18px] bg-white/[0.04] shadow-[inset_0_0_0_1px_var(--color-line)]">
            <LoaderCircle size={22} className="animate-spin text-tool-storyboard" />
          </span>
          <p className="mt-4 text-[15px] font-semibold">Planning the film</p>
          <p className="mt-1.5 max-w-[56ch] text-[13px] leading-relaxed text-haze">
            Writing the continuity bible and the look every shot shares, then breaking it into beats that each fill their seconds at real speed. The first frame starts as soon as the plan is ready.
          </p>
        </>
      )}
    </div>
  );
}
