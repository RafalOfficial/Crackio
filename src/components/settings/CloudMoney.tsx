"use client";

import { useState } from "react";
import { LoaderCircle, Power, Trash2, TriangleAlert, Wallet } from "lucide-react";
import { useSetupStore } from "@/lib/hooks/use-setup";
import type { CloudCredit, LiveGpu, SetupMachine, SetupSnapshot } from "@/lib/setup/types";
import { cn } from "@/lib/cn";
import { Segmented, usd } from "./EstimatePanel";
import { bytesText } from "./words";

/**
 * What rented GPUs cost: each cloud account's credit and how long it lasts at what its running boxes cost now, and on a
 * rented box's page its price, an idle stop (after how many minutes, and under what GPU load it counts as idle) and
 * Stop / Start, on vast.ai and RunPod alike. Stopping keeps the box's disk; Start brings it back and Crackio connects to
 * it again by itself.
 */

const CLOUD = { vast: "vast.ai", runpod: "RunPod" } as const;

/** "03:13" in the viewer's own clock. */
const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const hoursWords = (h: number) => (h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : h < 48 ? `${h.toFixed(h < 10 ? 1 : 0)} h` : `${Math.round(h / 24)} days`);

/** One line per account: "vast.ai credit $1.56 · 1 box at $0.53/h · lasts about 2.9 h, until 03:13". */
export function CreditLine({ credit, className }: { credit: CloudCredit[]; className?: string }) {
  if (!credit.length) return null;
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      {credit.map((c) => {
        const low = c.hoursLeft !== null && c.hoursLeft < 2;
        return (
          <p key={c.provider} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px] text-fog">
            <Wallet size={14} className={low ? "text-tungsten" : "text-haze"} />
            <span>
              {CLOUD[c.provider]} credit <span className="font-semibold tabular text-paper">{usd(c.balance)}</span>
            </span>
            <span className="text-haze">
              · {c.running ? `${c.running} ${c.running === 1 ? "box" : "boxes"} running at ${usd(c.perHour)}/h` : "nothing running"}
            </span>
            {c.hoursLeft !== null && c.until !== null ? (
              <span className={low ? "font-semibold text-tungsten" : "text-haze"}>
                · lasts about {hoursWords(c.hoursLeft)}, until {clock(c.until)}
              </span>
            ) : null}
          </p>
        );
      })}
    </div>
  );
}

async function post(body: Record<string, unknown>) {
  const res = await fetch("/api/setup/cloud", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
  const out = (await res?.json().catch(() => ({}))) as { error?: string; autoStop?: SetupSnapshot["autoStop"] };
  // The rule as saved shows at once: a fresh look at every machine can take several seconds.
  const snap = useSetupStore.getState().snap;
  if (res?.ok && out.autoStop && snap) useSetupStore.setState({ snap: { ...snap, autoStop: out.autoStop } });
  await useSetupStore.getState().reload(true);
  return res?.ok ? null : (out.error ?? "Crackio didn't answer.");
}

/** The box key a rented machine goes by: "vast:58824818", or null when Crackio doesn't know its cloud. */
export const boxOf = (m: SetupMachine) => (m.cloud?.instance && (m.cloud.provider === "vast" || m.cloud.provider === "runpod") ? `${m.cloud.provider}:${m.cloud.instance}` : null);

/** Start a stopped rented box again. */
export function StartBox({ m }: { m: SetupMachine }) {
  const box = boxOf(m);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!box) return null;
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(await post({ action: "start", box }));
          setBusy(false);
        }}
        className="press inline-flex h-9 items-center gap-1.5 rounded-[11px] bg-spike px-3.5 text-[13px] font-bold text-spike-ink hover:bg-spike-hi disabled:opacity-60"
      >
        {busy ? <LoaderCircle size={14} className="animate-spin" /> : <Power size={14} />} Start it
      </button>
      {error ? <span className="text-[12px] text-tally">{error}</span> : null}
    </span>
  );
}

const minutesWords = (n: number) => (n % 60 === 0 ? `${n / 60} h` : `${n} min`);
const STOPS = [0, 10, 15, 30, 60, 120];
const LOADS = [5, 10, 25, 50];
/** The presets, plus a value set some other way (the API takes any minutes or load) so it still shows as picked. */
const withOwn = (presets: number[], own: number | undefined) => (own != null && !presets.includes(own) ? [...presets, own].sort((a, b) => a - b) : presets);

