"use client";

import { useEffect, useState } from "react";
import { ExternalLink, LoaderCircle, RefreshCw } from "lucide-react";
import { refreshConnections, useConnections } from "@/lib/hooks/use-connections";
import { useModelsStore } from "@/lib/hooks/use-models";
import type { ConnectionStatus } from "@/lib/providers/types";
import { Panel } from "@/components/ui/Panel";
import { ProviderMark } from "@/components/brand/BrandMark";
import { cn } from "@/lib/cn";
import { GpuConnections } from "./GpuConnections";
import { ComfyCloudRow, ServerlessConnections } from "./ServerlessConnections";

type KeyName = "comfy";
type PublicSettings = { keys: Record<KeyName, { saved: boolean; last4: string | null }> };

const KEY_FOR: Partial<Record<ConnectionStatus["id"], KeyName>> = { "comfy-cloud": "comfy" };

const CAPABILITY_LABEL: Record<string, string> = { image: "Images", edit: "Edits", video: "Video", llm: "Text", vision: "Vision" };

const afterChange = async () => {
  await refreshConnections();
  await useModelsStore.getState().refresh();
};

export function ConnectionsView() {
  const { providers, loaded, error } = useConnections();
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    fetch("/api/settings", { cache: "no-store" })
      .then((r) => r.json())
      .then(setSettings)
      .catch(() => {});
  }, []);

  async function recheck() {
    setChecking(true);
    await afterChange();
    setChecking(false);
  }

  async function saveKey(name: KeyName, value: string | null) {
    const res = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: { name, value } }),
    });
    setSettings(await res.json());
    await afterChange();
  }

  const byId = new Map(providers.map((p) => [p.id, p]));
  const connected = providers.filter((p) => p.state === "connected").length;

  return (
    <div className="mt-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-[34px]">Connections</h1>
          <p className="mt-1.5 max-w-[62ch] text-[15px] leading-relaxed text-haze">
            Crackio runs on ComfyUI: your own GPU, another computer&rsquo;s, a rented one, or Comfy&rsquo;s with one Comfy key. One is enough to start.
          </p>
        </div>
        <button
          onClick={recheck}
          className="press inline-flex h-10 items-center gap-2 rounded-btn px-4 text-[13px] font-semibold shadow-[inset_0_0_0_1px_var(--color-line-strong)] hover:bg-white/[0.05]"
        >
          {checking ? <LoaderCircle size={15} className="animate-spin" /> : <RefreshCw size={15} />}
          Check again
        </button>
      </div>

      <p className="mt-3 text-[13px] text-haze" aria-live="polite">
        {!loaded ? "Checking this computer…" : error ? null : `${connected} of ${providers.length} connected`}
      </p>
      {error ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-[12px] bg-tally/10 px-4 py-3 text-[13.5px] text-tally">
          <span>Couldn&rsquo;t reach the Crackio server: {error}</span>
          <button onClick={recheck} className="font-semibold underline-offset-2 hover:underline">
            Try again
          </button>
        </div>
      ) : null}

      {[
        { title: "ComfyUI", body: "One Comfy key reaches FLUX 3, GPT Image 2.5, Nano Banana, Seedream, upscalers and more.", ids: ["comfy-cloud", "comfy-local"] as const },
      ].map((group) => (
        <section key={group.title} className="mt-10">
          <h2 className="text-[16px] font-semibold">{group.title}</h2>
          <p className="mt-1 text-[13.5px] text-haze">{group.body}</p>
          <Panel className="mt-3 divide-y divide-line">
            {group.ids.map((id) => {
              const p = byId.get(id);
              if (!p) return <div key={id} className="skeleton m-3 h-16 rounded-[10px]" />;
              const keyName = KEY_FOR[id];
              return (
                <ProviderRow
                  key={id}
                  provider={p}
                  keyState={keyName ? settings?.keys[keyName] : undefined}
                  onSaveKey={keyName ? (v) => saveKey(keyName, v) : undefined}
                />
              );
            })}
            {group.title === "ComfyUI" ? <ComfyCloudRow hasKey={Boolean(settings?.keys.comfy?.saved)} /> : null}
          </Panel>
        </section>
      ))}

      <GpuConnections />
      <ServerlessConnections />

      <p className="mt-12 max-w-[80ch] text-[12.5px] leading-relaxed text-haze">
        Crackio is an independent open-source project, not affiliated with Comfy. Keys are saved in data/settings.json on this computer
        only and are only ever sent to their own provider. You&rsquo;re responsible for following each provider&rsquo;s terms.
      </p>
    </div>
  );
}

