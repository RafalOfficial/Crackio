"use client";

import type { CSSProperties, ReactNode } from "react";
import { VendorMark } from "@/components/brand/BrandMark";

/**
 * A text model's card in the model library: what it's like to work with, typed out, in place of a picture. Every sample
 * is Crackio's own (its own words, and for the model that reads pictures, Crackio's own product shot), so nothing on the
 * card is anyone else's work. It types itself out once when it's drawn and again each time the card is pointed at.
 */
type Sample =
  | { kind: "plan"; ask: string; lines: [string, string][] }
  | { kind: "code"; ask: string; lines: string[] }
  | { kind: "script"; ask: string; lines: [string, string][] }
  | { kind: "vision"; ask: string; image: string; box: { x: number; y: number; w: number; h: number; label: string }; answer: string }
  | { kind: "rewrite"; ask: string; answer: string };

const SAMPLES: Record<string, Sample> = {
  // The strongest planner: a shot list for a whole film.
  "comfy:anthropic/claude-opus-5": {
    kind: "plan",
    ask: "A 15 s launch film for Quill",
    lines: [
      ["0.0", "Ink drop blooms into the Q"],
      ["2.5", "The note writes itself"],
      ["7.0", "Three cards fan out"],
      ["11.5", "Quill. Write it down."],
    ],
  },
  // The steadiest hand with Motion's code.
  "comfy:anthropic/claude-sonnet-5": {
    kind: "code",
    ask: "Animate the title, then cut",
    lines: ['tl.from(".title", { y: 48 })', '  .to(".nib", { rotate: -12 })', '  .add(cut("shot-2.mp4"), 2.4)', 'render({ fps: 30 })'],
  },
  // Words only: a script.
  "comfy:deepseek/deepseek-v4-pro": {
    kind: "script",
    ask: "10 s voiceover, coffee ad",
    lines: [
      ["VO", "First light. First cup."],
      ["VO", "Roasted Tuesday, poured today."],
      ["SUPER", "Small batch. Big morning."],
    ],
  },
  // Reads pictures well: what it sees in one of Crackio's own shots.
  "comfy:google/gemini-3.5-flash": {
    kind: "vision",
    ask: "What's in this photo?",
    image: "/assets/showcase/try/product.webp",
    box: { x: 31, y: 18, w: 40, h: 70, label: "bottle" },
    answer: "Frosted perfume bottle, gold cap, soft light from the left.",
  },
  // The open model on your GPU: your words, as a prompt.
  "local:text": { kind: "rewrite", ask: "cat on sofa, cozy", answer: "A ginger cat curled on a linen sofa, warm window light, shallow depth of field." },
};

const fallback = (name: string): Sample => ({ kind: "rewrite", ask: "neon street, rain", answer: `A rain-soaked street under pink and teal neon, reflections in the puddles, written by ${name}.` });

/** One revealed line: `i` sets when it types out. */
function Line({ i, className, children }: { i: number; className?: string; children: ReactNode }) {
  return (
    <span className={`textcard-line block ${className ?? ""}`} style={{ "--i": i } as CSSProperties}>
      {children}
    </span>
  );
}

/** A little syntax color for the code sample: strings, numbers and calls. */
function Code({ line }: { line: string }) {
  const parts = line.split(/("[^"]*"|\b\d+(?:\.\d+)?\b|\b[a-z]+(?=\())/g);
  return (
    <>
      {parts.map((p, k) =>
        p.startsWith('"') ? (
          <span key={k} className="text-[#b5e28c]">
            {p}
          </span>
        ) : /^\d/.test(p) ? (
          <span key={k} className="text-[#f6c177]">
            {p}
          </span>
        ) : /^[a-z]+$/.test(p) && k % 2 === 1 ? (
          <span key={k} className="text-[var(--hue)]">
            {p}
          </span>
        ) : (
          <span key={k}>{p}</span>
        ),
      )}
    </>
  );
}

export function TextCardPreview({ id, name, maker, hue }: { id: string; name: string; maker: string; hue: string }) {
  const s = SAMPLES[id] ?? fallback(name);
  const body = (() => {
    switch (s.kind) {
      case "plan":
        return s.lines.map(([t, text], i) => (
          <Line key={t} i={i + 1} className="flex gap-1.5 truncate">
            <span className="shrink-0 font-mono text-[9px] leading-[15px] text-[var(--hue)]">{t}s</span>
            <span className="truncate">{text}</span>
          </Line>
        ));
      case "code":
        return s.lines.map((l, i) => (
          <Line key={l} i={i + 1} className="truncate font-mono text-[9.5px] leading-[15px] text-fog">
            <Code line={l} />
          </Line>
        ));
      case "script":
        return s.lines.map(([who, text], i) => (
          <Line key={text} i={i + 1} className="flex gap-1.5 truncate">
            <span className="shrink-0 text-[8.5px] font-bold uppercase leading-[15px] tracking-[0.08em] text-[var(--hue)]">{who}</span>
            <span className="truncate">{text}</span>
          </Line>
        ));
      case "vision":
        return (
          <>
            <Line i={1} className="relative mb-1 h-[46px] overflow-hidden rounded-[7px]">
              {/* Crackio's own product shot (the Product Studio sample). */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={s.image} alt="" loading="lazy" className="absolute inset-0 size-full object-cover" />
              <span
                className="absolute rounded-[4px] shadow-[0_0_0_1.5px_var(--hue)]"
                style={{ left: `${s.box.x}%`, top: `${s.box.y}%`, width: `${s.box.w}%`, height: `${s.box.h}%` }}
              >
                <span className="absolute -top-px left-0 -translate-y-full rounded-t-[3px] bg-[var(--hue)] px-1 text-[7.5px] font-bold leading-[11px] text-black">{s.box.label}</span>
              </span>
            </Line>
            <Line i={2} className="line-clamp-2 whitespace-normal">
              {s.answer}
            </Line>
          </>
        );
      case "rewrite":
        return (
          <>
            <Line i={1} className="truncate text-haze line-through decoration-white/25">
              {s.ask}
            </Line>
            <Line i={2} className="line-clamp-3 whitespace-normal">
              {s.answer}
            </Line>
          </>
        );
    }
  })();

  return (
    <div
      className="library-card-blank absolute inset-0 overflow-hidden"
      style={{ "--hue": hue } as CSSProperties}
      aria-hidden="true"
    >
      {/* Its name, very faint, behind the window. */}
      <span className="absolute -left-1 top-[46%] w-[140%] break-words font-display text-[46px] uppercase leading-[0.86] tracking-[-0.03em] text-white/[0.05]">{name}</span>
      {/* Never into the name at the card's foot: past its share of the card, the window fades out. */}
      <div className="absolute inset-x-2.5 top-9 max-h-[52%] overflow-hidden rounded-[12px] bg-[#0c0b10]/80 p-2.5 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08),0_14px_30px_-14px_rgb(0_0_0/0.8)] [mask-image:linear-gradient(to_bottom,#000_78%,transparent)]">
        <div className="flex items-center gap-1.5 border-b border-white/[0.06] pb-1.5">
          <span className="grid size-4 shrink-0 place-items-center">
            <VendorMark vendor={maker} model={name} size={14} variant="bare" className="text-fog" />
          </span>
          <span className="truncate text-[9.5px] text-haze">{s.ask}</span>
        </div>
        <div className="mt-1.5 space-y-0.5 text-[10px] leading-[15px] text-paper/90">
          {body}
          <span className="textcard-caret mt-0.5 inline-block h-[10px] w-[5px] rounded-[1px] bg-[var(--hue)]" />
        </div>
      </div>
    </div>
  );
}