/** What stopping means on each cloud, said before you turn it on. */
const WHILE_STOPPED = {
  vast: "While it's stopped, vast.ai bills only its disk, and someone else can rent its GPU: Start then waits until it's free.",
  runpod: "While it's stopped, RunPod keeps only its /workspace volume (where Crackio installs) and bills its storage; Start needs its GPU free again.",
} as const;

/**
 * A rented box's cost and its idle stop: after how long, under what GPU load it counts as idle, and then stop it or
 * delete it (for a box rented for one go; asked for with a warning first, as nothing brings a deleted box back).
 */
export function CostPanel({ m, snap, live }: { m: SetupMachine; snap: SetupSnapshot; live?: LiveGpu }) {
  const box = boxOf(m);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [askDelete, setAskDelete] = useState(false);
  if (!box || m.kind !== "rented") return null;
  const provider = m.cloud!.provider as "vast" | "runpod";
  const rule = snap.autoStop[box];
  const act = async (name: string, body: Record<string, unknown>) => {
    setBusy(name);
    setError(await post(body));
    setBusy(null);
    setConfirm(false);
  };
  const idle = rule?.idleMinutes ?? null;
  const wasted = idle !== null && m.pricePerHour ? (idle / 60) * m.pricePerHour : null;
  const util = live?.online && live.util != null ? Math.round(live.util) : null;
  return (
    <section aria-label="Cost" className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-[14px] font-semibold text-paper">Cost</h3>
        <span className="text-[12.5px] text-haze">
          {m.pricePerHour ? `${usd(m.pricePerHour)} an hour on ${CLOUD[provider]}` : `Its price on ${CLOUD[provider]} isn't known yet`}
        </span>
      </div>
      <div className="grid grid-cols-[minmax(0,max-content)_minmax(0,1fr)] items-center gap-x-3 gap-y-2.5 max-sm:grid-cols-1">
        <span className="text-[13px] text-fog">{rule?.then === "delete" ? "Delete it when idle for" : "Stop it when idle for"}</span>
        <span className="flex flex-wrap items-center gap-2">
          <Segmented
            label={rule?.then === "delete" ? "Delete it when idle for" : "Stop it when idle for"}
            value={rule?.minutes ?? 0}
            options={withOwn(STOPS, rule?.minutes ?? undefined).map((v) => ({ value: v, label: v ? minutesWords(v) : "Off" }))}
            onChange={(v) => void act("rule", { action: "auto-stop", box, minutes: v ? v : null })}
          />
          {busy === "rule" ? <LoaderCircle size={14} className="animate-spin text-haze" /> : null}
        </span>
        {rule ? (
          <>
            <span className="text-[13px] text-fog">Idle means GPU load under</span>
            <span className="flex flex-wrap items-center gap-2">
              <Segmented
                label="Idle means GPU load under"
                value={rule.load}
                options={withOwn(LOADS, rule.load).map((v) => ({ value: v, label: `${v}%` }))}
                onChange={(v) => void act("load", { action: "auto-stop", box, minutes: rule.minutes, load: v })}
              />
              {busy === "load" ? <LoaderCircle size={14} className="animate-spin text-haze" /> : null}
              {util !== null ? (
                <span className={cn("text-[12.5px] tabular", live?.working || util >= rule.load ? "text-paper" : "text-haze")}>
                  Now {util}%{live?.working ? ", ComfyUI working" : util >= rule.load ? ", in use" : ""}
                </span>
              ) : null}
            </span>
            <span className="text-[13px] text-fog">Then</span>
            <span className="flex flex-wrap items-center gap-2">
              <Segmented
                label="Then"
                value={askDelete ? "delete" : rule.then}
                options={[
                  { value: "stop", label: "Stop it" },
                  { value: "delete", label: "Delete it" },
                ]}
                onChange={(v) => {
                  if (v === rule.then) return setAskDelete(false);
                  if (v === "delete") return setAskDelete(true);
                  setAskDelete(false);
                  void act("then", { action: "auto-stop", box, minutes: rule.minutes, then: "stop" });
                }}
              />
              {busy === "then" ? <LoaderCircle size={14} className="animate-spin text-haze" /> : null}
            </span>
          </>
        ) : null}
      </div>
      {rule && askDelete ? (
        <div role="alertdialog" aria-label={`Delete ${m.label} once it's idle?`} className="squircle space-y-3 rounded-[16px] bg-tally/[0.07] px-4 py-3.5 shadow-[inset_0_0_0_1px_rgb(255_92_116/0.28)]">
          <p className="flex items-center gap-2 text-[13.5px] font-semibold text-paper">
            <TriangleAlert size={15} className="shrink-0 text-tally" /> Delete {m.label} once it&rsquo;s idle?
          </p>
          <p className="max-w-[70ch] text-[12.5px] leading-snug text-fog">
            After {minutesWords(rule.minutes ?? 0)} idle, Crackio deletes the box on {CLOUD[provider]} for good, with its disk: ComfyUI
            {m.modelBytes ? `, ${bytesText(m.modelBytes)} of models` : ""} and anything else on it. Start can&rsquo;t bring it back, and the next job needs a new box set up again. Your takes are already on
            this computer. Pick this for a box you rented for one go.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setAskDelete(false);
                void act("then", { action: "auto-stop", box, minutes: rule.minutes, then: "delete" });
              }}
              className="press inline-flex h-9 items-center gap-1.5 rounded-[11px] bg-tally px-3.5 text-[13px] font-bold text-white hover:brightness-110"
            >
              <Trash2 size={14} /> Delete it when idle
            </button>
            <button type="button" onClick={() => setAskDelete(false)} className="h-9 px-2 text-[13px] text-haze hover:text-paper">
              Keep stopping it
            </button>
          </div>
        </div>
      ) : null}
      <p className="text-[12.5px] leading-snug text-haze">
        {rule
          ? idle !== null
            ? `Idle for ${Math.floor(idle)} min${wasted !== null && wasted >= 0.005 ? ` (${usd(wasted)} so far)` : ""}: it ${rule.then === "delete" ? "gets deleted" : "stops"} at ${minutesWords(rule.minutes ?? 0)}.`
            : `${rule.why ? `Not idle: ${rule.why}. ` : ""}The clock starts once its GPU stays under ${rule.load}% with nothing queued in ComfyUI and no set-up, download or other work on the box; Crackio looks once a minute.`
          : `It runs until you stop it. With an idle stop, Crackio stops it on ${CLOUD[provider]} (or deletes it, for a box rented for one go) once its GPU has been quiet for that long.`}
      </p>
      {rule ? (
        <p className="text-[12px] leading-snug text-haze/80">
          Graphics memory doesn&rsquo;t count: ComfyUI keeps the last model loaded between takes, so it stays full while nothing runs.{" "}
          {rule.then === "delete" ? `Once deleted, nothing bills for it any more, disk included, and it leaves your machines.` : WHILE_STOPPED[provider]}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {confirm ? (
          <>
            <span className="text-[13px] text-paper">Stop {m.label} now? Anything running there stops too.</span>
            <button type="button" onClick={() => void act("stop", { action: "stop", box })} disabled={busy === "stop"} className="press inline-flex h-9 items-center gap-1.5 rounded-[11px] bg-white/[0.1] px-3.5 text-[13px] font-semibold text-paper hover:bg-white/[0.14]">
              {busy === "stop" ? <LoaderCircle size={14} className="animate-spin" /> : null}Stop it
            </button>
            <button type="button" onClick={() => setConfirm(false)} className="text-[13px] text-haze hover:text-paper">
              Keep it running
            </button>
          </>
        ) : (
          <button type="button" onClick={() => setConfirm(true)} className="press inline-flex h-9 items-center gap-1.5 rounded-[11px] px-3.5 text-[13px] font-semibold text-fog shadow-[inset_0_0_0_1px_var(--color-line-strong)] hover:bg-white/[0.04] hover:text-paper">
            <Power size={14} /> Stop it now
          </button>
        )}
      </div>
      {error ? <p className="text-[12.5px] text-tally">{error}</p> : null}
    </section>
  );
}
