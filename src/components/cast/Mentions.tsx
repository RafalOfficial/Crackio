"use client";

import { useEffect, useState, type KeyboardEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { AtSign, LoaderCircle, Plus } from "lucide-react";
import { useCast } from "@/lib/hooks/use-cast";
import { floatingHost } from "@/components/ui/Popover";
import type { Character } from "@/lib/cast/types";
import { cn } from "@/lib/cn";

const WIDTH = 288;
const COPIED = ["boxSizing", "width", "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "fontStyle", "fontVariant", "fontWeight", "fontSize", "lineHeight", "fontFamily", "letterSpacing", "wordSpacing", "textIndent", "textTransform", "tabSize"] as const;

/** Where the caret is on screen: a hidden copy of the textarea, measured up to the caret. */
function caretPoint(el: HTMLTextAreaElement, index: number) {
  const style = getComputedStyle(el);
  const mirror = document.createElement("div");
  for (const p of COPIED) mirror.style[p] = style[p];
  Object.assign(mirror.style, { position: "absolute", visibility: "hidden", whiteSpace: "pre-wrap", overflowWrap: "break-word", top: "0", left: "-9999px" });
  mirror.textContent = el.value.slice(0, index);
  const marker = document.createElement("span");
  marker.textContent = "​";
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  const box = el.getBoundingClientRect();
  const line = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.4;
  const point = { x: box.left + marker.offsetLeft - el.scrollLeft, y: box.top + marker.offsetTop - el.scrollTop, line };
  mirror.remove();
  return point;
}

type Query = { start: number; text: string };

/** A picture attached to the prompt that "@" can name ("@start", "@ref1"), with its tag and thumbnail. */
export type MentionPicture = { token: string; label: string; src: string };

type Option = { kind: "picture"; picture: MentionPicture } | { kind: "cast"; c: Character };

/**
 * "@" in a prompt box: suggests the pictures attached to it (`pictures`: a clip's start and end frames, references) and
 * your Cast characters, and inserts "@word". Wire it with `onKeyDown` (it handles the arrows, Enter and Escape while open)
 * and render `menu`.
 */
export function useMentions({
  textarea,
  value,
  onChange,
  pictures = [],
}: {
  textarea: RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange: (next: string) => void;
  pictures?: MentionPicture[];
}) {
  const { items } = useCast();
  const [query, setQuery] = useState<Query | null>(null);
  const [active, setActive] = useState(0);
  const [point, setPoint] = useState<{ x: number; y: number; line: number } | null>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);

  // Watch the caret: typing, clicking and arrowing all move it. Checks wait a frame: state set
  // while the browser's input event is still on its way to React would re-render the textarea
  // with the old text and swallow the keystroke.
  useEffect(() => {
    const el = textarea.current;
    if (!el) return;
    let frame = 0;
    const measure = () => {
      const caret = el.selectionStart ?? 0;
      if (caret !== el.selectionEnd) return setQuery(null);
      const m = el.value.slice(0, caret).match(/(^|[^\w@])@([a-z0-9_]{0,24})$/i);
      if (!m) return setQuery(null);
      const start = caret - m[2].length - 1;
      setQuery((q) => (q && q.start === start && q.text === m[2].toLowerCase() ? q : { start, text: m[2].toLowerCase() }));
      setPoint(caretPoint(el, start));
      setHost(floatingHost(el));
    };
    const check = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    const close = () => setTimeout(() => setQuery(null), 120);
    el.addEventListener("input", check);
    el.addEventListener("click", check);
    el.addEventListener("keyup", check);
    el.addEventListener("blur", close);
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener("input", check);
      el.removeEventListener("click", check);
      el.removeEventListener("keyup", check);
      el.removeEventListener("blur", close);
    };
  }, [textarea]);

  const matches: Option[] = query
    ? [
        ...pictures
          .filter((p) => !query.text || p.token.startsWith(query.text) || p.label.toLowerCase().includes(query.text))
          .map((picture) => ({ kind: "picture" as const, picture })),
        ...items
          .filter((c) => !query.text || c.handle.startsWith(query.text) || c.name.toLowerCase().includes(query.text))
          .slice(0, 6)
          .map((c) => ({ kind: "cast" as const, c })),
      ]
    : [];
  const open = Boolean(query && point);
  const current = Math.min(active, Math.max(0, matches.length - 1));

  const pick = (o: Option) => {
    const el = textarea.current;
    if (!el || !query) return;
    const caret = el.selectionStart ?? value.length;
    const insert = `@${o.kind === "picture" ? o.picture.token : o.c.handle} `;
    const next = value.slice(0, query.start) + insert + value.slice(caret).replace(/^\s+/, "");
    onChange(next);
    setQuery(null);
    requestAnimationFrame(() => {
      el.focus();
      const at = query.start + insert.length;
      el.setSelectionRange(at, at);
    });
  };

  /** True when the key belonged to the menu (the caller should skip its own handling). */
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!open) return false;
    if (e.key === "Escape") {
      e.preventDefault();
      setQuery(null);
      return true;
    }
    if (!matches.length) return false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive((current + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length);
      return true;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      pick(matches[current]);
      return true;
    }
    return false;
  };

  const menu =
    open && point && typeof document !== "undefined"
      ? createPortal(
          <MentionMenu
            options={matches}
            hasAny={items.length > 0}
            active={current}
            onHover={setActive}
            onPick={pick}
            style={(() => {
              const left = Math.max(12, Math.min(point.x - 14, window.innerWidth - WIDTH - 12));
              const below = point.y + point.line + 6;
              const height = 64 + Math.max(1, matches.length) * 48 + (matches.some((o) => o.kind === "picture") ? 28 : 0);
              // Below the caret when it fits, else on the roomier side, scrolling past that.
              const room = { below: window.innerHeight - below - 12, above: point.y - 18 };
              return below + height > window.innerHeight - 12 && room.above > room.below
                ? { left, bottom: window.innerHeight - point.y + 6, maxHeight: room.above }
                : { left, top: below, maxHeight: room.below };
            })()}
          />,
          host ?? document.body,
        )
      : null;

  return { onKeyDown, menu };
}