function StatusPill({ state }: { state: ConnectionStatus["state"] }) {
  const map = {
    connected: { label: "Connected", cls: "text-chroma", dot: "bg-chroma" },
    attention: { label: "Needs attention", cls: "text-tungsten", dot: "bg-tungsten" },
    missing: { label: "Not set up", cls: "text-haze", dot: "bg-haze" },
  }[state];
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-[12.5px] font-semibold", map.cls)}>
      <span className={cn("size-1.5 rounded-full", map.dot)} />
      {map.label}
    </span>
  );
}

function ProviderRow({
  provider: p,
  keyState,
  onSaveKey,
}: {
  provider: ConnectionStatus;
  keyState?: { saved: boolean; last4: string | null };
  onSaveKey?: (value: string | null) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const envOnly = p.auth === "api-key" && p.state === "connected" && !keyState?.saved;

  return (
    <div className="p-4">
      <div className="flex flex-wrap items-start gap-3">
        <ProviderMark provider={p.id} size={40} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h3 className="text-[15px] font-semibold">{p.name}</h3>
            <StatusPill state={p.state} />
          </div>
          <p className="mt-0.5 text-[13.5px] leading-relaxed text-haze">{p.detail}</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {p.capabilities.map((c) => (
              <span key={c} className="rounded-[6px] bg-white/[0.05] px-1.5 py-0.5 text-[11px] text-fog">
                {CAPABILITY_LABEL[c] ?? c}
              </span>
            ))}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {p.auth === "api-key" && onSaveKey ? (
            keyState?.saved ? (
              <KeySaved last4={keyState.last4} onRemove={() => onSaveKey(null)} />
            ) : envOnly ? (
              <span className="text-[12.5px] text-haze">From {p.setup.envVar}</span>
            ) : (
              <button
                onClick={() => setOpen((o) => !o)}
                className="press h-9 rounded-btn bg-paper px-4 text-[13px] font-semibold text-[#16131b] hover:bg-white"
              >
                {open ? "Close" : p.state === "attention" ? "Replace key" : "Add key"}
              </button>
            )
          ) : p.setup.url ? (
            <a
              href={p.setup.url}
              target="_blank"
              rel="noreferrer"
              className="press inline-flex h-9 items-center gap-1.5 rounded-btn px-4 text-[13px] font-semibold text-fog hover:bg-white/[0.05] hover:text-paper"
            >
              {p.setup.label} <ExternalLink size={12} />
            </a>
          ) : null}
        </div>
      </div>

      {open && p.auth === "api-key" && onSaveKey && !keyState?.saved ? (
        <KeyForm
          name={p.name}
          url={p.setup.url}
          onSave={async (v) => {
            await onSaveKey(v);
            setOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}

export function KeySaved({ last4, onRemove }: { last4: string | null; onRemove: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <span className="flex items-center gap-3 text-[12.5px] text-haze">
      Key ending in <span className="tabular font-semibold text-paper">{last4}</span>
      <button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await onRemove();
          setBusy(false);
        }}
        className="font-semibold text-fog hover:text-tally"
      >
        Remove
      </button>
    </span>
  );
}

export function KeyForm({ name, url, onSave }: { name: string; url?: string; onSave: (v: string) => Promise<void> }) {
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (!value.trim()) return;
        setSaving(true);
        await onSave(value.trim());
        setSaving(false);
      }}
      className="mt-4 flex flex-wrap items-center gap-2 pl-[52px]"
    >
      <input
        type="password"
        autoComplete="off"
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={`Paste your ${name} key`}
        aria-label={`${name} API key`}
        className="field-focus h-10 min-w-[220px] flex-1 rounded-btn bg-white/[0.03] px-4 text-[13.5px] outline-none shadow-[inset_0_0_0_1px_var(--color-line)] placeholder:text-haze"
      />
      <button
        type="submit"
        disabled={!value.trim() || saving}
        className="press inline-flex h-10 items-center gap-1.5 rounded-btn bg-spike px-5 text-[13px] font-bold text-spike-ink hover:bg-spike-hi disabled:opacity-40"
      >
        {saving ? <LoaderCircle size={14} className="animate-spin" /> : null}
        Save
      </button>
      {url ? (
        <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[12.5px] font-semibold text-fog hover:text-paper">
          Get a key <ExternalLink size={11} />
        </a>
      ) : null}
    </form>
  );
}
