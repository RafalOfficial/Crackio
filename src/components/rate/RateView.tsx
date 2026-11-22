"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, CornerDownLeft, LoaderCircle, Undo2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { previewUrl } from "@/lib/media-url";

/**
 * A/B rating: two results side by side, your pick with one key. Each pick teaches Crackio's own models your taste
 * (/api/lab/rate keeps them). The first queue: two swap takes of the same frame, which one turned the person into the
 * character better.
 */

/** `ask`: "better" (round 1: which of the two is better) or "good" (which of them are good: each click labels both). */
type SwapPair = { id: string; task: "swap"; who: string; noun: string; frame: string; character: string; a: string; b: string; ask?: "better" | "good" };
/**
 * Two replies to the same moment of a conversation: what was said so far (`context`), a picture it was shown, and who's
 * talking (`persona`, the voice's name in Talk's prompt).
 */
type ChatPair = {
  id: string;
  task: "chat";
  context: { role: "user" | "assistant"; text: string }[];
  image?: string;
  persona?: string;
  a: string;
  b: string;
  ask?: "better" | "good";
};
type Pair = SwapPair | ChatPair;
/** "custom": neither, your own answer in your words (a chat reply you'd rather hear). */
type Choice = "a" | "b" | "both_bad" | "both_good" | "skip" | "custom";
/** A pair you rated and what you picked: Undo steps back through these, picks from before the page opened too. */
type Rated = Pair & { picked?: { choice: string; text?: string } };

/** "the person in the middle of the frame (x 30–73%, y 22–99%)" → "the person in the middle" */
const plainWho = (who: string) => who.replace(/\s*\(x [^)]*\)/, "").replace(/ of the frame$/, "");
const noun = (n: string) => n.replace(/^(a|an|the)\s+/i, "");

