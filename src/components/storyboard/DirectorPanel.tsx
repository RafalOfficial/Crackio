"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Check,
  ChevronDown,
  Clapperboard,
  Film,
  ImageIcon,
  Link2,
  LoaderCircle,
  Pencil,
  RefreshCw,
  Scissors,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
  Wrench,
  X,
} from "lucide-react";
import { AppIcon } from "@/components/ui/ToolTile";
import { Button } from "@/components/ui/Button";
import { useStoryboards } from "@/lib/hooks/use-storyboards";
import { previewUrl } from "@/lib/media-url";
import { GeneratingField } from "@/components/ui/GeneratingField";
import type { Ask, BoardEvent, BoardMessage, Shot, Storyboard, Treatment } from "@/lib/storyboard/types";
import { cn } from "@/lib/cn";
import { shotState, TONE } from "./shot-state";

const EVENT_ICON: Record<BoardEvent["kind"], typeof Film> = {
  plan: Clapperboard,
  frame: ImageIcon,
  check: ShieldCheck,
  fix: Wrench,
  clip: Film,
  review: Scissors,
  retake: RefreshCw,
  cut: Scissors,
  film: Sparkles,
  error: TriangleAlert,
  note: Sparkles,
};

const mention = (text: string) =>
  text.split(/(@[a-z0-9_]{2,24})/gi).map((part, i) =>
    i % 2 ? (
      <span key={i} className="font-semibold text-paper">
        {part}
      </span>
    ) : (
      part
    ),
  );

/** The right side of the editor: the open shot on top, and the conversation with the director. */
export function DirectorPanel({ board, selected, onSelect }: { board: Storyboard; selected: string | null; onSelect: (id: string | null) => void }) {
  const shot = board.shots.find((s) => s.id === selected);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {shot ? <Inspector key={shot.id} board={board} s={shot} onClose={() => onSelect(null)} /> : <KitStrip board={board} />}
      <Conversation board={board} onSelect={onSelect} compact={Boolean(shot)} />
    </div>
  );
}

/* ------------------------------------------------------------------ conversation */

function Conversation({ board, onSelect, compact }: { board: Storyboard; onSelect: (id: string | null) => void; compact: boolean }) {
  const list = useRef<HTMLDivElement>(null);
  const messages = board.messages ?? [];
  const last = messages.at(-1);
  const pulse = `${messages.length}:${last?.events?.length ?? 0}:${last?.text.length ?? 0}`;
  // Follow the newest message inside the panel only (scrollIntoView would scroll the page on phones).
  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [pulse]);

  if (board.version !== 3) {
    return (
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-4 py-4 text-[13px] leading-relaxed text-fog">
        <p className="font-semibold text-paper">Made with the old storyboard</p>
        <p className="mt-1">
          Its frames were drawn first and animated separately, so the clips don&apos;t pick up where the last one ended. Remake it and the director will plan it again and make it shot by shot, each one starting
          from the exact frame the last one was cut on.
        </p>
        <p className="mt-3 text-[12.5px] text-haze">&ldquo;{board.scene}&rdquo;</p>
      </div>
    );
  }

  return (
    <div ref={list} className={cn("scroll-thin min-h-0 flex-1 space-y-4 overflow-y-auto px-3.5 py-4", compact && "border-t border-line")}>
      {messages.map((m) => (m.role === "user" ? <UserTurn key={m.id} m={m} /> : <DirectorTurn key={m.id} m={m} board={board} onSelect={onSelect} />))}
    </div>
  );
}

function UserTurn({ m }: { m: BoardMessage }) {
  return (
    <div className="flex justify-end">
      <p className="max-w-[88%] whitespace-pre-wrap rounded-[16px] rounded-br-[6px] bg-white/[0.07] px-3.5 py-2.5 text-[13.5px] leading-relaxed">{mention(m.text)}</p>
    </div>
  );
}

