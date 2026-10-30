"use client";

import { useState } from "react";
import { ArrowUpRight, KeyRound, LoaderCircle } from "lucide-react";
import { DEMO, DEMO_REPO } from "@/lib/demo/config";
import { signInDemo, signOutDemo, useDemoSession } from "@/lib/demo/use-demo-session";
import { Popover } from "@/components/ui/Popover";
import { cn } from "@/lib/cn";

/*
 * The live demo's own controls: the access code and the credits left. On a computer they sit at the foot of the sidebar,
 * in its flow (so they never cover its links, a composer or a page's controls); on a phone, in a slim bar along the
 * bottom. After signing in or out the whole page loads again: a studio code is served by its own Crackio (another
 * build), and the page has to come from it.
 */

const reload = () => window.location.assign(window.location.pathname + window.location.search);

function SignIn({ compact = false }: { compact?: boolean }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!code.trim() || busy) return;
    setBusy(true);
    setError(null);
    const problem = await signInDemo(code.trim());
    if (problem) {
      setBusy(false);
      setError(problem);
    } else reload();
  };
  return (
    <form onSubmit={submit} className={cn("min-w-0", compact ? "flex flex-1 items-center gap-1.5" : "space-y-1.5")}>
      <input
        value={code}
        onChange={(e) => setCode(e.target.value)}
        placeholder="Access code"
        aria-label="Your access code"
        autoComplete="off"
        spellCheck={false}
        className={cn(
          "field-focus h-9 min-w-0 rounded-[10px] bg-white/[0.06] px-3 font-mono text-[13px] text-paper outline-none shadow-[inset_0_0_0_1px_rgb(255_255_255/0.1)] placeholder:font-sans placeholder:text-haze",
          compact ? "flex-1" : "w-full",
        )}
      />
      <button
        type="submit"
        disabled={busy || !code.trim()}
        className={cn(
          "press inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-[10px] bg-spike px-3.5 text-[13px] font-bold text-spike-ink hover:bg-spike-hi disabled:opacity-60",
          compact ? "" : "w-full",
        )}
      >
        {busy ? <LoaderCircle size={14} className="animate-spin" /> : null}
        Sign in
      </button>
      {error ? <p className={cn("text-[11.5px] leading-snug text-tally", compact && "sr-only")}>{error}</p> : null}
    </form>
  );
}

function GetCrackio({ className }: { className?: string }) {
  return (
    <a href={DEMO_REPO} target="_blank" rel="noreferrer" className={cn("inline-flex items-center gap-0.5 text-[12px] font-semibold text-haze hover:text-paper", className)}>
      Get Crackio <ArrowUpRight size={12} />
    </a>
  );
}

/** The card's inside: the code to enter, or the credits left. */
function CardBody() {
  const session = useDemoSession();
  if (!session.loaded) return <div className="skeleton h-[92px] rounded-[12px]" />;
  if (!session.signedIn) {
    return (
      <>
        <p className="flex items-center gap-1.5 text-[12.5px] font-semibold text-paper">
          <span className="size-1.5 rounded-full bg-spike" /> Live demo
        </p>
        <p className="mb-2 mt-0.5 text-[12px] leading-snug text-haze">Enter your access code</p>
        <SignIn />
        <GetCrackio className="mt-2" />
      </>
    );
  }
  return (
    <>
      <p className="flex items-center gap-1.5 text-[11.5px] font-semibold uppercase tracking-[0.06em] text-haze">
        <span className="size-1.5 rounded-full bg-chroma" /> Live demo
      </p>
      <p className="mt-1 text-[15px] font-semibold text-paper" aria-live="polite">
        <span className="tabular">{session.credits}</span> credit{session.credits === 1 ? "" : "s"} left
      </p>
      <div className="mt-1.5 flex items-center justify-between gap-2">
        <button onClick={() => void signOutDemo().then(reload)} className="text-[12px] font-semibold text-haze hover:text-paper">
          Sign out
        </button>
        <GetCrackio />
      </div>
    </>
  );
}

/** At the foot of the sidebar (computers): a glass card, or on the slim rail a button that opens it. */
export function DemoCard({ collapsed }: { collapsed: boolean }) {
  const session = useDemoSession();
  if (!DEMO) return null;
  if (collapsed) {
    return (
      <Popover
        placement="top-start"
        panelClassName="w-[260px] p-3"
        trigger={({ open, toggle }) => (
          <button
            onClick={toggle}
            aria-expanded={open}
            title={session.signedIn ? `${session.credits} credits left` : "Live demo: enter your access code"}
            className="smoked-glass squircle mb-1.5 hidden h-12 w-full flex-col items-center justify-center rounded-[14px] text-paper lg:flex"
          >
            {session.signedIn ? (
              <>
                <span className="tabular text-[13px] font-bold leading-none">{session.credits}</span>
                <span className="mt-0.5 text-[9px] font-semibold uppercase tracking-[0.06em] text-haze">credits</span>
              </>
            ) : (
              <KeyRound size={17} className="text-spike" />
            )}
          </button>
        )}
      >
        {() => <CardBody />}
      </Popover>
    );
  }
  return (
    <div className="smoked-glass squircle mb-2 hidden rounded-[16px] p-3 lg:block">
      <CardBody />
    </div>
  );
}

/** Phones: a slim glass bar along the bottom (the sidebar is a drawer there). */
export function DemoBar() {
  const session = useDemoSession();
  if (!DEMO) return null;
  return (
    <div className="smoked-glass fixed inset-x-0 bottom-0 z-40 flex h-14 items-center gap-2.5 px-3 lg:hidden">
      {!session.loaded ? null : session.signedIn ? (
        <>
          <span className="flex items-center gap-1.5 text-[13px] font-semibold text-paper" aria-live="polite">
            <span className="size-1.5 rounded-full bg-chroma" />
            <span className="tabular">{session.credits}</span> credit{session.credits === 1 ? "" : "s"} left
          </span>
          <button onClick={() => void signOutDemo().then(reload)} className="text-[12.5px] font-semibold text-haze hover:text-paper">
            Sign out
          </button>
          <GetCrackio className="ml-auto" />
        </>
      ) : (
        <>
          <span className="flex shrink-0 items-center gap-1.5 text-[12.5px] font-semibold text-paper">
            <span className="size-1.5 rounded-full bg-spike" /> Live demo
          </span>
          <SignIn compact />
        </>
      )}
    </div>
  );
}
