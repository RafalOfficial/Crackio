"use client";

import { useState } from "react";
import { ExternalLink, LoaderCircle } from "lucide-react";
import { ConfirmButton } from "./parts";

/** A saved key: its last four characters, and Remove, asked once more first (what uses the key stops until it's back). */
export function KeySaved({ last4, onRemove }: { last4: string | null; onRemove: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <span className="flex items-center gap-3 text-[12.5px] text-haze">
      Key ending in <span className="tabular font-semibold text-paper">{last4}</span>
      <ConfirmButton
        look="text"
        confirm="Remove the key"
        busy={busy}
        disabled={busy}
        onConfirm={async () => {
          setBusy(true);
          await onRemove();
          setBusy(false);
        }}
        className="font-semibold text-fog hover:text-tally"
      >
        Remove
      </ConfirmButton>
    </span>
  );
}

/** Paste a key and save it; it lines up under its row's title. */
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
      className="mt-4 flex flex-wrap items-center gap-2 pl-6"
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
