"use client";

import { useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/Button";
import { DEMO, DEMO_REPO } from "@/lib/demo/config";
import { TOOLS } from "@/lib/tools";
import { PRICES } from "@/lib/demo/price-list";
import { signInDemo, useDemoSession } from "@/lib/demo/use-demo-session";

const noSubscription = () => () => {};

/** Where a demo visitor types their access code. */
export function DemoSignIn() {
  const session = useDemoSession();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Shown in place of a tool the demo leaves out (read in the browser; the server render has no address bar).
  const shown = useSyncExternalStore(noSubscription, () => window.location.pathname, () => "/demo");
  const path = shown === "/demo" ? null : shown;
  const from = path ? (TOOLS.find((t) => path.startsWith(t.href))?.name ?? path.replace(/^\//, "").split("/")[0]) : null;

  if (!DEMO) return <p className="p-8 text-fog">This Crackio isn&apos;t a live demo.</p>;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const problem = await signInDemo(code.trim());
    setBusy(false);
    if (problem) setError(problem);
    // A whole new page load, not a client navigation: a studio code is served by its own Crackio (another build), and the
    // page must come from it, with its sidebar and tools.
    else window.location.assign(path ?? "/");
  };

  return (
    <div className="mx-auto max-w-[480px] px-5 py-16">
      {from ? (
        <p className="mb-8 rounded-[14px] bg-white/[0.05] px-4 py-3 text-[13.5px] leading-relaxed text-fog">
          <span className="font-semibold capitalize text-paper">{from}</span> isn&apos;t in the live demo: it needs a computer of
          your own (or keys and settings this shared one doesn&apos;t give out). Get Crackio below to run it.
        </p>
      ) : null}
      <h1 className="font-display text-[34px] font-bold uppercase leading-none tracking-[0.01em] text-paper">Try Crackio live</h1>
      <p className="mt-4 text-[14.5px] leading-relaxed text-fog">
        This is Crackio running on one shared GPU, with open models through ComfyUI. An access code carries credits, and
        your work stays with your code: nobody else sees it.
      </p>
      <ul className="mt-5 grid grid-cols-2 gap-x-6 gap-y-1.5 text-[13px] text-fog">
        <li>A picture or an edit</li>
        <li className="tabular text-paper">
          {PRICES.picture["1k"]}–{PRICES.picture["4k"]} credits
        </li>
        <li>A 5 s clip</li>
        <li className="tabular text-paper">
          {PRICES.clip["720p"]}–{PRICES.clip["1080p"]} credits
        </li>
        <li>A swap or a template</li>
        <li className="tabular text-paper">{PRICES.swap} credits</li>
        <li>An upscale</li>
        <li className="tabular text-paper">
          {PRICES.upscalePicture} a picture, {PRICES.upscaleClip} a clip
        </li>
      </ul>
      <p className="mt-3 text-[12.5px] text-haze">A failed or cancelled job gives its credits back.</p>
      {session.signedIn ? (
        <p className="mt-8 text-[14px] text-paper">
          You&apos;re signed in with <span className="tabular font-semibold">{session.credits} credits</span> left.
        </p>
      ) : (
        <form onSubmit={submit} className="mt-8 flex flex-col gap-3">
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="CRK-XXXX-XXXX"
            autoComplete="off"
            spellCheck={false}
            className="h-12 rounded-[14px] bg-white/[0.06] px-4 font-mono text-[15px] uppercase tracking-[0.08em] text-paper outline-none placeholder:text-haze focus:bg-white/[0.09]"
          />
          {error ? <p className="text-[13px] text-tally">{error}</p> : null}
          <Button type="submit" variant="primary" size="lg" disabled={busy || code.trim().length < 4}>
            {busy ? "Checking…" : "Start"}
          </Button>
        </form>
      )}
      <p className="mt-10 text-[13px] leading-relaxed text-haze">
        No code? Crackio is free and open source: run it on your own computer, even on a 6 GB graphics card or a Mac.{" "}
        <a href={DEMO_REPO} target="_blank" rel="noreferrer" className="text-paper underline underline-offset-2">
          Get it on GitHub
        </a>
        .
      </p>
    </div>
  );
}