function MentionMenu({
  options,
  hasAny,
  active,
  onHover,
  onPick,
  style,
}: {
  options: Option[];
  hasAny: boolean;
  active: number;
  onHover: (i: number) => void;
  onPick: (o: Option) => void;
  style: React.CSSProperties;
}) {
  const anyCast = options.some((o) => o.kind === "cast");
  const row = (o: Option, i: number) => (
    <button
      key={o.kind === "picture" ? `p:${o.picture.token}` : o.c.id}
      type="button"
      role="option"
      aria-selected={i === active}
      // Arrowing through a list taller than its room keeps the chosen one in view.
      ref={i === active ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}
      onMouseEnter={() => onHover(i)}
      onClick={() => onPick(o)}
      className={cn("squircle flex w-full items-center gap-2.5 rounded-[12px] px-2 py-1.5 text-left", i === active ? "bg-gaffer text-paper" : "text-fog")}
    >
      <span className="relative size-8 shrink-0 overflow-hidden rounded-[9px] bg-apple">
        {o.kind === "picture" ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={o.picture.src} alt="" className="size-full object-cover" />
        ) : o.c.portrait || o.c.photos[0] ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={o.c.portrait ?? o.c.photos[0]} alt="" className="size-full object-cover" />
        ) : null}
        {o.kind === "cast" && o.c.status === "building" ? <LoaderCircle size={14} className="absolute inset-0 m-auto animate-spin text-paper" /> : null}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-semibold text-paper">{o.kind === "picture" ? o.picture.label : o.c.name}</span>
        <span className="block truncate font-mono text-[11px] text-haze">@{o.kind === "picture" ? o.picture.token : o.c.handle}</span>
      </span>
      {o.kind === "cast" && o.c.status === "building" ? <span className="text-[11px] text-haze">Building</span> : null}
    </button>
  );
  return (
    <div
      role="listbox"
      aria-label="Mention"
      // Part of the box it opened from: a popover around that box stays open while you pick.
      data-floating=""
      style={{ ...style, width: WIDTH }}
      // Keep focus in the textarea while picking.
      onMouseDown={(e) => e.preventDefault()}
      className="squircle scroll-thin fixed z-[80] overflow-y-auto overscroll-contain rounded-[18px] bg-apple-2 p-1.5 shadow-[0_0_0_1px_var(--color-line-strong),0_18px_40px_-8px_rgb(0_0_0/0.6)]"
    >
      {options.some((o) => o.kind === "picture") ? (
        <>
          <p className="flex items-center gap-1.5 px-2 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-haze">
            <AtSign size={11} /> Your pictures
          </p>
          {options.map((o, i) => (o.kind === "picture" ? row(o, i) : null))}
        </>
      ) : null}
      <p className="flex items-center gap-1.5 px-2 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-haze">
        <AtSign size={11} /> Cast
      </p>
      {anyCast ? (
        options.map((o, i) => (o.kind === "cast" ? row(o, i) : null))
      ) : (
        <p className="px-2 py-2 text-[12.5px] text-fog">{hasAny ? "No one by that name." : "No characters yet. Make one from a few photos and call them by name anywhere."}</p>
      )}
      <Link href="/cast" className="mt-1 flex items-center gap-1.5 rounded-[12px] px-2 py-1.5 text-[12px] font-semibold text-fog hover:bg-gaffer/60 hover:text-paper">
        <Plus size={13} /> {hasAny ? "Manage your cast" : "Create a character"}
      </Link>
    </div>
  );
}
