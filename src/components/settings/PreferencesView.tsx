"use client";

import { useState, type ReactNode } from "react";
import { useSettings, useSettingsStore, type PublicSettings } from "@/lib/hooks/use-settings";
import { useSetup, useSetupStore } from "@/lib/hooks/use-setup";
import { setRunOn } from "@/lib/hooks/use-run-on";
import { reloadLocal } from "@/lib/hooks/use-local";
import { cn } from "@/lib/cn";
import { Heading, Lamp, Loading, Tape, Verdict } from "./parts";
import { showNotification, useNotifyPrefs, writeNotify, type NotifyPrefs } from "./Notifier";

/**
 * Settings → Preferences: each choice once, with one line saying what it changes. Tools' own quick controls (Run on in a
 * tool's time line, Swap's Checks, Retouch's Eyes) change the same values, so they always agree with this page.
 */
export function PreferencesView() {
  const { settings, patch, load } = useSettings();
  const { snap } = useSetup();
  const [error, setError] = useState<string | null>(null);
  if (!settings) return <Loading rows={6} />;

  const save = async (body: Record<string, unknown>) => setError(await patch(body));
  const machines = (snap?.machines ?? []).filter((m) => m.online || m.runOn);

  async function runOn(target: string) {
    await setRunOn(target);
    await load();
    await useSetupStore.getState().reload(true);
  }
  async function pooling(mode: PublicSettings["pooling"]) {
    useSettingsStore.setState({ settings: { ...settings!, pooling: mode } });
    await fetch("/api/local", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "pooling", mode }) }).catch(() => null);
    void reloadLocal();
    await load();
  }
  async function autoConnect(on: boolean) {
    useSettingsStore.setState({ settings: { ...settings!, cloudAutoConnect: on } });
    await fetch("/api/local/cloud", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "auto-connect", on }) }).catch(() => null);
    await load();
  }

  return (
    <div className="space-y-10">
      <Verdict title="Preferences" facts="How Crackio picks machines, checks its own work and handles rented GPUs." />
      {error ? <p className="text-[13px] text-tally">{error}</p> : null}

      <section className="space-y-3">
        <Heading title="Where jobs run" note="Auto sends each job to the free machine with the fastest GPU that has its model. Pick one to send jobs there first; Crackio still falls back when it's off or lacks the model." />
        <Choices
          value={settings.runOn}
          onChange={(v) => void runOn(v)}
          options={[
            { value: "auto", label: "Auto", note: "Fastest free machine with the model" },
            ...machines.map((m) => ({
              value: m.id,
              label: m.label,
              note: m.metered ? "Pay per job: every job here is billed" : m.kind === "this-computer" ? "This computer" : m.where,
              warn: m.metered,
              lamp: m.online ? ("ready" as const) : ("off" as const),
            })),
          ]}
        />
      </section>

      <section className="space-y-3">
        <Heading title="Models too big for one GPU" note="Crackio can split a big model across two of your computers: slower than one GPU that holds it, but it runs." />
        <Choices
          value={settings.pooling}
          onChange={(v) => void pooling(v as PublicSettings["pooling"])}
          options={[
            { value: "auto", label: "When it can't run alone", note: "Only when no single machine can run it (default)" },
            { value: "always", label: "Whenever the GPU is too small", note: "Even when it could stream the rest from RAM" },
            { value: "off", label: "Never split", note: "Too-big models stay unavailable" },
          ]}
        />
      </section>

      <NotificationsSection />

      <section className="space-y-3">
        <Heading title="Rented GPUs" note="With a vast.ai or RunPod key (Accounts), the GPUs you rent join your machines by themselves and leave when you give them back." />
        <Toggle on={settings.cloudAutoConnect} onChange={(on) => void autoConnect(on)} label="Connect the GPUs I rent by themselves" />
      </section>

      <section className="space-y-3">
        <Heading title="Checking swaps" note="Swap checks each drawing before it keeps it, and redraws the ones that miss." />
        <Choices
          value={settings.swapChecker}
          onChange={(v) => void save({ swapChecker: v })}
          options={[
            { value: "auto", label: "Auto", note: "Crackio's judge on your GPU where it's set up, else Gemini" },
            { value: "local", label: "On my GPU", note: "Crackio's judge only (needs it set up)" },
            { value: "cloud", label: "Gemini 3.5 Flash", note: "On your Comfy key" },
          ]}
        />
        <Choices
          value={settings.swapStrictness}
          onChange={(v) => void save({ swapStrictness: v })}
          options={[
            { value: "lenient", label: "Keep good swaps", note: "Small flaws pass (default)" },
            { value: "normal", label: "Balanced", note: "" },
            { value: "strict", label: "Strict", note: "Redraws anything doubtful: slower" },
          ]}
        />
      </section>

      <section className="space-y-3">
        <Heading title="Reading pictures" note="Retouch and Swap read what's in a picture: on your GPU, or with Gemini on your Comfy key." />
        <Choices
          value={settings.retouchEyes}
          onChange={(v) => void save({ retouchEyes: v })}
          options={[
            { value: "auto", label: "Auto", note: "Your GPU where Crackio's eyes are set up, else Gemini" },
            { value: "local", label: "On my GPU", note: "LFM3-VL with Crackio's Retouch fine-tune" },
            { value: "cloud", label: "Gemini 3.5 Flash", note: "On your Comfy key" },
          ]}
        />
        <Choices
          value={settings.localVision}
          onChange={(v) => void save({ localVision: v })}
          options={[
            { value: "4b", label: "Qwen3-VL 4B", note: "Swap's checks without the judge: FLUX 3 Klein's own reader, already there (default)" },
            { value: "8b", label: "Qwen3-VL 8B", note: "Sharper, about twice the memory" },
          ]}
        />
      </section>
    </div>
  );
}

