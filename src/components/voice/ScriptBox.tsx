"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { POINT_TAGS, SPAN_TAGS, type PointTag, type SpanTag } from "@/lib/voice/script";
import { cn } from "@/lib/cn";

/**
 * The script, written the way Drama 3 reads it ([laughs], <whisper>…</whisper>) but shown with chips: sounds sit where
 * they happen as small pills, words said a certain way are underlined. The text stays yours to type; the chips come in
 * from the Add menu (`insertTag`, `wrapSpan`) at the caret.
 */

export type ScriptEditor = { insertTag: (tag: PointTag) => void; wrapSpan: (tag: SpanTag) => void; focus: () => void };

const LABEL: Record<string, string> = Object.fromEntries([...POINT_TAGS.map((t) => [t.tag, t.label.toLowerCase()]), ...SPAN_TAGS.map((t) => [t.tag, t.label.toLowerCase()])]);
const TOKEN = /\[(laughs|chuckles|sighs|gasps|breath|pause)\]|<(whisper|slow|emphasis)>([\s\S]*?)<\/\2>/gi;

function pill(tag: string) {
  const s = document.createElement("span");
  s.className = "voice-tag";
  s.contentEditable = "false";
  s.dataset.tag = tag;
  s.textContent = LABEL[tag] ?? tag;
  return s;
}

function spanOf(tag: string, text: string) {
  const s = document.createElement("span");
  s.className = "voice-span";
  s.dataset.span = tag;
  s.title = LABEL[tag] ?? tag;
  s.textContent = text;
  return s;
}

/** The script as editor content. */
function render(el: HTMLElement, value: string) {
  el.replaceChildren();
  let at = 0;
  for (const m of value.matchAll(TOKEN)) {
    if (m.index! > at) el.append(document.createTextNode(value.slice(at, m.index)));
    if (m[1]) el.append(pill(m[1].toLowerCase()));
    else el.append(spanOf(m[2].toLowerCase(), m[3]));
    at = m.index! + m[0].length;
  }
  if (at < value.length) el.append(document.createTextNode(value.slice(at)));
}

/** The editor content as the script. */
function read(el: Node): string {
  let out = "";
  el.childNodes.forEach((n) => {
    if (n.nodeType === Node.TEXT_NODE) out += n.textContent ?? "";
    else if (n instanceof HTMLElement) {
      if (n.dataset.tag) out += `[${n.dataset.tag}]`;
      else if (n.dataset.span) {
        const inner = read(n);
        if (inner.trim()) out += `<${n.dataset.span}>${inner}</${n.dataset.span}>`;
      } else if (n.tagName === "BR") out += "\n";
      else if (n.tagName === "DIV" || n.tagName === "P") out += (out && !out.endsWith("\n") ? "\n" : "") + read(n);
      else out += read(n);
    }
  });
  return out;
}

/** A script as it looks in the editor, chips and all, for examples (the rotating placeholder). */
export function ScriptPreview({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const m of text.matchAll(TOKEN)) {
    if (m.index! > at) parts.push(text.slice(at, m.index));
    parts.push(
      m[1] ? (
        <span key={m.index} className="voice-tag">
          {LABEL[m[1].toLowerCase()] ?? m[1]}
        </span>
      ) : (
        <span key={m.index} className="voice-span" data-span={m[2].toLowerCase()}>
          {m[3]}
        </span>
      ),
    );
    at = m.index! + m[0].length;
  }
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}

export function ScriptBox({
  value,
  onChange,
  onReady,
  onSubmit,
  onEnter,
  placeholder,
  autoFocus,
  className,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  /** Its controls, when it gets focus (the Add menu writes into the one you were in). */
  onReady?: (api: ScriptEditor) => void;
  /** Enter (and Ctrl+Enter anywhere): speak. Shift+Enter starts a new line. */
  onSubmit?: () => void;
  /** What Enter does instead of speaking (a conversation's line: the next line). */
  onEnter?: () => void;
  placeholder?: ReactNode;
  autoFocus?: boolean;
  className?: string;
  label: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const last = useRef<string | null>(null);
  const range = useRef<Range | null>(null);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  // Only words that didn't come from typing here (a reset, a line loaded back) redraw the editor.
  useEffect(() => {
    const el = ref.current;
    if (!el || value === last.current) return;
    render(el, value);
    last.current = value;
  }, [value]);

  const changed = useRef(onChange);
  const ready = useRef(onReady);
  useLayoutEffect(() => {
    changed.current = onChange;
    ready.current = onReady;
  });

  // One set of controls for its whole life, so the Add menu can hold on to it.
  const api = useMemo(() => {
    const emit = () => {
      const el = ref.current;
      if (!el) return;
      const v = read(el);
      last.current = v;
      changed.current(v);
    };
    const remember = () => {
      const s = window.getSelection();
      if (s?.rangeCount && ref.current?.contains(s.getRangeAt(0).commonAncestorContainer)) range.current = s.getRangeAt(0).cloneRange();
    };
    const place = (r: Range) => {
      const s = window.getSelection();
      s?.removeAllRanges();
      s?.addRange(r);
      range.current = r.cloneRange();
    };
    const caret = () => {
      const el = ref.current!;
      if (range.current && el.contains(range.current.commonAncestorContainer)) return range.current;
      const r = document.createRange();
      r.selectNodeContents(el);
      r.collapse(false);
      return r;
    };
    const editor: ScriptEditor = {
      focus: () => ref.current?.focus(),
      insertTag: (tag) => {
        const el = ref.current;
        if (!el) return;
        const r = caret();
        r.collapse(false);
        const p = pill(tag);
        const space = document.createTextNode(" ");
        r.insertNode(space);
        r.insertNode(p);
        const after = document.createRange();
        after.setStartAfter(space);
        after.collapse(true);
        place(after);
        emit();
      },
      wrapSpan: (tag) => {
        const el = ref.current;
        if (!el) return;
        const r = caret();
        let span: HTMLElement;
        if (!r.collapsed && el.contains(r.commonAncestorContainer)) {
          span = spanOf(tag, r.toString());
          r.deleteContents();
          r.insertNode(span);
        } else {
          span = spanOf(tag, "these words");
          r.insertNode(span);
        }
        const sel = document.createRange();
        sel.selectNodeContents(span);
        place(sel);
        emit();
      },
    };
    return { editor, emit, remember };
  }, []);

  // The Add menu writes into this one from the start, before it's ever clicked.
  useEffect(() => {
    ready.current?.(api.editor);
  }, [api]);

  return (
    <div className={cn("relative", className)}>
      {!value.trim() && placeholder ? (
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 select-none overflow-hidden text-haze [padding:inherit]">
          {placeholder}
        </div>
      ) : null}
      <div
        ref={ref}
        role="textbox"
        aria-multiline="true"
        aria-label={label}
        contentEditable
        suppressContentEditableWarning
        spellCheck={false}
        className="relative min-h-[1.75em] whitespace-pre-wrap break-words outline-none [overflow-wrap:anywhere]"
        onInput={api.emit}
        onKeyUp={api.remember}
        onMouseUp={api.remember}
        onBlur={api.remember}
        onFocus={() => ready.current?.(api.editor)}
        onPaste={(e) => {
          e.preventDefault();
          document.execCommand("insertText", false, e.clipboardData.getData("text/plain"));
        }}
        onKeyDown={(e) => {
          if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
          e.preventDefault();
          if (e.metaKey || e.ctrlKey) onSubmit?.();
          else if (e.shiftKey) document.execCommand("insertLineBreak");
          else if (onEnter) onEnter();
          else onSubmit?.();
        }}
      />
    </div>
  );
}
