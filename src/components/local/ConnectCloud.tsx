"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Cloud, Copy, LoaderCircle, RefreshCw, TriangleAlert, X } from "lucide-react";
import { Switch } from "@/components/ui/Panel";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/cn";

type Step = { label: string; state: "doing" | "done" | "failed" | "skipped"; detail?: string };
type Job = { id: string; state: "running" | "done" | "error"; steps: Step[]; error?: string; todo?: string; machine?: string; label?: string };
type Box = {
  provider: "vast" | "runpod";
  id: string;
  label: string;
  gpu: string;
  state: string;
  /** Its cloud says it runs. */
  ready: boolean;
  /** Rented and on its way up. */
  starting?: boolean;
  /** Its cloud's own line about it, while it isn't up. */
  detail?: string;
  price?: number;
  connected?: boolean;
  /** Its connect job, under way. */
  connecting?: string;
  /** Why it didn't connect last time. */
  problem?: string;
};
type Info = {
  key: { key: string; own: boolean } | { error: string };
  accounts: { vast: boolean; runpod: boolean };
  boxes: Box[];
  errors?: Partial<Record<"vast" | "runpod", string>>;
  keyAdded?: Partial<Record<"vast" | "runpod", boolean>>;
  /** Boxes on the accounts connect by themselves. */
  autoConnect?: boolean;
};

const CLOUD_NAME = { vast: "vast.ai", runpod: "RunPod" } as const;
/** How often the accounts are looked at while this is on screen: a box you rent shows up, and connects, by itself. */
const LOOK_MS = 20_000;

/**
 * A rented GPU in one step: paste its SSH command or ComfyUI link, or let your cloud account bring it (it shows up and
 * connects by itself, or with Connect), and Crackio finds its address, adds the bridge, restarts ComfyUI and lists it
 * with your machines.
 */
