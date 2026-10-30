"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ArrowUp, Check, Clock3, LoaderCircle, RefreshCw } from "lucide-react";
import { Popover, MenuItem } from "@/components/ui/Popover";
import { AspectGlyph } from "@/components/ui/AspectGlyph";
import { ModelPicker } from "@/components/models/ModelPicker";
import { ResolutionChip } from "@/components/models/ResolutionChip";
import { useMentions } from "@/components/cast/Mentions";
import { useStoryboards } from "@/lib/hooks/use-storyboards";
import { LENGTHS, LOOKS, SHAPES, lookById, lookPreview, type LookId, type Storyboard } from "@/lib/storyboard/types";
import type { AspectId } from "@/lib/shot";
import { cn } from "@/lib/cn";
import { useModelChoice } from "@/lib/hooks/use-model-choice";

const SHAPE_NAMES: Record<string, string> = { "16:9": "Widescreen", "21:9": "Cinema", "3:2": "Photo", "1:1": "Square", "2:3": "Portrait", "9:16": "Vertical" };

const chip = "press inline-flex h-8 items-center gap-1.5 rounded-full bg-white/[0.06] px-2.5 text-[12px] font-semibold text-fog hover:bg-white/[0.1] hover:text-paper";

/** One line of the bar's text (14 px at a relaxed line height). */
const LINE = 23;

/**
 * The one place you type. With no film open, it starts one (look, shape, length and models next
 * to it); inside a film, it talks to that film's director, so a follow-up is just the change.
 */
export function PromptBar({ board }: { board: Storyboard | null }) {
  const { create, send, remake } = useStoryboards();
  const [text, setText] = useState("");
  const [look, setLook] = useState<LookId>("cinematic");
  const [aspect, setAspect] = useState<AspectId>("16:9");
  const [target, setTarget] = useState(30);
  // Your last picks (hooks/use-model-choice); "auto" leaves the board on its own models until you choose.
  const [frameModel, setFrameModel] = useModelChoice("image");
  const [frameResolution, setFrameResolution] = useState<string | null>(null);
  const [clipModel, setClipModel] = useModelChoice("video");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const mentions = useMentions({ textarea: area, value: text, onChange: setText });
  const legacy = board && board.version !== 3;
  const fresh = !board;
  // In a film the bar rests as one quiet line and opens to two while you write.
  const [open, setOpen] = useState(false);
  const expanded = fresh || open || Boolean(text);

  // Ideas from the welcome screen land here.
  useEffect(() => {
    const onIdea = (e: Event) => {
      setText((e as CustomEvent<string>).detail);
      area.current?.focus();
    };
    window.addEventListener("storyboard:prompt", onIdea);
    return () => window.removeEventListener("storyboard:prompt", onIdea);
  }, []);

  useEffect(() => {
    const el = area.current;
    if (!el) return;
    if (!expanded) {
      el.style.height = `${LINE}px`;
      return;
    }
    // Measure the text, then glide from the current height to it.
    const from = el.style.height;
    el.style.transition = "none";
    el.style.height = "0px";
    const to = Math.min(Math.max(el.scrollHeight, fresh ? 72 : LINE * 2), 200);
    el.style.height = from;
    void el.offsetHeight;
    el.style.transition = "";
    el.style.height = `${to}px`;
  }, [text, fresh, expanded]);

  async function submit() {
    const words = text.trim();
    if (busy || !words || (fresh && words.length < 8)) return;
    setBusy(true);
    setError(null);
    try {
      if (fresh) {
        const models = { ...(frameModel !== "auto" ? { image: frameModel } : {}), ...(clipModel !== "auto" ? { video: clipModel } : {}), ...(frameResolution ? { resolution: frameResolution } : {}) };
        await create({ scene: words, look, aspect, target, models });
      } else await send(board.id, words);
      setText("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (legacy)
    return (
      <div className="smoked-glass squircle flex flex-wrap items-center gap-3 rounded-[20px] px-4 py-3">
        <p className="min-w-0 flex-1 text-[13px] leading-snug text-fog">This board was made with the old storyboard. Remake it and the director makes it shot by shot, each one picking up where the last one ended.</p>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void remake(board.id)
              .catch((err: Error) => setError(err.message))
              .finally(() => setBusy(false));
          }}
          className="press inline-flex h-9 items-center gap-1.5 rounded-full bg-spike px-4 text-[13px] font-bold text-spike-ink hover:bg-spike-hi disabled:opacity-50"
        >
          {busy ? <LoaderCircle size={14} className="animate-spin" /> : <RefreshCw size={14} />} Remake with the director
        </button>
        {error ? <p className="w-full text-[12px] text-tally">{error}</p> : null}
      </div>
    );

  const keys = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentions.onKeyDown(e)) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
    if (e.key === "Escape") e.currentTarget.blur();
  };
  const sendButton = (
    <button
      type="button"
      onClick={() => void submit()}
      disabled={busy || !text.trim() || (fresh && text.trim().length < 8)}
      className="press grid size-9 shrink-0 place-items-center rounded-full bg-spike text-spike-ink transition-colors hover:bg-spike-hi disabled:bg-white/[0.08] disabled:text-haze"
      aria-label={fresh ? "Make the film" : "Send to the director"}
    >
      {busy ? <LoaderCircle size={16} className="animate-spin" /> : <ArrowUp size={16} strokeWidth={2.6} />}
    </button>
  );

  // Inside a film: one line with the send button beside it; clicking in opens it to two.
  if (!fresh)
    return (
      <div>
        <div
          onClick={() => area.current?.focus()}
          className={cn("smoked-glass squircle flex cursor-text items-end gap-2 rounded-[22px] pl-4 pr-1.5 transition-[padding] duration-200", expanded ? "py-2.5" : "py-1.5")}
        >
          <textarea
            ref={area}
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onFocus={() => setOpen(true)}
            onBlur={() => setOpen(false)}
            onKeyDown={keys}
            placeholder={
              board.status === "developing"
                ? expanded
                  ? "Answer in your own words, or tell me what you have in mind: “make it a carnival at night”, “the detective is a woman”…"
                  : "Answer in your own words, or add an idea…"
                : expanded
                  ? "What should change? “Shot 3 is too slow”, “add a close-up of her smile”, “make the rain heavier”…"
                  : "Tell the director what to change…"
            }
            style={{ height: LINE }}
            className={cn(
              "mb-[6px] block min-w-0 flex-1 resize-none bg-transparent py-0 text-[14px] leading-relaxed text-paper outline-none transition-[height] duration-200 ease-[var(--ease-out-quint)] placeholder:text-haze",
              expanded ? "scroll-thin overflow-y-auto" : "overflow-hidden whitespace-nowrap",
            )}
          />
          {mentions.menu}
          {sendButton}
        </div>
        {error ? <p className="mt-2 px-2 text-[12px] text-tally">{error}</p> : null}
      </div>
    );

  return (
    <div>
      <div className="smoked-glass squircle rounded-[22px]">
        <textarea
          ref={area}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={keys}
          placeholder="Describe your film: who's in it, where, and what happens. @name brings in your cast."
          className="block w-full resize-none bg-transparent px-4 pb-1 pt-3.5 text-[14px] leading-relaxed text-paper outline-none placeholder:text-haze"
        />
        {mentions.menu}
        <div className="flex flex-wrap items-center gap-1.5 px-2.5 pb-2.5">
          <LookPicker value={look} onChange={setLook} />
          <Popover
            placement="top-start"
            trigger={({ open, toggle }) => (
              <button type="button" onClick={toggle} aria-expanded={open} className={chip}>
                <AspectGlyph id={aspect} max={12} /> {aspect}
              </button>
            )}
          >
            {(close) => (
              <div role="menu">
                {SHAPES.map((a) => (
                  <MenuItem
                    key={a}
                    selected={a === aspect}
                    hint={SHAPE_NAMES[a]}
                    onSelect={() => {
                      setAspect(a);
                      close();
                    }}
                  >
                    <AspectGlyph id={a} /> {a}
                  </MenuItem>
                ))}
              </div>
            )}
          </Popover>
          <Popover
            placement="top-start"
            trigger={({ open, toggle }) => (
              <button type="button" onClick={toggle} aria-expanded={open} className={chip}>
                <Clock3 size={12} /> {target} s
              </button>
            )}
          >
            {(close) => (
              <div role="menu">
                {LENGTHS.map((n) => (
                  <MenuItem
                    key={n}
                    selected={n === target}
                    hint={`about ${Math.round(n / 4.5)} shots`}
                    onSelect={() => {
                      setTarget(n);
                      close();
                    }}
                  >
                    {n} seconds
                  </MenuItem>
                ))}
              </div>
            )}
          </Popover>
          <ModelPicker kind="image" value={frameModel} onChange={setFrameModel} variant="chip" placement="top-start" />
          <ResolutionChip model={frameModel} value={frameResolution} onChange={setFrameResolution} placement="top-start" />
          <ModelPicker kind="video" value={clipModel} onChange={setClipModel} variant="chip" placement="top-start" />
          <span className="ml-auto">{sendButton}</span>
        </div>
      </div>
      {error ? <p className="mt-2 px-2 text-[12px] text-tally">{error}</p> : null}
    </div>
  );
}

