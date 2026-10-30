"use client";

import { useEffect, useState } from "react";
import { Cloud, KeyRound } from "lucide-react";
import { Panel } from "@/components/ui/Panel";
import { KeyForm, KeySaved } from "./ConnectionsView";

type Name = "hf" | "vast" | "runpod";
type Keys = Record<Name, { saved: boolean; last4: string | null }>;

const ROWS: { name: Name; title: string; body: string; url: string; placeholder: string }[] = [
  {
    name: "hf",
    title: "Hugging Face",
    body: "Downloads gated open models (LTX-2.5 and others) once you've accepted their licence on huggingface.co. Crackio sends it with each download to whichever machine fetches it, so a GPU you rent needs nothing set up.",
    url: "https://huggingface.co/settings/tokens",
    placeholder: "Hugging Face",
  },
  {
    name: "vast",
    title: "vast.ai",
    body: "Lists the GPUs you rent there, so Local connects one in a click, and puts Crackio's SSH key on your account.",
    url: "https://cloud.vast.ai/manage-keys/",
    placeholder: "vast.ai",
  },
  {
    name: "runpod",
    title: "RunPod",
    body: "Lists your pods, so Local connects one in a click, and puts Crackio's SSH key on your account. Also runs your RunPod Serverless endpoints (below).",
    url: "https://console.runpod.io/user/settings",
    placeholder: "RunPod",
  },
];

/** Connections → GPUs and open models: the Hugging Face token, and the GPU clouds Crackio finds your rented boxes on. */
export function GpuConnections() {
  const [keys, setKeys] = useState<Keys | null>(null);
  const [open, setOpen] = useState<Name | null>(null);

  useEffect(() => {
    fetch("/api/settings", { cache: "no-store" })
      .then((r) => r.json())
      .then((s: { keys: Keys }) => setKeys(s.keys))
      .catch(() => {});
  }, []);

  async function save(name: Name, value: string | null) {
    const res = await fetch("/api/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: { name, value } }) });
    setKeys(((await res.json()) as { keys: Keys }).keys);
    setOpen(null);
  }

  return (
    <section className="mt-10">
      <h2 className="text-[16px] font-semibold">GPUs and open models</h2>
      <p className="mt-1 text-[13.5px] text-haze">For open models on your own GPUs and rented ones (Local). Saved in data/settings.json on this computer only.</p>
      <Panel className="mt-3 divide-y divide-line">
        {ROWS.map((row) => {
          const k = keys?.[row.name];
          return (
            <div key={row.name} className="p-4">
              <div className="flex flex-wrap items-start gap-3">
                <span className="grid size-10 shrink-0 place-items-center rounded-[12px] bg-white/[0.05] text-fog">{row.name === "hf" ? <KeyRound size={18} /> : <Cloud size={18} />}</span>
                <div className="min-w-0 flex-1">
                  <h3 className="text-[15px] font-semibold">{row.title}</h3>
                  <p className="mt-0.5 max-w-[80ch] text-[13.5px] leading-relaxed text-haze">{row.body}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {k?.saved ? (
                    <KeySaved last4={k.last4} onRemove={() => save(row.name, null)} />
                  ) : (
                    <button onClick={() => setOpen((o) => (o === row.name ? null : row.name))} className="press h-9 rounded-btn bg-paper px-4 text-[13px] font-semibold text-[#16131b] hover:bg-white">
                      {open === row.name ? "Close" : row.name === "hf" ? "Add token" : "Add key"}
                    </button>
                  )}
                </div>
              </div>
              {open === row.name && !k?.saved ? <KeyForm name={row.placeholder} url={row.url} onSave={(v) => save(row.name, v)} /> : null}
            </div>
          );
        })}
      </Panel>
    </section>
  );
}