export function ConnectCloud({ onConnected }: { onConnected: (machineId: string) => void }) {
  const [text, setText] = useState("");
  const [job, setJob] = useState<Job | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [info, setInfo] = useState<Info | null>(null);
  const [loadingBoxes, setLoadingBoxes] = useState(false);
  const [copied, setCopied] = useState(false);
  const poll = useRef<number | null>(null);

  const fetchInfo = useCallback(
    () =>
      fetch("/api/local/cloud", { cache: "no-store" })
        .then((res) => (res.ok ? (res.json() as Promise<Info>) : null))
        .then((next) => next && setInfo(next))
        .catch(() => undefined),
    [],
  );
  const loadInfo = useCallback(async () => {
    setLoadingBoxes(true);
    await fetchInfo();
    setLoadingBoxes(false);
  }, [fetchInfo]);

  useEffect(() => {
    void fetchInfo();
    return () => {
      if (poll.current) window.clearInterval(poll.current);
    };
  }, [fetchInfo]);

  // With an account connected: looked at again while the page is in view.
  const watching = Boolean(info && (info.accounts.vast || info.accounts.runpod));
  useEffect(() => {
    if (!watching) return;
    const id = window.setInterval(() => document.visibilityState === "visible" && void fetchInfo(), LOOK_MS);
    return () => window.clearInterval(id);
  }, [watching, fetchInfo]);

  // A box connecting by itself shows its steps here, unless another connect is shown.
  const autoJob = info?.boxes.find((b) => b.connecting)?.connecting;
  useEffect(() => {
    if (autoJob && (!job || job.state !== "running")) follow({ id: autoJob, state: "running", steps: [] });
    // Only when another box starts connecting, not on every step of the one shown.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoJob]);

  async function setAutoConnect(on: boolean) {
    setInfo((i) => (i ? { ...i, autoConnect: on } : i));
    await fetch("/api/local/cloud", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "auto-connect", on }) }).catch(() => null);
    void loadInfo();
  }

  function follow(started: Job) {
    setJob(started);
    if (poll.current) window.clearInterval(poll.current);
    poll.current = window.setInterval(async () => {
      const res = await fetch(`/api/local/cloud?job=${started.id}`, { cache: "no-store" }).catch(() => null);
      if (!res?.ok) return;
      const next = (await res.json()) as Job;
      setJob(next);
      if (next.state !== "running") {
        if (poll.current) window.clearInterval(poll.current);
        poll.current = null;
        if (next.state === "done" && next.machine) {
          setText("");
          onConnected(next.machine);
          void loadInfo();
        }
      }
    }, 1200);
  }

  async function start(body: Record<string, unknown>) {
    setProblem(null);
    const res = await fetch("/api/local/cloud", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    const out = (await res?.json().catch(() => null)) as (Job & { error?: string }) | null;
    if (!res?.ok || !out?.id) setProblem(out?.error ?? "That didn't work.");
    else follow(out);
  }

  async function addKey(provider: "vast" | "runpod") {
    setProblem(null);
    const res = await fetch("/api/local/cloud", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "add-key", provider }) }).catch(() => null);
    const out = (await res?.json().catch(() => null)) as { error?: string } | null;
    if (!res?.ok) setProblem(out?.error ?? "Couldn't add the key.");
    void loadInfo();
  }

  const running = job?.state === "running";
  const key = info && "key" in info.key ? info.key : null;
  const boxes = info?.boxes ?? [];
  const accounts = info ? (Object.keys(info.accounts) as ("vast" | "runpod")[]).filter((p) => info.accounts[p]) : [];

  return (
    <section className="surface squircle mt-3 flex flex-col gap-4 rounded-panel p-5" aria-label="Connect a cloud GPU">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-haze">
            <Cloud size={13} /> Cloud GPU
          </p>
          <h2 className="mt-1 font-display text-[22px] uppercase leading-tight">Connect a rented GPU</h2>
          <p className="mt-1 max-w-[86ch] text-[13px] leading-relaxed text-fog">
            Rent a GPU on vast.ai, RunPod or any cloud with its ComfyUI template, then paste its SSH command (or its ComfyUI link) here, or add your vast.ai or RunPod key in
            Connections and it shows up by itself. Crackio finds the address, adds its bridge and restarts ComfyUI, usually within a minute. Models then install on it from this
            page with your Hugging Face token, and every tool can run on it.
          </p>
        </div>
      </div>

      {accounts.length || boxes.length ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <p className="text-[12.5px] font-semibold text-fog">Running on your {accounts.map((p) => CLOUD_NAME[p]).join(" and ")} account{accounts.length > 1 ? "s" : ""}</p>
            <button onClick={() => void loadInfo()} className="press text-haze hover:text-paper" aria-label="Look again">
              <RefreshCw size={13} className={cn(loadingBoxes && "animate-spin")} />
            </button>
          </div>
          {boxes.length ? (
            <ul className="flex flex-col gap-1.5">
              {boxes.map((b) => (
                <li key={`${b.provider}-${b.id}`} className="flex flex-wrap items-center justify-between gap-2 rounded-[12px] bg-white/[0.03] px-3.5 py-2.5 text-[13px]">
                  <span className="min-w-0">
                    <span className="font-semibold text-paper">{b.gpu}</span>
                    <span className="text-haze">
                      {" "}
                      · {CLOUD_NAME[b.provider]} · {b.label} · {b.state}
                      {typeof b.price === "number" ? ` · $${b.price.toFixed(2)}/h` : ""}
                    </span>
                    {!b.ready && b.detail ? <span className="mt-0.5 block truncate text-[12px] text-haze">{b.detail}</span> : null}
                    {b.problem ? <span className="mt-0.5 block text-[12px] text-tally">Didn&rsquo;t connect: {b.problem}</span> : null}
                  </span>
                  {b.connected ? (
                    <span className="inline-flex items-center gap-1 text-[12.5px] font-semibold text-chroma">
                      <Check size={13} /> Connected
                    </span>
                  ) : b.connecting ? (
                    <button
                      onClick={() => follow({ id: b.connecting!, state: "running", steps: [] })}
                      className="press inline-flex h-8 items-center gap-1.5 rounded-[10px] px-3 text-[12.5px] font-semibold text-fog hover:text-paper"
                      title="Show its steps"
                    >
                      <LoaderCircle size={13} className="animate-spin text-spike" /> Connecting…
                    </button>
                  ) : (
                    <button
                      onClick={() => void start({ action: "connect-box", provider: b.provider, id: b.id })}
                      disabled={running || !(b.ready || b.starting)}
                      title={b.ready ? undefined : b.starting ? "Crackio waits until it's up, then connects it" : `It's ${b.state}: start it on ${CLOUD_NAME[b.provider]} first`}
                      className="press inline-flex h-8 items-center gap-1.5 rounded-[10px] bg-white/[0.08] px-3 text-[12.5px] font-semibold text-fog hover:text-paper disabled:opacity-50"
                    >
                      {b.ready ? "Connect" : b.starting ? "Connect when up" : "Not running"}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[12.5px] text-haze">No GPU running there right now: one you rent shows up here within half a minute.</p>
          )}
          {Object.entries(info?.errors ?? {}).map(([p, e]) => (
            <p key={p} className="text-[12.5px] text-tally">
              {CLOUD_NAME[p as "vast" | "runpod"]}: {e}
            </p>
          ))}
          {accounts.length ? (
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
              <Switch
                checked={info?.autoConnect !== false}
                onChange={(on) => void setAutoConnect(on)}
                label="Connect GPUs I rent by themselves"
                title="A GPU running on your account joins your machines without a click, and leaves them when you give it back"
              />
              <span className="text-[12px] text-haze">
                {info?.autoConnect !== false ? "Each one joins your machines on its own, and leaves when you give it back." : "Press Connect on each one you want."}
              </span>
            </div>
          ) : null}
        </div>
      ) : null}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) void start({ action: "connect", text });
        }}
        className="flex flex-col gap-2"
      >
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={2}
          placeholder={"ssh -p 41234 root@ssh5.vast.ai -L 8080:localhost:8080\nor https://abc123-8188.proxy.runpod.net"}
          aria-label="The GPU's SSH command or ComfyUI link"
          className="field-focus min-h-[64px] resize-y rounded-[12px] bg-white/[0.05] px-3 py-2.5 font-mono text-[12.5px] leading-relaxed text-paper outline-none placeholder:text-haze"
        />
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="submit"
            disabled={running || !text.trim()}
            className="press inline-flex h-9 items-center gap-1.5 rounded-[10px] bg-spike px-4 text-[13px] font-semibold text-spike-ink disabled:opacity-50"
          >
            {running ? <LoaderCircle size={14} className="animate-spin" /> : <Cloud size={14} />} Connect
          </button>
          {!accounts.length ? (
            <p className="text-[12.5px] text-haze">
              Or add your vast.ai or RunPod key in{" "}
              <Link href="/settings/connections" className="font-semibold text-fog underline-offset-2 hover:underline">
                Connections
              </Link>{" "}
              to pick your GPUs here.
            </p>
          ) : null}
        </div>
      </form>

      {problem ? (
        <p className="flex items-start gap-1.5 text-[12.5px] text-tally">
          <TriangleAlert size={14} className="mt-0.5 shrink-0" /> {problem}
        </p>
      ) : null}

      {job ? (
        <ol className="flex flex-col gap-1 rounded-[12px] bg-white/[0.03] px-3.5 py-3 text-[13px]" aria-live="polite">
          {job.steps.map((s, i) => (
            <li key={i} className="flex items-start gap-2">
              <span className="mt-0.5 shrink-0">
                {s.state === "doing" ? (
                  <LoaderCircle size={14} className="animate-spin text-spike" />
                ) : s.state === "done" ? (
                  <Check size={14} className="text-chroma" />
                ) : s.state === "failed" ? (
                  <X size={14} className="text-tally" />
                ) : (
                  <TriangleAlert size={14} className="text-tungsten" />
                )}
              </span>
              <span className={cn("min-w-0", s.state === "doing" ? "text-paper" : "text-fog")}>
                {s.label}
                {s.detail ? <span className="text-haze"> · {s.detail}</span> : null}
              </span>
            </li>
          ))}
          {job.todo ? <li className="mt-1 text-[12.5px] font-semibold text-tungsten">{job.todo}</li> : null}
          {job.state === "error" ? <li className="mt-1 text-[12.5px] text-tally">{job.error}</li> : null}
          {job.state === "done" ? <li className="mt-1 text-[12.5px] font-semibold text-chroma">{job.label} is ready: pick it above to install models on it.</li> : null}
        </ol>
      ) : null}

      {key ? (
        <div className="flex flex-col gap-1.5 text-[12.5px] leading-relaxed text-haze">
          <p>
            Crackio logs in with this SSH key. Add it to your cloud account once (vast.ai: Account → SSH Keys; RunPod: Settings → SSH Public Keys), and every GPU you rent there
            takes it.
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            <code className="min-w-0 max-w-full flex-1 truncate rounded-[8px] bg-white/[0.04] px-2.5 py-1.5 font-mono text-[11.5px] text-fog">{key.key}</code>
            <button
              onClick={async () => {
                await copyText(key.key);
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1500);
              }}
              className="press inline-flex h-8 items-center gap-1.5 rounded-[10px] bg-white/[0.06] px-3 font-semibold text-fog hover:text-paper"
            >
              {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? "Copied" : "Copy"}
            </button>
            {accounts.map((p) =>
              info?.keyAdded?.[p] ? (
                <span key={p} className="inline-flex items-center gap-1 font-semibold text-chroma">
                  <Check size={13} /> On {CLOUD_NAME[p]}
                </span>
              ) : (
                <button key={p} onClick={() => void addKey(p)} className="press inline-flex h-8 items-center rounded-[10px] bg-white/[0.06] px-3 font-semibold text-fog hover:text-paper">
                  Add to {CLOUD_NAME[p]}
                </button>
              ),
            )}
          </div>
        </div>
      ) : info && "error" in info.key ? (
        <p className="text-[12.5px] text-tally">{info.key.error}</p>
      ) : null}
    </section>
  );
}