/** Notifications in this browser: on or off, which kinds, and a test. */
function NotificationsSection() {
  const p = useNotifyPrefs();
  const [perm, setPerm] = useState<NotificationPermission | "unsupported">(() => (typeof window !== "undefined" && "Notification" in window ? Notification.permission : "unsupported"));
  const secure = typeof window !== "undefined" && window.isSecureContext;
  const on = p.on && perm === "granted";
  async function turn(next: boolean) {
    if (next && perm !== "granted") {
      if (perm === "unsupported") return;
      const answer = await Notification.requestPermission();
      setPerm(answer);
      if (answer !== "granted") return;
    }
    writeNotify({ ...p, on: next });
  }
  const kinds: { key: keyof Omit<NotifyPrefs, "on">; label: string }[] = [
    { key: "takes", label: "Takes over 30 s" },
    { key: "setups", label: "Set-ups" },
    { key: "money", label: "Rented GPUs and credit" },
  ];
  return (
    <section className="space-y-3">
      <Heading title="Notifications" note="Your browser tells you when a long take or a set-up finishes, a rented GPU stops itself, or your credit is about to run out, while you're in another window. Kept for this browser." />
      <Toggle on={on} onChange={(v) => void turn(v)} label="Tell me when things finish" />
      {on ? (
        <div className="flex flex-wrap items-center gap-2">
          {kinds.map((k) => (
            <button
              key={k.key}
              type="button"
              role="checkbox"
              aria-checked={p[k.key]}
              onClick={() => writeNotify({ ...p, [k.key]: !p[k.key] })}
              className={cn(
                "press rounded-full px-3.5 py-1.5 text-[13px] font-medium transition-colors",
                p[k.key] ? "bg-white/[0.1] text-paper shadow-[inset_0_0_0_1px_rgb(255_255_255/0.1)]" : "text-haze shadow-[inset_0_0_0_1px_var(--color-line)] hover:text-paper",
              )}
            >
              {k.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => showNotification("Crackio", { body: "Notifications work: this is how a finished take will look.", tag: "crackio-test" })}
            className="ml-1 text-[13px] font-semibold text-haze underline-offset-2 hover:text-paper hover:underline"
          >
            Send a test
          </button>
        </div>
      ) : null}
      {perm === "denied" ? <p className="text-[12.5px] text-tungsten">This browser blocks Crackio&rsquo;s notifications: allow them in the site settings (the icon left of the address), then turn this on.</p> : null}
      {perm === "unsupported" || !secure ? (
        <p className="text-[12.5px] text-haze">Notifications need Crackio on this computer or its https address (a browser shows them only to secure pages).</p>
      ) : null}
    </section>
  );
}

type Option = { value: string; label: string; note?: string; warn?: boolean; lamp?: "ready" | "off" };

/** A choice as a short list of cards: the one picked carries the spike tape. */
function Choices({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: Option[] }) {
  // Shows a pick at once; follows the saved value when it changes (React's "adjust state when a prop changes").
  const [shown, setShown] = useState(value);
  const [was, setWas] = useState(value);
  if (was !== value) {
    setWas(value);
    setShown(value);
  }
  return (
    <div role="radiogroup" className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
      {options.map((o) => {
        const on = shown === o.value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => {
              setShown(o.value);
              onChange(o.value);
            }}
            className={cn(
              "press squircle relative flex min-h-[64px] flex-col justify-center rounded-[16px] px-4 py-3 text-left transition-colors",
              on ? "bg-white/[0.08] shadow-[inset_0_0_0_1px_rgb(255_255_255/0.1)]" : "bg-white/[0.025] shadow-[inset_0_0_0_1px_var(--color-line)] hover:bg-white/[0.05]",
            )}
          >
            <span className="flex items-center gap-2 text-[14px] font-semibold text-paper">
              {o.lamp ? <Lamp tone={o.lamp} /> : null}
              {o.label}
            </span>
            {o.note ? <span className={cn("mt-0.5 text-[12.5px] leading-snug", o.warn ? "text-tungsten" : "text-haze")}>{o.note}</span> : null}
            {on ? <Tape className="inset-x-4 -bottom-[2px]" /> : null}
          </button>
        );
      })}
    </div>
  );
}

function Toggle({ on, onChange, label }: { on: boolean; onChange: (on: boolean) => void; label: ReactNode }) {
  return (
    <button type="button" role="switch" aria-checked={on} onClick={() => onChange(!on)} className="inline-flex items-center gap-3 text-[14px] font-medium text-paper">
      <span className={cn("relative h-[22px] w-10 rounded-full transition-colors", on ? "bg-spike" : "bg-gaffer")}>
        <span className={cn("absolute top-[3px] size-4 rounded-full bg-paper transition-[left] duration-200", on ? "left-[21px]" : "left-[3px]")} />
      </span>
      {label}
    </button>
  );
}
