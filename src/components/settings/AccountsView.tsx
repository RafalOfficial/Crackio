"use client";

import { useState } from "react";
import { ExternalLink } from "lucide-react";
import { useSettings, type KeyName } from "@/lib/hooks/use-settings";
import { announce } from "@/lib/hooks/use-setup";
import { refreshConnections } from "@/lib/hooks/use-connections";
import { useModelsStore } from "@/lib/hooks/use-models";
import { DEMO, DEMO_FULL } from "@/lib/demo/config";
import { KeyForm, KeySaved } from "./keys";
import { ComfyCloudRow, ServerlessConnections } from "./ServerlessConnections";
import { Heading, Lamp, Loading, Verdict } from "./parts";

/**
 * Settings → Accounts: every key, grouped by what it unlocks rather than by company. Keys stay in data/settings.json on
 * this computer and only ever go to their own provider; the browser only ever sees whether one is saved and its last 4.
 */

type Row = { name: KeyName; title: string; body: string; url: string; get: string };

const GROUPS: { id: string; title: string; note: string; rows: Row[] }[] = [
  {
    id: "comfy",
    title: "Make things in the cloud",
    note: "Hosted models on Comfy's GPUs, billed by Comfy: FLUX 3, GPT Image 2.5, Nano Banana, Seedance, upscalers, and the brain of Motion's agent.",
    rows: [{ name: "comfy", title: "Comfy key", body: "From your Comfy account, under API keys.", url: "https://platform.comfy.org/profile/api-keys", get: "Get a Comfy key" }],
  },
  {
    id: "hf",
    title: "Download open models",
    note: "Some open models ask you to accept their licence first (LTX-2.5, LatentSync and others). Crackio sends your token with each download, to whichever machine fetches it.",
    rows: [{ name: "hf", title: "Hugging Face token", body: "A read token is enough. Accept each gated model's terms on its Hugging Face page once.", url: "https://huggingface.co/settings/tokens", get: "Make a token" }],
  },
  {
    id: "rent",
    title: "Rent GPUs",
    note: "With a key, every GPU you rent joins your machines by itself and leaves when you give it back. Crackio adds its SSH key to your account to set boxes up.",
    rows: [
      { name: "vast", title: "vast.ai key", body: "Lists the boxes you rent there.", url: "https://cloud.vast.ai/manage-keys/", get: "Get a vast.ai key" },
      { name: "runpod", title: "RunPod key", body: "Brings every pod you rent (any template), shows your credit, stops or deletes idle pods, and runs your Serverless endpoints. Give it All permissions.", url: "https://console.runpod.io/user/settings", get: "Get a RunPod key" },
    ],
  },
];

/** The live demo takes only the visitor's own Comfy, RunPod and vast keys. */
const allowed = (name: KeyName) => !DEMO || (DEMO_FULL && name !== "hf");

export function AccountsView() {
  const { settings, patch } = useSettings();
  const [open, setOpen] = useState<KeyName | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!settings) return <Loading rows={4} />;

  async function save(name: KeyName, value: string | null) {
    setError(await patch({ key: { name, value } }));
    setOpen(null);
    await refreshConnections();
    await useModelsStore.getState().refresh();
    announce();
  }

  const saved = (Object.keys(settings.keys) as KeyName[]).filter((k) => settings.keys[k].saved).length;
  return (
    <div className="space-y-10">
      <Verdict title="Accounts" facts={saved ? `${saved} of 4 keys saved · each one only ever goes to its own provider` : "No keys yet. None is needed for your own GPUs: they unlock hosted models, gated downloads and rented GPUs."} />
      {error ? <p className="text-[13px] text-tally">{error}</p> : null}
      {GROUPS.map((g) => (
        <section key={g.id} id={g.id} className="scroll-mt-24 space-y-3">
          <Heading title={g.title} note={g.note} />
          <ul className="squircle divide-y divide-line overflow-hidden rounded-[18px] shadow-[inset_0_0_0_1px_var(--color-line)]">
            {g.rows.filter((r) => allowed(r.name)).map((r) => {
              const k = settings.keys[r.name];
              return (
                <li key={r.name} className="px-5 py-4">
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                    <Lamp tone={k.saved ? "ready" : "off"} />
                    <div className="min-w-0 flex-1">
                      <p className="text-[14.5px] font-semibold text-paper">{r.title}</p>
                      <p className="mt-0.5 text-[13px] text-haze">
                        {r.body}{" "}
                        <a href={r.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-fog hover:text-paper">
                          {r.get} <ExternalLink size={11} />
                        </a>
                      </p>
                    </div>
                    {k.saved ? (
                      <KeySaved last4={k.last4} onRemove={() => save(r.name, null)} />
                    ) : (
                      <button type="button" onClick={() => setOpen((o) => (o === r.name ? null : r.name))} className="press h-9 rounded-btn bg-paper px-4 text-[13px] font-semibold text-[#16131b] hover:bg-white">
                        {open === r.name ? "Close" : "Add"}
                      </button>
                    )}
                  </div>
                  {open === r.name && !k.saved ? <KeyForm name={r.title} url={r.url} onSave={(v) => save(r.name, v)} /> : null}
                </li>
              );
            })}
            {g.id === "comfy" ? <ComfyCloudRow hasKey={settings.keys.comfy.saved} /> : null}
          </ul>
        </section>
      ))}
      {!DEMO || DEMO_FULL ? (
        <section id="serverless" className="scroll-mt-24">
          <ServerlessConnections />
        </section>
      ) : null}
      <p className="max-w-[80ch] text-[12.5px] leading-relaxed text-haze">
        Crackio is an independent open-source project, not affiliated with Comfy. Keys are saved in data/settings.json on this computer only and are only ever sent
        to their own provider. You&rsquo;re responsible for following each provider&rsquo;s terms.
      </p>
    </div>
  );
}