function DirectorTurn({ m, board, onSelect }: { m: BoardMessage; board: Storyboard; onSelect: (id: string | null) => void }) {
  const events = m.events ?? [];
  const [all, setAll] = useState(false);
  const shown = all ? events : events.slice(-8);
  return (
    <div className="flex gap-2.5">
      <AppIcon glyph="/icons/storyboard.png" hue="var(--color-tool-storyboard)" size={24} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1 space-y-2">
        {m.pending ? (
          <p className="flex items-center gap-2 text-[13px] text-fog">
            <span className="motion-dots shrink-0" aria-hidden>
              <i />
              <i />
              <i />
            </span>
            {board.status === "planning"
              ? "Planning the shots and casting the film"
              : board.dev?.waiting === "treatment"
                ? "Writing the story"
                : board.dev?.waiting === "develop"
                  ? "Reading your brief"
                  : "Reading that"}
          </p>
        ) : m.text ? (
          <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-paper">{mention(m.text)}</p>
        ) : null}
        {m.asks?.length ? <Asks board={board} asks={m.asks} /> : null}
        {m.treatment ? <StoryCard t={m.treatment} /> : null}
        {events.length ? (
          <div className="space-y-1">
            {events.length > shown.length ? (
              <button type="button" onClick={() => setAll(true)} className="text-[11.5px] font-semibold text-haze hover:text-paper">
                Show all {events.length} steps
              </button>
            ) : null}
            {shown.map((e) => {
              const Icon = EVENT_ICON[e.kind] ?? Sparkles;
              const shot = e.shot ? board.shots[e.shot - 1] : undefined;
              return (
                <p key={e.id} className={cn("flex items-start gap-2 text-[12px] leading-snug", e.kind === "error" ? "text-tally" : "text-fog")}>
                  <Icon size={12} className="mt-[3px] shrink-0 opacity-70" />
                  {e.shot ? (
                    <button
                      type="button"
                      onClick={() => shot && onSelect(shot.id)}
                      className="tabular mt-px shrink-0 rounded-[5px] bg-white/[0.07] px-1 font-mono text-[10.5px] text-paper hover:bg-white/[0.14]"
                      title={shot ? `Open shot ${e.shot}` : undefined}
                    >
                      {e.shot}
                    </button>
                  ) : null}
                  <span className="min-w-0">{e.text}</span>
                </p>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** The director's questions, answerable here too: a tap picks an option (the stage shows them big). */
function Asks({ board, asks }: { board: Storyboard; asks: Ask[] }) {
  const { answer } = useStoryboards();
  const locked = Boolean(board.dev?.waiting) || board.status !== "developing";
  return (
    <div className="space-y-2.5">
      {asks.map((ask) => (
        <div key={ask.id}>
          <p className="text-[11.5px] font-semibold text-haze">{ask.question}</p>
          <div className={cn("mt-1 flex flex-wrap gap-1.5", ask.kind === "pictures" && "grid grid-cols-3")}>
            {ask.options.map((o) => {
              const picked = ask.answer === o.id;
              const can = !ask.answer && !locked;
              return ask.kind === "pictures" ? (
                <button
                  key={o.id}
                  type="button"
                  disabled={!can}
                  onClick={() => void answer(board.id, ask.id, o.id)}
                  title={o.detail}
                  className={cn("press overflow-hidden rounded-[9px] bg-apple text-left", picked ? "shadow-[0_0_0_2px_var(--color-tool-storyboard)]" : "shadow-[0_0_0_1px_var(--color-line-strong)]", ask.answer && !picked && "opacity-40")}
                >
                  <span className="relative block aspect-video">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {o.image ? <img src={previewUrl(o.image, 320)} alt="" className="absolute inset-0 size-full object-cover" /> : <span className="skeleton absolute inset-0" />}
                  </span>
                  <span className="block truncate px-1.5 py-1 text-[10.5px] font-semibold">{o.label}</span>
                </button>
              ) : (
                <button
                  key={o.id}
                  type="button"
                  disabled={!can}
                  onClick={() => void answer(board.id, ask.id, o.id)}
                  title={o.detail}
                  className={cn(
                    "press inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-[12px] font-semibold",
                    picked ? "bg-tool-storyboard text-[#16131b]" : "bg-white/[0.06] text-fog hover:bg-white/[0.1] hover:text-paper disabled:hover:bg-white/[0.06]",
                    ask.answer && !picked && "opacity-40",
                  )}
                >
                  {picked ? <Check size={11} strokeWidth={3} /> : null}
                  {o.label}
                </button>
              );
            })}
          </div>
          {ask.answer === "note" ? <p className="mt-1 text-[11px] text-haze">Answered in your own words</p> : null}
        </div>
      ))}
    </div>
  );
}

/** The story the director pitched, folded to its title and logline. */
function StoryCard({ t }: { t: Treatment }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-[12px] bg-white/[0.03] p-3 shadow-[inset_0_0_0_1px_var(--color-line)]">
      <p className="text-[13px] font-semibold text-paper">{t.title}</p>
      <p className="mt-0.5 text-[12px] leading-snug text-fog">{t.logline}</p>
      {open ? (
        <ol className="mt-2 space-y-1">
          {t.beats.map((b, i) => (
            <li key={i} className="text-[11.5px] leading-snug text-fog">
              <span className="font-semibold text-paper">{i + 1}. {b.title}.</span> {b.what}
            </li>
          ))}
          {t.ending ? <li className="text-[11.5px] leading-snug text-tool-storyboard">{t.ending}</li> : null}
        </ol>
      ) : null}
      <button type="button" onClick={() => setOpen(!open)} className="mt-1.5 text-[11.5px] font-semibold text-haze hover:text-paper">
        {open ? "Fold the story" : "Read the story"}
      </button>
    </div>
  );
}

/** The cast, props and place every frame and clip is shown, as pictures. */
function KitStrip({ board }: { board: Storyboard }) {
  const kit = board.kit ?? [];
  if (!kit.length) return null;
  return (
    <section className="border-b border-line px-3.5 pb-3 pt-3">
      <p className="label mb-2">Cast &amp; props</p>
      <div className="scroll-thin flex gap-2 overflow-x-auto pb-1">
        {kit.map((k) => (
          <figure key={k.id} className="w-[68px] shrink-0" title={k.from ? `${k.name}, as on screen` : (k.look ?? k.name)}>
            <div className="relative overflow-hidden rounded-[9px] bg-apple shadow-[0_0_0_1px_var(--color-line-strong)]" style={{ aspectRatio: k.kind === "place" ? "16 / 10" : k.kind === "prop" ? "1 / 1" : "2 / 3" }}>
              {k.image ? (
                <>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={previewUrl(k.image, 160)} alt="" className="absolute inset-0 size-full object-cover" />
                  {/* Being pictured again, as they look on screen. */}
                  {(k.job || k.draft) && (
                    <span className="absolute right-1 top-1 grid size-4 place-items-center rounded-full bg-black/55">
                      <LoaderCircle size={10} className="animate-spin text-white" />
                    </span>
                  )}
                </>
              ) : k.job ? (
                <GeneratingField bare />
              ) : (
                <span className="absolute inset-0 grid place-items-center text-haze">
                  <TriangleAlert size={12} />
                </span>
              )}
            </div>
            <figcaption className="mt-1 truncate text-[10.5px] text-fog">{k.name.replace(/^@/, "")}</figcaption>
          </figure>
        ))}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ inspector */

function Inspector({ board, s, onClose }: { board: Storyboard; s: Shot; onClose: () => void }) {
  const { retake, redraw, pickTake, update } = useStoryboards();
  const i = board.shots.findIndex((x) => x.id === s.id);
  const state = shotState(board, s, i);
  const [editing, setEditing] = useState(false);
  const [asking, setAsking] = useState<"retake" | "redraw" | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(true);
  const v3 = board.version === 3;
  const run = (p: Promise<unknown>) => p.catch((err: Error) => setError(err.message));

  return (
    <section className="border-b border-line">
      <header className="flex items-center gap-2 px-3.5 pb-2 pt-3">
        <button type="button" onClick={() => setOpen(!open)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <span className="tabular grid size-6 shrink-0 place-items-center rounded-full bg-white/[0.08] font-mono text-[11px] font-bold">{i + 1}</span>
          <span className="min-w-0">
            <span className="block truncate text-[14px] font-semibold leading-tight">{s.title}</span>
            <span className={cn("flex items-center gap-1 text-[11.5px]", TONE[state.tone])}>
              {state.busy ? <LoaderCircle size={10} className="animate-spin" /> : null}
              {state.label}
              {i > 0 && s.transition === "continuous" ? (
                <span className="ml-1 inline-flex items-center gap-0.5 text-haze">
                  <Link2 size={10} /> continues the take
                </span>
              ) : null}
            </span>
          </span>
          <ChevronDown size={14} className={cn("ml-auto shrink-0 text-haze transition-transform", !open && "-rotate-90")} />
        </button>
        <button type="button" onClick={onClose} className="grid size-7 shrink-0 place-items-center rounded-full text-haze hover:bg-white/[0.06] hover:text-paper" aria-label="Close shot">
          <X size={14} />
        </button>
      </header>

      {open ? (
        <div className="scroll-thin max-h-[46vh] space-y-3 overflow-y-auto px-3.5 pb-3.5">
          {/* The first frame and the takes */}
          <div className="flex gap-2 overflow-x-auto pb-1">
            <Thumb label={s.frameFrom === "continuous" ? "Start · same take" : s.frameFrom === "bridge" ? "Start · new camera" : "Start"} src={s.frame} aspect={board.aspect} />
            {(s.takes ?? []).map((take, n) => (
              <Thumb
                key={take.clip}
                label={`Take ${n + 1}`}
                video={take.clip}
                aspect={board.aspect}
                current={take.clip === s.clip}
                bad={take.review?.status === "retake"}
                onUse={v3 && take.clip !== s.clip ? () => void run(pickTake(board.id, s.id, n)) : undefined}
              />
            ))}
          </div>

          {s.review?.summary || s.review?.out !== undefined ? (
            <p className="text-[12px] leading-relaxed text-fog">
              <Scissors size={11} className="mr-1 inline -translate-y-px text-haze" />
              {s.review?.out !== undefined ? `Cut ${(s.review.in ?? 0).toFixed(1)}–${s.review.out.toFixed(1)} s. ` : ""}
              {s.review?.summary}
              {s.review?.status === "flagged" && s.review.issues?.length ? <span className="block text-tungsten">Still: {s.review.issues.join("; ")}</span> : null}
            </p>
          ) : null}
          {s.check?.issues?.length ? (
            <p className="text-[12px] leading-relaxed text-fog">
              <Wrench size={11} className="mr-1 inline -translate-y-px text-haze" />
              {s.check.status === "flagged" ? "Frame still has: " : "Frame fixed: "}
              {s.check.issues.join("; ")}
            </p>
          ) : null}
          {s.error ? (
            <p className="flex items-start gap-1.5 text-[12px] text-tally">
              <TriangleAlert size={12} className="mt-0.5 shrink-0" /> {s.error}
            </p>
          ) : null}

          {editing ? (
            <ShotForm
              s={s}
              onCancel={() => setEditing(false)}
              onSave={(patch) => {
                setEditing(false);
                void run(update(board.id, { shot: { id: s.id, ...patch } }));
              }}
            />
          ) : (
            <dl className="space-y-1.5 text-[12.5px] leading-relaxed">
              <Row k="Camera">
                {s.framing} · {s.camera}
              </Row>
              {s.layout ? <Row k="First frame">{mention(s.layout)}</Row> : null}
              <Row k="Action">{mention(s.action)}</Row>
              {s.end ? <Row k="Ends on">{mention(s.end)}</Row> : null}
              {s.note ? <Row k="Asked for">{s.note}</Row> : null}
            </dl>
          )}

          {asking ? (
            <form
              className="flex gap-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                void run((asking === "retake" ? retake : redraw)(board.id, s.id, note.trim() || undefined));
                setAsking(null);
                setNote("");
              }}
            >
              <input
                autoFocus
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={asking === "retake" ? "What should the new take do differently? (optional)" : "What should the frame show? (optional)"}
                className="h-8 min-w-0 flex-1 rounded-[10px] bg-white/[0.05] px-2.5 text-[12.5px] outline-none placeholder:text-haze focus:bg-white/[0.08]"
              />
              <Button size="sm" variant="paper" type="submit">
                Go
              </Button>
              <Button size="sm" variant="ghost" type="button" onClick={() => setAsking(null)}>
                Cancel
              </Button>
            </form>
          ) : v3 && !editing ? (
            <div className="flex flex-wrap gap-1.5">
              <Mini onClick={() => setAsking("retake")} disabled={!s.frame || state.busy}>
                <RefreshCw size={12} /> Retake
              </Mini>
              <Mini onClick={() => setAsking("redraw")} disabled={state.busy}>
                <ImageIcon size={12} /> Redraw frame
              </Mini>
              <Mini onClick={() => setEditing(true)}>
                <Pencil size={12} /> Edit plan
              </Mini>
            </div>
          ) : null}
          {v3 && i < board.shots.length - 1 && (s.clip || s.frame) ? <p className="text-[11px] text-haze">Changing this shot redoes the shots after it: each one starts from the frame this one is cut on.</p> : null}
          {error ? <p className="text-[12px] text-tally">{error}</p> : null}
        </div>
      ) : null}
    </section>
  );
}

function Row({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[78px_1fr] gap-2">
      <dt className="text-haze">{k}</dt>
      <dd className="text-fog">{children}</dd>
    </div>
  );
}

function Thumb({ label, src, video, aspect, current, bad, onUse }: { label: string; src?: string; video?: string; aspect: string; current?: boolean; bad?: boolean; onUse?: () => void }) {
  const ref = useRef<HTMLVideoElement>(null);
  return (
    <figure className="w-[132px] shrink-0">
      <div
        className={cn("relative overflow-hidden rounded-[9px] bg-apple", current ? "shadow-[0_0_0_2px_var(--color-tool-storyboard)]" : "shadow-[0_0_0_1px_var(--color-line-strong)]")}
        style={{ aspectRatio: aspect.replace(":", " / ") }}
        onMouseEnter={() => void ref.current?.play().catch(() => {})}
        onMouseLeave={() => ref.current?.pause()}
      >
        {video ? (
          <video ref={ref} src={previewUrl(video, 320)} poster={previewUrl(video, 320, "poster")} muted loop playsInline preload="none" className="absolute inset-0 size-full object-cover" />
        ) : src ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={previewUrl(src, 320)} alt="" className="absolute inset-0 size-full object-cover" />
        ) : (
          <span className="skeleton absolute inset-0" />
        )}
        {bad ? <TriangleAlert size={12} className="absolute right-1 top-1 text-tungsten drop-shadow" /> : null}
        {current ? <Check size={12} strokeWidth={3} className="absolute right-1 top-1 text-tool-storyboard drop-shadow" /> : null}
      </div>
      <figcaption className="mt-1 flex items-center justify-between gap-1 text-[10.5px] text-haze">
        <span className="truncate">{label}</span>
        {onUse ? (
          <button type="button" onClick={onUse} className="shrink-0 font-semibold text-fog hover:text-paper">
            Use
          </button>
        ) : null}
      </figcaption>
    </figure>
  );
}

function Mini({ onClick, disabled, children }: { onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="press inline-flex h-7 items-center gap-1.5 rounded-[9px] bg-white/[0.05] px-2.5 text-[12px] font-semibold text-fog hover:bg-white/[0.1] hover:text-paper disabled:opacity-35"
    >
      {children}
    </button>
  );
}

function ShotForm({ s, onSave, onCancel }: { s: Shot; onSave: (patch: Partial<Shot>) => void; onCancel: () => void }) {
  const [draft, setDraft] = useState({ camera: s.camera, layout: s.layout ?? "", action: s.action, end: s.end ?? "", duration: s.duration, transition: s.transition ?? "cut" });
  const field = "w-full resize-none rounded-[10px] bg-white/[0.05] px-2.5 py-2 text-[12.5px] leading-relaxed text-paper outline-none placeholder:text-haze focus:bg-white/[0.08]";
  const set = (k: keyof typeof draft) => (e: { target: { value: string } }) => setDraft({ ...draft, [k]: k === "duration" ? Number(e.target.value) : e.target.value });
  return (
    <div className="space-y-1.5">
      <input value={draft.camera} onChange={set("camera")} placeholder="Where the camera is, and its one move" className={cn(field, "h-9 py-0")} />
      <textarea value={draft.layout} onChange={set("layout")} rows={2} placeholder="The first frame: foreground, middle, background" className={field} />
      <textarea value={draft.action} onChange={set("action")} rows={3} placeholder="What happens, at real-time speed" className={field} />
      <textarea value={draft.end} onChange={set("end")} rows={2} placeholder="The held moment it ends on" className={field} />
      <div className="flex gap-1.5">
        <select value={draft.transition} onChange={set("transition")} className={cn(field, "h-9 py-0")} aria-label="Transition">
          <option value="cut" className="bg-apple">
            Cut to a new camera
          </option>
          <option value="continuous" className="bg-apple">
            Same take keeps rolling
          </option>
        </select>
        <select value={draft.duration} onChange={set("duration")} className={cn(field, "tabular h-9 w-24 py-0")} aria-label="Seconds">
          {[2, 3, 4, 5, 6, 7, 8, 10, 12].map((d) => (
            <option key={d} value={d} className="bg-apple">
              {d} s
            </option>
          ))}
        </select>
      </div>
      <div className="flex justify-end gap-1.5 pt-0.5">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" variant="paper" onClick={() => onSave({ ...draft, transition: draft.transition as Shot["transition"] })}>
          Save and redo
        </Button>
      </div>
    </div>
  );
}
