"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, Cloud, Cpu, LoaderCircle, Monitor, RefreshCw, TriangleAlert } from "lucide-react";
import { AppIcon } from "@/components/ui/ToolTile";
import type { LocalStatus, Machine, TargetStatus } from "@/lib/local/types";
import { cn } from "@/lib/cn";

const PICKED = "crackio.comfy.machine";
const read = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const write = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private window */
  }
};

/** A machine's card title: its GPU, short. */
const gpuOf = (m: Machine | undefined) => (m?.gpus[0]?.name ?? "").replace(/^NVIDIA\s+(GeForce\s+)?/i, "").replace(/^Apple\s+/i, "") || null;

/**
 * ComfyUI's own interface on each of your machines that's online: this computer's, another on your network, a rented GPU.
 * Through Crackio's relay (server/comfy-relay) every one opens the same way, the rented one with its token already in. A
 * job Crackio runs there opens as its own tab of nodes, lighting up as they run; the rest is plain ComfyUI.
 */
export function ComfyView() {
  const params = useSearchParams();
  const asked = params.get("machine") ?? undefined;
  const job = params.get("job") ?? undefined;
  // A Library item's graph to open (?recipe=<its id>&step=N, from its "How it was made"), on whichever machine is open.
  const recipe = params.get("recipe") ?? undefined;
  const step = params.get("step") ?? undefined;
  const [status, setStatus] = useState<LocalStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(asked ?? null);
  const [relay, setRelay] = useState<{ machine: string; port: number } | null>(null);
  const [relayError, setRelayError] = useState<string | null>(null);
  // Opening a take's graph, a job starting meanwhile doesn't take its place.
  const [follow, setFollow] = useState(!recipe);
  const [frameKey, setFrameKey] = useState(0);
  const frame = useRef<HTMLIFrameElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/local", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStatus((await res.json()) as LocalStatus);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(() => void load(), 0);
    const id = setInterval(load, 15_000);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [load]);

  const targets = useMemo(() => status?.targets ?? [], [status]);
  const online = useMemo(() => targets.filter((t) => t.connected), [targets]);
  const machineOf = (t: TargetStatus) => status?.machines.find((m) => m.target === t.id);
  // The one asked for, else the one you had open last, else the first online. The one open stays open when it misses a
  // check (a busy box can answer late): the page says so instead of switching machines.
  const wanted = picked ?? read(PICKED);
  const current =
    targets.find((t) => t.id === wanted && (t.connected || t.id === relay?.machine)) ?? targets.find((t) => t.id === relay?.machine) ?? online[0] ?? null;

  useEffect(() => {
    if (!current || relay?.machine === current.id) return;
    let cancelled = false;
    fetch(`/api/comfy/relay?machine=${encodeURIComponent(current.id)}`, { cache: "no-store" })
      .then(async (res) => {
        const body = (await res.json()) as { port?: number; error?: string };
        if (cancelled) return;
        if (!res.ok || !body.port) setRelayError(body.error ?? "The relay didn't start.");
        else {
          setRelayError(null);
          setRelay({ machine: current.id, port: body.port });
        }
      })
      .catch((err: Error) => !cancelled && setRelayError(err.message));
    return () => {
      cancelled = true;
    };
  }, [current, relay?.machine]);

  const src = relay && current && relay.machine === current.id ? frameUrl(relay.port, follow, current.id === asked ? job : undefined, recipe ? { recipe, step } : undefined) : null;

  function pick(id: string) {
    setPicked(id);
    write(PICKED, id);
  }

  function setFollowing(on: boolean) {
    setFollow(on);
    frame.current?.contentWindow?.postMessage({ type: "crackio:follow", on }, "*");
  }

  return (
    <div className="mx-auto flex h-[calc(100dvh-3.5rem)] max-w-[2400px] flex-col px-4 pb-4 pt-5 sm:px-6 lg:h-dvh lg:px-8">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex items-start gap-3">
          <AppIcon glyph="/icons/comfy.png" size={32} className="mt-0.5" />
          <div className="min-w-0">
            <h1 className="font-display text-[28px] leading-none sm:text-[30px]">ComfyUI</h1>
            <p className="mt-1.5 max-w-[80ch] text-[13.5px] leading-relaxed text-haze">
              ComfyUI itself on each of your machines that&rsquo;s online. A job Crackio runs there opens as its own tab of nodes, lighting up as they run; everything else is
              plain ComfyUI.
            </p>
          </div>
        </div>
        {current && src ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <label className="press inline-flex h-9 cursor-pointer items-center gap-2 rounded-full bg-white/[0.05] px-3.5 text-[12.5px] font-semibold text-fog hover:text-paper">
              <input type="checkbox" checked={follow} onChange={(e) => setFollowing(e.target.checked)} className="accent-[var(--color-spike)]" />
              Open Crackio&rsquo;s jobs as they start
            </label>
            <button
              onClick={() => setFrameKey((k) => k + 1)}
              className="press inline-flex h-9 items-center gap-1.5 rounded-full bg-white/[0.05] px-3.5 text-[12.5px] font-semibold text-fog hover:text-paper"
            >
              <RefreshCw size={13} /> Reload
            </button>
            <a href={src} target="_blank" rel="noreferrer" className="press inline-flex h-9 items-center gap-1.5 rounded-full bg-white/[0.05] px-3.5 text-[12.5px] font-semibold text-fog hover:text-paper">
              New tab <ArrowUpRight size={13} />
            </a>
          </div>
        ) : null}
      </header>

      {online.length > 1 || (online.length === 1 && status && status.targets.some((t) => !t.connected && !t.implicit)) ? (
        <div className="mt-4 flex flex-wrap gap-1.5" role="tablist" aria-label="Machines">
          {(status?.targets ?? [])
            .filter((t) => t.connected || !t.implicit)
            .map((t) => {
              const m = machineOf(t);
              const Icon = t.cloud ? Cloud : t.onThisComputer ? Monitor : Cpu;
              const on = current?.id === t.id;
              return (
                <button
                  key={t.id}
                  role="tab"
                  aria-selected={on}
                  disabled={!t.connected}
                  onClick={() => pick(t.id)}
                  className={cn(
                    "press inline-flex h-10 items-center gap-2 rounded-full px-3.5 text-[13px] font-semibold disabled:cursor-not-allowed disabled:opacity-45",
                    on ? "bg-spike/15 text-spike shadow-[inset_0_0_0_1px_var(--color-spike)]" : "bg-white/[0.05] text-fog hover:text-paper",
                  )}
                  title={t.connected ? t.url : `${t.label} isn't answering`}
                >
                  <span className={cn("size-1.5 rounded-full", t.connected ? "bg-chroma" : "bg-haze")} />
                  <Icon size={14} />
                  {t.source === "installed" ? "This computer" : t.label}
                  {gpuOf(m) && !t.label.includes(gpuOf(m)!) ? <span className="font-normal text-haze">{gpuOf(m)}</span> : null}
                </button>
              );
            })}
        </div>
      ) : null}

      {current && !current.connected ? (
        <p className="mt-3 flex items-center gap-2 rounded-[12px] bg-white/[0.03] px-4 py-2 text-[12.5px] text-haze">
          <TriangleAlert size={14} className="shrink-0 text-tungsten" /> {current.label} didn&rsquo;t answer Crackio&rsquo;s last check: it may be busy, or stopped.
        </p>
      ) : null}

      <div className="surface squircle mt-4 min-h-[420px] flex-1 overflow-hidden rounded-panel">
        {!status && !error ? (
          <div className="grid h-full place-items-center text-haze">
            <LoaderCircle size={20} className="animate-spin" />
          </div>
        ) : error && !status ? (
          <Empty icon={<TriangleAlert size={18} />} title="Couldn't read your machines" body={error} />
        ) : !current ? (
          <Empty
            icon={<Monitor size={18} />}
            title="No ComfyUI is running"
            body={
              <>
                Start ComfyUI on this computer, or connect another machine or a rented GPU on the{" "}
                <Link href="/local" className="font-semibold text-fog underline-offset-2 hover:underline">
                  Local page
                </Link>
                .
              </>
            }
          />
        ) : relayError ? (
          <Empty icon={<TriangleAlert size={18} />} title={`Couldn't open ${current.label}`} body={relayError} />
        ) : src ? (
          <iframe key={`${src}#${frameKey}`} ref={frame} src={src} title={`ComfyUI on ${current.label}`} className="size-full border-0 bg-[#202020]" allow="clipboard-read; clipboard-write; fullscreen" />
        ) : (
          <div className="grid h-full place-items-center text-haze">
            <LoaderCircle size={20} className="animate-spin" />
          </div>
        )}
      </div>
    </div>
  );
}

/** The relay's address as this browser reaches Crackio (another device on the network gets its own way in). */
function frameUrl(port: number, follow: boolean, job?: string, kept?: { recipe: string; step?: string }) {
  const q = new URLSearchParams({
    crackio_follow: follow ? "1" : "0",
    ...(job ? { crackio_prompt: job } : {}),
    ...(kept ? { crackio_recipe: kept.recipe, ...(kept.step ? { crackio_step: kept.step } : {}) } : {}),
  });
  return `${window.location.protocol}//${window.location.hostname}:${port}/?${q}`;
}

function Empty({ icon, title, body }: { icon: React.ReactNode; title: string; body: React.ReactNode }) {
  return (
    <div className="grid h-full place-items-center p-6 text-center">
      <div className="max-w-[46ch]">
        <span className="mx-auto grid size-10 place-items-center rounded-full bg-white/[0.05] text-fog">{icon}</span>
        <p className="mt-3 text-[15px] font-semibold text-paper">{title}</p>
        <p className="mt-1 text-[13px] leading-relaxed text-haze">{body}</p>
      </div>
    </div>
  );
}