function LookPicker({ value, onChange }: { value: LookId; onChange: (id: LookId) => void }) {
  const current = lookById(value);
  return (
    <Popover
      placement="top-start"
      panelClassName="w-[380px] p-2"
      trigger={({ open, toggle }) => (
        <button type="button" onClick={toggle} aria-expanded={open} className={cn(chip, "pl-1")}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={lookPreview(current.id)} alt="" className="size-6 rounded-full object-cover" />
          {current.label}
        </button>
      )}
    >
      {(close) => (
        <div className="grid grid-cols-3 gap-1.5" role="menu">
          {LOOKS.map((l) => (
            <button
              key={l.id}
              type="button"
              role="menuitemradio"
              aria-checked={l.id === value}
              title={l.caption}
              onClick={() => {
                onChange(l.id);
                close();
              }}
              className={cn("press relative overflow-hidden rounded-[11px] text-left", l.id === value ? "ring-2 ring-paper" : "ring-1 ring-white/[0.08] hover:ring-white/25")}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={lookPreview(l.id)} alt="" loading="lazy" className="aspect-[3/2] w-full object-cover" />
              <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 to-transparent px-1.5 pb-1 pt-4 text-[11px] font-semibold leading-tight text-paper">{l.label}</span>
              {l.id === value ? (
                <span className="absolute right-1 top-1 grid size-4 place-items-center rounded-full bg-paper text-[#16131b]">
                  <Check size={10} strokeWidth={3.2} />
                </span>
              ) : null}
            </button>
          ))}
        </div>
      )}
    </Popover>
  );
}
