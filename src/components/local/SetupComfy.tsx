"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpRight, Cpu, Download, FolderOpen, LoaderCircle, Play, Plug, Square, Terminal, Trash2, TriangleAlert, Zap } from "lucide-react";
import type { SetupStatus } from "@/lib/server/comfy-install";
import { cn } from "@/lib/cn";

export type SetupComfyProps = {
  /** Called with the new status when ComfyUI gets installed or removed, or starts or stops (reload the Local page's status then). */
  onChange?: (status: SetupStatus) => void;
  className?: string;
};

const ACTIVE = new Set<SetupStatus["state"]>(["installing", "uninstalling", "starting", "stopping"]);

const gb = (n: number | null | undefined) => (n == null ? "?" : `${n < 10 ? n.toFixed(1).replace(/\.0$/, "") : Math.round(n)} GB`);

function duration(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} min ${s % 60} s` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** "PyTorch 2.14.1 · CUDA 12.6" from the installed version and the CUDA (or ROCm) it was built for. */
function torchLabel(s: SetupStatus) {
  if (!s.torch) return null;
  const [version, build = ""] = s.torch.split("+");
  const on = build.startsWith("cu") ? `CUDA ${s.cuda ?? build.slice(2)}` : build.startsWith("rocm") ? `ROCm ${build.slice(4)}` : build === "xpu" ? "Intel XPU" : build === "cpu" ? "CPU only" : "";
  return `PyTorch ${version}${on ? ` · ${on}` : ""}`;
}

function useSetup() {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(0);
  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/local/setup", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStatus(await res.json());
      setNow(Date.now());
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);
  const active = status ? ACTIVE.has(status.state) : false;
  useEffect(() => {
    const tick = () => void load();
    const first = setTimeout(tick, 0);
    const id = setInterval(tick, active ? 1500 : 10000);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [load, active]);
  const apply = useCallback((next: SetupStatus) => {
    setStatus(next);
    setNow(Date.now());
  }, []);
  return { status, error, now, apply, reload: load };
}

/**
 * ComfyUI on this computer: when there is none, what Crackio would install for this hardware and why, and an Install
 * button that does all of it in the background (Python, ComfyUI, the right PyTorch, the Crackio bridge) with its
 * progress and log. Once installed: Start and Stop, its address, and Uninstall.
 */
export function SetupComfy({ onChange, className }: SetupComfyProps) {
  const { status, error, now, apply, reload } = useSetup();
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // "Restart it if it crashes", chosen while ComfyUI is stopped: sent with Start.
  const [keep, setKeep] = useState<boolean | null>(null);

  // Tell the page when what it can run changes.
  const seen = useRef<string | null>(null);
  useEffect(() => {
    if (!status) return;
    const key = `${status.installed}/${status.running}`;
    if (seen.current !== null && seen.current !== key) onChange?.(status);
    seen.current = key;
  }, [status, onChange]);

  async function act(body: Record<string, unknown>) {
    setWorking(true);
    setProblem(null);
    try {
      const res = await fetch("/api/local/setup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const json = (await res.json().catch(() => ({}))) as SetupStatus & { error?: string };
      if (!res.ok) setProblem(json.error ?? "That didn't work.");
      else apply(json);
    } catch (err) {
      setProblem((err as Error).message);
    } finally {
      setWorking(false);
      void reload();
    }
  }

  if (!status) {
    return error ? (
      <p className={cn("flex items-center gap-2 rounded-[12px] bg-tally/10 px-4 py-3 text-[13.5px] text-tally", className)}>
        <TriangleAlert size={15} /> Couldn&rsquo;t check for ComfyUI on this computer: {error}
      </p>
    ) : (
      <div className={cn("skeleton h-[188px] rounded-panel", className)} />
    );
  }

  const s = status;
  const live = s.running || s.state === "starting";
  const keepAlive = live ? s.keepAlive : (keep ?? s.keepAlive);
  const busy = s.state === "installing" || s.state === "uninstalling";
  const failed = Boolean(s.job?.finishedAt && s.error && s.logOf === "install");
  const roomy = s.freeGb == null || s.freeGb >= s.plan.diskGb + 1;

  return (
    <section className={cn("surface squircle flex flex-col gap-4 rounded-panel p-5", className)}>
      <Header status={s} />

      {busy ? (
        <Progress status={s} now={now} />
      ) : !s.installed ? (
        <Plan status={s} roomy={roomy} />
      ) : (
        <Installed status={s} />
      )}

      {s.share && s.lanUrl ? (
        <p className="rounded-[12px] bg-white/[0.03] px-3.5 py-2.5 text-[12.5px] leading-relaxed text-haze">
          On your other computer, open Crackio&rsquo;s Local page and add <code className="text-paper">{s.lanUrl}</code> under &ldquo;Use another computer&rdquo;. Its jobs then
          run here when this machine has the model. Windows may ask once to let Python through its firewall: allow it on private networks.
        </p>
      ) : null}

      {problem || (!busy && s.error) ? (
        <p className="flex items-start gap-1.5 text-[12.5px] leading-relaxed text-tally">
          <TriangleAlert size={14} className="mt-0.5 shrink-0" /> {problem ?? s.error}
        </p>
      ) : null}

      {busy || failed || s.state === "starting" || (showLog && s.log.length) ? <LogBox lines={s.log} /> : null}

      {confirming ? (
        <div className="flex flex-wrap items-center gap-2 rounded-[12px] bg-tally/10 px-3.5 py-3 text-[13px] text-paper">
          <span className="mr-auto">
            Delete <code className="text-fog">{s.path}</code> and everything in it, models included?
          </span>
          <button
            onClick={() => (setConfirming(false), void act({ action: "uninstall", confirm: true }))}
            className="press h-9 rounded-[10px] bg-tally px-3.5 text-[12.5px] font-semibold text-[#1b0a0e]"
          >
            Delete it
          </button>
          <button onClick={() => setConfirming(false)} className="press h-9 rounded-[10px] bg-white/[0.06] px-3.5 text-[12.5px] font-semibold text-fog hover:text-paper">
            Keep it
          </button>
        </div>
      ) : null}

      {busy ? null : (
        <div className="flex flex-wrap items-center gap-2">
          {!s.installed ? (
            <button
              onClick={() => act({ action: "install" })}
              disabled={working || !s.plan.supported || !roomy}
              className="lip squircle inline-flex h-10 items-center gap-2 rounded-[12px] bg-spike px-4 text-[13px] font-bold uppercase tracking-[0.04em] text-spike-ink [--lip:var(--color-spike-lip)] hover:bg-spike-hi disabled:opacity-60"
            >
              {working ? <LoaderCircle size={15} className="animate-spin" /> : <Download size={15} />}
              {failed || s.partial ? "Finish installing" : "Install ComfyUI"} · {gb(s.plan.diskGb)}
            </button>
          ) : s.running ? (
            <>
              <a href={s.url ?? "#"} target="_blank" rel="noreferrer" className="press squircle inline-flex h-10 items-center gap-1.5 rounded-[12px] bg-paper px-4 text-[13px] font-semibold text-[#16171a]">
                Open ComfyUI <ArrowUpRight size={14} />
              </a>
              <button onClick={() => act({ action: "stop" })} disabled={working} className="press inline-flex h-10 items-center gap-1.5 rounded-[12px] bg-white/[0.06] px-3.5 text-[13px] font-semibold text-fog hover:text-paper disabled:opacity-60">
                {working ? <LoaderCircle size={14} className="animate-spin" /> : <Square size={13} />} Stop
              </button>
            </>
          ) : s.state === "starting" || s.state === "stopping" ? (
            <span className="inline-flex h-10 items-center gap-2 text-[13px] text-fog">
              <LoaderCircle size={15} className="animate-spin" /> {s.state === "starting" ? "Starting ComfyUI: its first start takes a minute." : "Stopping ComfyUI…"}
            </span>
          ) : (
            <button
              onClick={() => act({ action: "start", keepAlive })}
              disabled={working}
              className="lip squircle inline-flex h-10 items-center gap-2 rounded-[12px] bg-spike px-4 text-[13px] font-bold uppercase tracking-[0.04em] text-spike-ink [--lip:var(--color-spike-lip)] hover:bg-spike-hi disabled:opacity-60"
            >
              {working ? <LoaderCircle size={15} className="animate-spin" /> : <Play size={14} />} {failed ? "Try starting it" : "Start"}
            </button>
          )}

          {s.installed ? (
            <label className="ml-1 inline-flex cursor-pointer select-none items-center gap-2 text-[12.5px] text-haze">
              <input
                type="checkbox"
                checked={keepAlive}
                disabled={working || s.state === "stopping"}
                onChange={(e) => (live ? void act({ action: "start", keepAlive: e.target.checked }) : setKeep(e.target.checked))}
                className="size-3.5 accent-[var(--color-spike)]"
              />
              Restart it if it crashes
            </label>
          ) : null}
          {s.installed ? (
            <label
              className="ml-1 inline-flex cursor-pointer select-none items-center gap-2 text-[12.5px] text-haze"
              title="ComfyUI has no password: share it only on a network you trust (your home's)."
            >
              <input
                type="checkbox"
                checked={s.share}
                disabled={working || s.state === "stopping"}
                onChange={(e) => void act({ action: "start", share: e.target.checked, keepAlive })}
                className="size-3.5 accent-[var(--color-spike)]"
              />
              Let my other computers use it
            </label>
          ) : null}

          <span className="ml-auto flex items-center gap-1">
            {s.installed && s.log.length && !(failed || s.state === "starting") ? (
              <button onClick={() => setShowLog((v) => !v)} aria-pressed={showLog} className="press inline-flex h-9 items-center gap-1.5 rounded-[10px] px-2.5 text-[12.5px] font-semibold text-haze hover:bg-white/[0.05] hover:text-paper">
                <Terminal size={14} /> {showLog ? "Hide log" : "Log"}
              </button>
            ) : null}
            {s.installed || s.partial ? (
              <button
                onClick={() => setConfirming(true)}
                disabled={working}
                aria-label="Uninstall ComfyUI"
                title="Uninstall: deletes its folder"
                className="press grid size-9 place-items-center rounded-[10px] text-haze hover:bg-white/[0.05] hover:text-paper"
              >
                <Trash2 size={15} />
              </button>
            ) : null}
          </span>
        </div>
      )}
    </section>
  );
}

const STATE_STYLE: Record<SetupStatus["state"], { title: string; pill: string; className: string }> = {
  "not-installed": { title: "Not installed yet", pill: "Not installed", className: "bg-white/[0.06] text-haze" },
  installing: { title: "Installing ComfyUI", pill: "Installing", className: "bg-spike/15 text-spike" },
  uninstalling: { title: "Removing ComfyUI", pill: "Removing", className: "bg-white/[0.06] text-fog" },
  stopped: { title: "Installed", pill: "Stopped", className: "bg-white/[0.06] text-haze" },
  starting: { title: "Starting", pill: "Starting", className: "bg-tungsten/15 text-tungsten" },
  running: { title: "Running", pill: "Running", className: "bg-chroma/15 text-chroma" },
  stopping: { title: "Stopping", pill: "Stopping", className: "bg-white/[0.06] text-fog" },
  crashed: { title: "Stopped working", pill: "Crashed", className: "bg-tally/15 text-tally" },
};

function Header({ status: s }: { status: SetupStatus }) {
  const style = STATE_STYLE[s.state];
  const title = s.state === "not-installed" && s.partial ? "Install not finished" : style.title;
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="text-[12px] font-semibold uppercase tracking-[0.08em] text-haze">ComfyUI on this computer</p>
        <h2 className="mt-1 truncate font-display text-[22px] uppercase leading-tight">{title}</h2>
        {s.running && s.url ? (
          <a href={s.url} target="_blank" rel="noreferrer" className="mt-0.5 inline-flex items-center gap-1 text-[13px] text-fog underline-offset-2 hover:text-paper hover:underline">
            {s.url.replace(/^https?:\/\//, "")} <ArrowUpRight size={13} />
          </a>
        ) : null}
      </div>
      <span className={cn("shrink-0 rounded-full px-2.5 py-1 text-[12px] font-semibold", style.className)}>{s.state === "installing" && s.progress != null ? `${s.progress}%` : style.pill}</span>
    </div>
  );
}

/** What Crackio would install here, and why. */
function Plan({ status: s, roomy }: { status: SetupStatus; roomy: boolean }) {
  const plan = s.plan;
  if (!plan.supported) return <p className="text-[13.5px] leading-relaxed text-fog">{plan.reason}</p>;
  return (
    <>
      <p className="text-[13.5px] leading-relaxed text-fog">
        No ComfyUI on this computer yet. Crackio installs it for you, in one folder of its own: Python {plan.python}, ComfyUI, the PyTorch build your GPU needs, and the Crackio
        bridge. Nothing else on your system changes, and removing the folder removes all of it.
      </p>
      <dl className="grid gap-3 text-[12px] sm:grid-cols-3">
        <Fact label="Installs" value={plan.label} note={plan.gpu ? plan.gpu.name.replace(/^NVIDIA (GeForce )?/i, "") : "No GPU"} />
        <Fact label="Where" value={s.path} note={s.pathWhy} />
        <Fact label="Needs" value={`About ${gb(plan.diskGb)}`} note={`${gb(plan.downloadGb)} download · ${gb(s.freeGb)} free there`} />
      </dl>
      <p className="rounded-[12px] bg-white/[0.03] px-3 py-2.5 text-[12.5px] leading-relaxed text-haze">
        <span className="font-semibold text-fog">Why this PyTorch: </span>
        {plan.reason}
      </p>
      {plan.warnings.map((w) => (
        <p key={w} className="flex items-start gap-1.5 text-[12.5px] leading-relaxed text-tungsten">
          <TriangleAlert size={14} className="mt-0.5 shrink-0" /> {w}
        </p>
      ))}
      {!roomy ? (
        <p className="text-[12.5px] text-tungsten">
          It needs about {gb(plan.diskGb)} free there and there {s.freeGb === 1 ? "is" : "are"} {gb(s.freeGb)}. Free some space, then reload.
        </p>
      ) : null}
    </>
  );
}

function Fact({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-haze">{label}</dt>
      <dd className="mt-0.5 break-words text-[14px] font-semibold text-paper">{value}</dd>
      {note ? <dd className="mt-0.5 leading-relaxed text-haze">{note}</dd> : null}
    </div>
  );
}

function Progress({ status: s, now }: { status: SetupStatus; now: number }) {
  const elapsed = s.job ? (s.job.finishedAt ?? now) - s.job.startedAt : 0;
  return (
    <div>
      <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.07]">
        <div className="h-full rounded-full bg-spike transition-[width] duration-700" style={{ width: `${Math.max(2, s.progress ?? 0)}%` }} />
      </div>
      <div className="mt-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-[12.5px]">
        <p className="font-semibold text-paper">
          {s.stage}
          {s.detail ? <span className="font-normal text-haze"> · {s.detail}</span> : null}
        </p>
        <p className="tabular text-haze">
          {s.step ? `Step ${s.step.index} of ${s.step.count} · ` : ""}
          {duration(elapsed)}
        </p>
      </div>
      {s.state === "installing" ? (
        <p className="mt-1 text-[12px] text-haze">
          Into <code className="text-fog">{s.path}</code>. You can leave this page: it keeps going.
        </p>
      ) : null}
    </div>
  );
}

function Installed({ status: s }: { status: SetupStatus }) {
  const torch = torchLabel(s);
  return (
    <ul className="flex flex-wrap gap-1.5 text-[12.5px] text-fog">
      {s.device ? <Chip icon={Cpu}>{s.device.replace(/^NVIDIA (GeForce )?/i, "")}</Chip> : null}
      {torch ? <Chip icon={Zap}>{torch}</Chip> : null}
      {s.comfyui ? <Chip icon={Plug}>ComfyUI {s.comfyui}</Chip> : null}
      {s.python ? <Chip icon={Terminal}>Python {s.python}</Chip> : null}
      <Chip icon={FolderOpen}>
        <span className="max-w-[28ch] truncate" title={s.path}>
          {s.path}
        </span>
      </Chip>
    </ul>
  );
}

function Chip({ icon: Icon, children }: { icon: typeof Cpu; children: React.ReactNode }) {
  return (
    <li className="inline-flex h-7 min-w-0 items-center gap-1.5 rounded-full bg-white/[0.05] px-2.5">
      <Icon size={13} className="shrink-0 text-haze" />
      {children}
    </li>
  );
}

/** The log's last lines, kept scrolled to the end unless you scroll up to read. */
function LogBox({ lines }: { lines: string[] }) {
  const ref = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines]);
  if (!lines.length) return null;
  return (
    <pre
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
      className="max-h-[220px] overflow-auto whitespace-pre-wrap break-all rounded-[12px] bg-black/30 px-3 py-2.5 font-mono text-[11.5px] leading-relaxed text-haze"
    >
      {lines.join("\n")}
    </pre>
  );
}
