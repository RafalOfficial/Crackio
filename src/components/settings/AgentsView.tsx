"use client";

import { useCallback, useEffect, useState } from "react";
import { TriangleAlert } from "lucide-react";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/cn";
import { Heading, Lamp, Loading, Verdict } from "./parts";
import { Choices, Toggle } from "./PreferencesView";

type Cli = { id: string; name: string; found: boolean; connected: boolean; config: string; change: { connect: string; remove: string } };
type Prefs = { enabled: boolean; spend: "free" | "confirm" | "all"; seePictures: boolean };
type Check = { ok: boolean; tools?: number; error?: string };
type Look = { clis: Cli[]; prefs: Prefs; tools: number; program: { path: string; check?: Check }; remote: { url: string; program: string } | null };

/**
 * Settings → Agents: connect a coding agent (Claude Code, Codex, Cursor, Grok, OpenCode, Gemini CLI) to Crackio in one
 * click, and say what agents may do. Only the agents on this computer are looked for; each change is shown before it's made.
 */
export function AgentsView() {
  const [look, setLook] = useState<Look | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [copied, setCopied] = useState(false);
  // "Allow everything" isn't saved on a click: it waits for a tick and a double-click.
  const [asking, setAsking] = useState(false);
  const [sure, setSure] = useState(false);
  const [round, setRound] = useState(0);

  const load = useCallback(async () => {
    const res = await fetch("/api/agent/connect", { cache: "no-store" }).catch(() => null);
    if (res?.ok) setLook((await res.json()) as Look);
  }, []);
  useEffect(() => {
    let alive = true;
    fetch("/api/agent/connect", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (alive && json) setLook(json as Look);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  if (!look) return <Loading rows={5} />;

  const post = async (body: Record<string, unknown>) => {
    const res = await fetch("/api/agent/connect", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    return res ? ((await res.json().catch(() => ({}))) as { cli?: Cli; check?: Check; prefs?: Prefs; error?: string }) : { error: "Crackio didn't answer." };
  };

  async function prefs(patch: Partial<Prefs>, agreed = false) {
    setLook((l) => (l ? { ...l, prefs: { ...l.prefs, ...patch } } : l));
    const out = await post({ action: "prefs", ...patch, ...(agreed ? { agreed: true } : {}) });
    if (out.prefs) setLook((l) => (l ? { ...l, prefs: out.prefs! } : l));
  }

  async function change(cli: Cli, action: "connect" | "remove") {
    setBusy(cli.id);
    const out = await post({ action, id: cli.id });
    setBusy(null);
    setOpen(null);
    if (out.error) setSaid((s) => ({ ...s, [cli.id]: { ok: false, text: out.error! } }));
    else if (action === "remove") setSaid((s) => ({ ...s, [cli.id]: { ok: true, text: "Removed." } }));
    else setSaid((s) => ({ ...s, [cli.id]: out.check?.ok ? { ok: true, text: `Connected. Restart ${cli.name}, then ask it to make a picture.` } : { ok: false, text: `Added, but the test failed: ${out.check?.error ?? "no answer"}` } }));
    await load();
  }

  const here = look.clis.filter((c) => c.found);
  const away = look.clis.filter((c) => !c.found);
  const command = look.remote ? `curl.exe -o crackio-mcp.mjs ${look.remote.program}   (macOS and Linux: curl)\nclaude mcp add -s user crackio -e CRACKIO_URL=${look.remote.url} -- node <the folder you saved it in>/crackio-mcp.mjs` : "";

  return (
    <div className="space-y-10">
      <Verdict title="Agents" facts="Let a coding agent use Crackio. It writes the prompts; Crackio makes the pictures, clips and voices on your GPUs." aside={<Toggle on={look.prefs.enabled} onChange={(enabled) => void prefs({ enabled })} label="Agents can use Crackio" />} />

      <section className="space-y-3">
        <Heading title="Connect" note="The agents found on this computer. One click adds Crackio to each." />
        <ul className="divide-y divide-[var(--color-line)] overflow-hidden rounded-[16px] bg-white/[0.025] shadow-[inset_0_0_0_1px_var(--color-line)]">
          {here.map((c) => {
            const mode = c.connected ? "remove" : "connect";
            return (
              <li key={c.id} className="px-4 py-3">
                <div className="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-2">
                  <Lamp tone={c.connected ? "ready" : "off"} />
                  <span className="text-[14px] font-semibold text-paper">{c.name}</span>
                  <span className={cn("text-[12.5px]", said[c.id] && !said[c.id].ok ? "text-tally" : "text-haze")}>{said[c.id]?.text ?? (c.connected ? "Connected" : "Not connected")}</span>
                  <span className="ml-auto flex items-center gap-2">
                    {open === c.id ? (
                      <>
                        <button type="button" onClick={() => setOpen(null)} className="press h-8 rounded-btn px-3 text-[12.5px] font-semibold text-fog hover:text-paper">
                          Cancel
                        </button>
                        <button type="button" disabled={busy === c.id} onClick={() => void change(c, mode)} className="press h-8 rounded-btn bg-paper px-3.5 text-[12.5px] font-semibold text-[#16131b] hover:bg-white disabled:opacity-60">
                          {busy === c.id ? "Working…" : mode === "connect" ? "Connect now" : "Remove now"}
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setOpen(c.id)}
                        className={cn("press h-8 rounded-btn px-3.5 text-[12.5px] font-semibold", c.connected ? "bg-white/[0.06] text-paper hover:bg-white/[0.1]" : "bg-paper text-[#16131b] hover:bg-white")}
                      >
                        {c.connected ? "Remove" : "Connect"}
                      </button>
                    )}
                  </span>
                </div>
                {open === c.id ? <p className="mt-2 break-all rounded-[10px] bg-black/30 px-3 py-2 font-mono text-[12px] leading-relaxed text-fog">{c.change[mode]}</p> : null}
              </li>
            );
          })}
          {!here.length ? <li className="px-4 py-4 text-[13px] text-haze">No agent found on this computer. Install one, then come back.</li> : null}
        </ul>
        {away.length ? <p className="text-[12.5px] text-haze">Not on this computer: {away.map((c) => c.name).join(", ")}.</p> : null}
      </section>

      <section className="space-y-3">
        <Heading title="What agents may spend" note={look.prefs.spend === "all" ? "Agents spend without asking you." : "A paid job always needs your yes to its price first."} />
        <Choices
          key={round}
          label="What agents may spend"
          value={look.prefs.spend}
          onChange={(v) => {
            if (v === "all" && look.prefs.spend !== "all") {
              setSure(false);
              setAsking(true);
              return;
            }
            setAsking(false);
            void prefs({ spend: v as Prefs["spend"] });
          }}
          options={[
            { value: "free", label: "Nothing", note: "Your own computers only (default)" },
            { value: "confirm", label: "Ask me each time", note: "Rented GPUs and Comfy credits, after you agree to the price" },
            { value: "all", label: "Allow everything", note: "No questions: agents spend by themselves", danger: true, warn: true },
          ]}
        />
        {asking ? (
          <div className="squircle rounded-[16px] bg-tally/[0.07] px-4 py-3.5 shadow-[inset_0_0_0_1px_rgb(255_86_86/0.35)]">
            <p className="flex items-start gap-2 text-[13.5px] font-semibold leading-snug text-paper">
              <TriangleAlert size={16} className="mt-px shrink-0 text-tally" />
              Agents will spend your money without asking.
            </p>
            <p className="mt-1 pl-6 text-[12.5px] leading-relaxed text-fog">Rented GPU time, RunPod Serverless and Comfy credits, for every agent connected to this Crackio. No price is shown to you first.</p>
            <label className="mt-3 flex cursor-pointer items-center gap-2.5 pl-6 text-[13px] text-paper">
              <input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} className="size-4 accent-[#ff5656]" />I understand, and I want this
            </label>
            <div className="mt-3 flex flex-wrap items-center gap-3 pl-6">
              <button
                type="button"
                disabled={!sure}
                onDoubleClick={() => {
                  setAsking(false);
                  void prefs({ spend: "all" }, true);
                }}
                className="press squircle inline-flex h-10 items-center rounded-[12px] bg-tally px-4 text-[13px] font-bold text-white disabled:opacity-40"
              >
                Double-click to allow everything
              </button>
              <button
                type="button"
                onClick={() => {
                  setAsking(false);
                  setRound((n) => n + 1);
                }}
                className="text-[13px] font-semibold text-haze hover:text-paper"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : null}
      </section>

      <section className="space-y-3">
        <Heading title="Pictures" note="What an agent looks at goes to that agent's own AI provider. Off, it gets file paths only." />
        <Toggle on={look.prefs.seePictures} onChange={(seePictures) => void prefs({ seePictures })} label="Agents can see my pictures" />
      </section>

      {look.remote ? (
        <section className="space-y-3">
          <Heading
            title="An agent on another computer"
            note="Start Crackio with CRACKIO_HOST=0.0.0.0 so your network can reach it, then run this there (Claude Code shown; other agents take the same program)."
            aside={
              <button
                type="button"
                onClick={() => void copyText(command).then((ok) => (setCopied(ok), setTimeout(() => setCopied(false), 1600)))}
                className="press h-8 rounded-btn bg-white/[0.06] px-3 text-[12.5px] font-semibold text-paper hover:bg-white/[0.1]"
              >
                {copied ? "Copied" : "Copy"}
              </button>
            }
          />
          <pre className="overflow-x-auto rounded-[12px] bg-black/30 px-3.5 py-3 font-mono text-[12px] leading-relaxed text-fog">{command}</pre>
        </section>
      ) : null}
    </div>
  );
}