export function RateView({ task = "swap" }: { task?: "swap" | "chat" }) {
  const img = useCallback((name: string) => `/api/media/out/feedback/${task}/img/${encodeURIComponent(name)}`, [task]);
  const [queue, setQueue] = useState<Pair[] | null>(null);
  const [done, setDone] = useState(0);
  const [total, setTotal] = useState(0);
  const [flash, setFlash] = useState<Choice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const history = useRef<Rated[]>([]);
  const seeded = useRef(false);
  /** Your own reply to a chat pair, kept with the pair it's for (one you step back to shows what you wrote). */
  const [draft, setDraft] = useState({ id: "", text: "" });
  const composer = useRef<HTMLTextAreaElement>(null);
  /** When the pair on screen appeared: how long a pick took is saved with it (a quick pick is a sure one). */
  const shown = useRef(0);
  const busy = useRef(false);
  /** A chat pair's conversation: kept scrolled to its end, the line the replies answer. */
  const thread = useRef<HTMLDivElement>(null);

  const [live, setLive] = useState(false);

  // The queue, and while a round is still being made (`live`), the pairs that joined it since: every 30 s.
  useEffect(() => {
    let stop = false;
    const load = () =>
      fetch(`/api/lab/rate?task=${task}`, { cache: "no-store" })
        .then((r) => r.json())
        .then((d: { pairs?: Pair[]; back?: Rated[]; done?: number; total?: number; live?: boolean; error?: string }) => {
          if (d.error) throw new Error(d.error);
          if (stop) return;
          if (!seeded.current) {
            seeded.current = true;
            history.current = [...(d.back ?? []), ...history.current];
          }
          const seen = new Set(history.current.map((p) => p.id));
          setQueue((q) => {
            const have = new Set((q ?? []).map((p) => p.id));
            return [...(q ?? []), ...(d.pairs ?? []).filter((p) => !have.has(p.id) && !seen.has(p.id))];
          });
          setTotal(d.total ?? 0);
          setLive(Boolean(d.live));
          setDone((n) => (n ? n : (d.done ?? 0)));
        })
        .catch((e: Error) => setError(e.message));
    void load();
    // Not while the tab is in the background: the next look when it's back finds the same pairs.
    const timer = setInterval(() => document.visibilityState !== "hidden" && void load(), 30_000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [task]);

  // The next few pairs' pictures load while you look at this one.
  useEffect(() => {
    for (const p of queue?.slice(1, 4) ?? []) for (const n of p.task === "chat" ? (p.image ? [p.image] : []) : [p.frame, p.character, p.a, p.b]) new Image().src = img(n);
    shown.current = Date.now();
  }, [queue, img]);

  const pairId = queue?.[0]?.id;
  useEffect(() => {
    thread.current?.scrollTo({ top: thread.current.scrollHeight });
  }, [pairId]);

  const send = useCallback((id: string, choice: Choice | "undo", ms?: number, text?: string) => {
    void fetch("/api/lab/rate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ task, id, choice, ms, text }) }).catch(() =>
      setError("Couldn't save that pick: is Crackio still running?"),
    );
  }, [task]);

  const pick = useCallback(
    (choice: Choice, text?: string) => {
      const pair = queue?.[0];
      if (!pair || busy.current) return;
      busy.current = true;
      send(pair.id, choice, Date.now() - shown.current, text);
      setFlash(choice);
      setTimeout(() => {
        history.current.push({ ...pair, picked: { choice, text } });
        setQueue((q) => (q ? q.slice(1) : q));
        if (choice !== "skip") setDone((n) => n + 1);
        setFlash(null);
        busy.current = false;
      }, 140);
    },
    [queue, send],
  );

  const undo = useCallback(() => {
    const last = history.current.pop();
    if (!last) return;
    send(last.id, "undo");
    if (last.picked?.text) setDraft({ id: last.id, text: last.picked.text });
    setQueue((q) => [last, ...(q ?? [])]);
    setDone((n) => Math.max(0, n - 1));
  }, [send]);

  useEffect(() => {
    const keys: Record<string, () => void> = {
      ArrowLeft: () => pick("a"),
      ArrowRight: () => pick("b"),
      ArrowDown: () => pick("both_bad"),
      ArrowUp: () => pick("both_good"),
      " ": () => pick("skip"),
      z: undo,
      Backspace: undo,
    };
    const onKey = (e: KeyboardEvent) => {
      // While you write your own reply, the keys are its letters.
      if (e.target instanceof HTMLElement && e.target.closest("input, textarea, select, [contenteditable='true']")) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const run = keys[e.key];
      if (run) {
        e.preventDefault();
        run();
      } else if (e.key.length === 1) composer.current?.focus(); // any other letter starts your own reply, with that letter
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pick, undo]);

  const pair = queue?.[0];
  const own = pair && draft.id === pair.id ? draft.text : "";
  const sendOwn = () => {
    if (!own.trim() || busy.current) return;
    composer.current?.blur();
    pick("custom", own.trim());
    setDraft({ id: "", text: "" });
  };
  return (
    <div className="mx-auto flex min-h-[calc(100dvh-2rem)] max-w-[1400px] flex-col gap-4 px-4 py-6 sm:px-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-[32px] sm:text-[38px]">Rate</h1>
          <p className="text-[14px] text-fog">Your eye teaches Crackio’s own models. Pick the better one with the arrow keys.</p>
        </div>
        <div className="flex min-w-[220px] flex-col items-end gap-1.5">
          <span className="font-mono text-[13px] text-fog">
            {done} / {total} rated
          </span>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-apple-2">
            <div className="h-full rounded-full bg-spike transition-[width] duration-300" style={{ width: `${total ? (100 * done) / total : 0}%` }} />
          </div>
        </div>
      </header>

      {error && <p className="rounded-card border border-tally/40 bg-tally/10 px-4 py-2 text-[14px] text-paper">{error}</p>}

      {!queue && !error && (
        <div className="flex flex-1 items-center justify-center text-fog">
          <LoaderCircle className="size-6 animate-spin" />
        </div>
      )}

      {queue && !pair && (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
          {live ? (
            <>
              <LoaderCircle className="size-6 animate-spin text-fog" />
              <p className="font-display text-[24px]">Waiting for the next batch</p>
              <p className="text-[14px] text-fog">The box is still drawing takes; new pairs arrive about every 10 minutes and show up here on their own.</p>
            </>
          ) : (
            <>
              <p className="font-display text-[24px]">All {total} rated. Thank you.</p>
              <p className="text-[14px] text-fog">Your picks are saved in data/feedback/{task}/choices.jsonl.</p>
            </>
          )}
        </div>
      )}

      {pair?.task === "chat" && (
        <>
          <p className="text-[15px] leading-snug text-paper">
            {pair.ask === "good" ? "Which AI replies would you like to hear back?" : "Which AI reply would you rather hear back?"}{" "}
            <span className="text-fog">
              Like a real person talking out loud: it makes sense for what you said, it’s natural and warm, and a few words get a few words. Neither
              sounds right? Write yours under them.
              {pair.persona ? ` ${pair.persona} plays a real person with a life of their own, and admits being an AI only if asked straight out.` : ""}
            </span>
          </p>

          {/* The conversation so far, the line being answered biggest, the two replies right under it, then the keys. */}
          <section className="mx-auto flex w-full max-w-[1040px] flex-1 flex-col justify-center gap-3">
            <div ref={thread} className="flex max-h-[54dvh] flex-col gap-1.5 overflow-y-auto rounded-panel border border-line bg-flat p-4 sm:px-5">
              {pair.context.map((m, i) => {
                const last = i === pair.context.length - 1;
                return (
                  <div key={i} className={cn("flex max-w-[85%] flex-col gap-0.5", m.role === "user" ? "items-end self-end" : "items-start self-start")}>
                    {i === 0 && pair.image ? (
                      <img
                        src={img(pair.image)}
                        alt="A picture you showed it"
                        onLoad={() => thread.current?.scrollTo({ top: thread.current.scrollHeight })}
                        className="h-40 w-auto rounded-chip object-contain"
                      />
                    ) : null}
                    <span className="font-mono text-[10.5px] uppercase tracking-wider text-haze">{m.role === "user" ? (last ? "You said" : "You") : (pair.persona ?? "AI")}</span>
                    <p
                      className={cn(
                        "rounded-[18px] px-4 leading-snug",
                        m.role === "user" ? "bg-apple-2 text-paper" : "border border-line text-fog",
                        last ? "py-2.5 text-[22px]" : "py-1.5 text-[15px]",
                      )}
                    >
                      {m.text}
                    </p>
                  </div>
                );
              })}
            </div>

            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {(["a", "b"] as const).map((side) => (
                <button
                  key={side}
                  type="button"
                  onClick={() => pick(side)}
                  className={cn(
                    "flex min-h-[100px] flex-col items-start gap-2 rounded-panel border bg-stage px-5 py-4 text-left transition-colors",
                    flash === side ? "border-spike" : "border-line hover:border-line-strong",
                    flash === "both_bad" && "border-tally",
                    flash === "both_good" && "border-chroma",
                  )}
                >
                  <span className="flex items-center gap-1.5 font-mono text-[13px] text-fog">
                    {side === "a" ? <ArrowLeft className="size-3.5" /> : null}
                    {pair.persona ? `${pair.persona}’s reply` : "AI reply"} {side.toUpperCase()}
                    {side === "b" ? <ArrowRight className="size-3.5" /> : null}
                  </span>
                  <p className="text-[22px] leading-snug text-paper">{pair[side]}</p>
                </button>
              ))}
            </div>

            {/* Your own reply in your words, sent instead of a pick: the best answer to learn from. */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                sendOwn();
              }}
              className={cn(
                "flex flex-wrap items-end gap-2 rounded-panel border bg-stage p-2 pl-4 transition-colors sm:flex-nowrap",
                flash === "custom" ? "border-spike" : "border-line focus-within:border-line-strong",
              )}
            >
              <textarea
                ref={composer}
                rows={1}
                value={own}
                onChange={(e) => setDraft({ id: pair.id, text: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    sendOwn();
                  } else if (e.key === "Escape") e.currentTarget.blur();
                }}
                placeholder="Or type the reply you’d rather hear, your way"
                aria-label="Your own reply"
                className="max-h-40 min-h-[44px] w-full flex-1 resize-none bg-transparent py-2 text-[20px] leading-snug text-paper outline-none placeholder:text-haze [field-sizing:content]"
              />
              <div className="flex shrink-0 items-center gap-1">
                {(["a", "b"] as const).map((side) => (
                  <button
                    key={side}
                    type="button"
                    onClick={() => {
                      setDraft({ id: pair.id, text: pair[side] });
                      composer.current?.focus();
                    }}
                    className="rounded-btn px-2.5 py-2 text-[13px] text-fog hover:bg-apple-2 hover:text-paper"
                  >
                    Start from {side.toUpperCase()}
                  </button>
                ))}
                <button
                  type="submit"
                  disabled={!own.trim()}
                  title="Enter sends it, Shift+Enter starts a new line, Esc goes back to the arrow keys"
                  className="lip press inline-flex h-10 items-center gap-1.5 rounded-full bg-spike px-4 text-[14px] font-bold text-spike-ink [--lip:var(--color-spike-lip)] hover:bg-spike-hi disabled:opacity-40"
                >
                  <CornerDownLeft className="size-4" />
                  Send mine
                </button>
              </div>
            </form>

            <nav className="mt-2 flex flex-wrap items-center justify-center gap-2">
              <Key onClick={() => pick("a")} icon={<ArrowLeft className="size-4" />} label={pair.ask === "good" ? "Only A is good" : "A is better"} />
              <Key onClick={() => pick("both_bad")} icon={<ArrowDown className="size-4" />} label="Both bad" />
              <Key onClick={() => pick("both_good")} icon={<ArrowUp className="size-4" />} label="Both good" />
              <Key onClick={() => pick("b")} icon={<ArrowRight className="size-4" />} label={pair.ask === "good" ? "Only B is good" : "B is better"} />
              <Key onClick={() => pick("skip")} icon={<span className="font-mono text-[11px]">space</span>} label="Skip" />
              <Key onClick={undo} icon={<Undo2 className="size-4" />} label="Undo (Z)" />
            </nav>
          </section>
        </>
      )}

      {pair?.task !== "chat" && pair && (
        <>
          <section className="flex flex-wrap items-center gap-4 rounded-panel border border-line bg-flat p-3">
            <figure className="flex items-center gap-3">
              <img src={previewUrl(img(pair.frame), 480)} alt="The original frame" className="h-24 w-auto rounded-chip object-contain" />
              <figcaption className="text-[13px] text-fog">Before</figcaption>
            </figure>
            <figure className="flex items-center gap-3">
              <img src={previewUrl(img(pair.character), 480)} alt={`The ${noun(pair.noun)}`} className="h-24 w-auto rounded-chip object-contain" />
              <figcaption className="text-[13px] text-fog">Should become</figcaption>
            </figure>
            {pair.ask === "good" ? (
              <p className="min-w-[260px] flex-1 text-[15px] leading-snug text-paper">
                Which takes turned <span className="text-spike-hi">{plainWho(pair.who)}</span> fully into the <span className="text-spike-hi">{noun(pair.noun)}</span>? Head,
                hair, hands, the whole outfit, the same pose, nothing else changed. A half swap is bad.
              </p>
            ) : (
              <p className="min-w-[260px] flex-1 text-[15px] leading-snug text-paper">
                Which take turned <span className="text-spike-hi">{plainWho(pair.who)}</span> into the <span className="text-spike-hi">{noun(pair.noun)}</span> better? Face
                and hair, the whole outfit, the same pose, nothing else changed.
              </p>
            )}
          </section>

          <section className="grid flex-1 grid-cols-1 gap-3 md:grid-cols-2">
            {(["a", "b"] as const).map((side) => (
              <button
                key={side}
                type="button"
                onClick={() => pick(side)}
                className={cn(
                  "group relative flex min-h-[40dvh] items-center justify-center overflow-hidden rounded-panel border bg-stage transition-colors",
                  flash === side ? "border-spike" : "border-line hover:border-line-strong",
                  flash === "both_bad" && "border-tally",
                  flash === "both_good" && "border-chroma",
                )}
              >
                <img src={img(pair[side])} alt={`Take ${side.toUpperCase()}`} className="max-h-[calc(100dvh-330px)] w-full object-contain" />
                <span className="absolute left-3 top-3 flex items-center gap-1.5 rounded-chip bg-stage/80 px-2.5 py-1 font-mono text-[13px] text-paper">
                  {side === "a" ? <ArrowLeft className="size-3.5" /> : null}
                  {side.toUpperCase()}
                  {side === "b" ? <ArrowRight className="size-3.5" /> : null}
                </span>
              </button>
            ))}
          </section>

          <nav className="flex flex-wrap items-center justify-center gap-2 pb-2">
            <Key onClick={() => pick("a")} icon={<ArrowLeft className="size-4" />} label={pair.ask === "good" ? "Only A is good" : "A is better"} />
            <Key onClick={() => pick("both_bad")} icon={<ArrowDown className="size-4" />} label="Both bad" />
            <Key onClick={() => pick("both_good")} icon={<ArrowUp className="size-4" />} label="Both good" />
            <Key onClick={() => pick("b")} icon={<ArrowRight className="size-4" />} label={pair.ask === "good" ? "Only B is good" : "B is better"} />
            <Key onClick={() => pick("skip")} icon={<span className="font-mono text-[11px]">space</span>} label="Skip" />
            <Key onClick={undo} icon={<Undo2 className="size-4" />} label="Undo (Z)" />
          </nav>
        </>
      )}
    </div>
  );
}

function Key({ onClick, icon, label }: { onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button type="button" onClick={onClick} className="flex items-center gap-2 rounded-btn border border-line bg-apple px-3.5 py-2 text-[14px] text-paper hover:border-line-strong hover:bg-apple-2">
      {icon}
      {label}
    </button>
  );
}
