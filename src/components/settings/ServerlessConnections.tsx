"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronRight, CloudLightning, ExternalLink, LoaderCircle } from "lucide-react";
import { Panel } from "@/components/ui/Panel";
import { useSettings } from "@/lib/hooks/use-settings";
import { cn } from "@/lib/cn";
import { ConfirmButton, Heading, Lamp } from "./parts";

type Endpoint = { endpointId: string; label: string; removable: boolean; ok: boolean; jobs: number; gpu: string | null; comfyui: string | null; files: { folder: string; name: string; bytes: number }[] };

const DOCS = "https://github.com/RafalOfficial/Crackio/blob/main/docs/SERVERLESS.md";

const LINK = "inline-flex items-center gap-0.5 font-semibold text-fog underline decoration-white/20 underline-offset-2 hover:text-paper";

/**
 * Accounts → Make things in the cloud: Comfy Cloud, right under the Comfy key it runs on, laid out like the key rows above
 * it. Crackio's own ComfyUI graphs on Comfy's GPUs, for your Comfy credits. A different service from RunPod Serverless
 * (below), which runs them on your RunPod account.
 */
export function ComfyCloudRow({ hasKey }: { hasKey: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-4">
      <Lamp tone={hasKey ? "ready" : "off"} />
      <div className="min-w-0 flex-1">
        <h3 className="text-[14.5px] font-semibold text-paper">Comfy Cloud</h3>
        <p className="mt-0.5 max-w-[80ch] text-[13px] leading-relaxed text-haze">
          {hasKey ? (
            <>
              <span className="font-semibold text-chroma">On</span> with your Comfy key: Crackio&rsquo;s graphs can also run on Comfy&rsquo;s servers, paid with your Comfy
              credits or plan. Comfy picks the hardware; nothing is rented in your name. Needs a Comfy plan with API access (Standard or higher).
            </>
          ) : (
            <>Add your Comfy key (above) and Crackio&rsquo;s graphs can run on Comfy&rsquo;s servers too, paid with your Comfy credits or plan. No GPU needed.</>
          )}
        </p>
      </div>
    </div>
  );
}

/**
 * Accounts → RunPod Serverless: your own endpoints running Crackio's ComfyUI worker, on your RunPod key (Rent GPUs, above)
 * or the server's. Each joins your machines: pick it under Run on, set tools up on it in Settings → Tools. Anyone on the
 * network sees them; adding and removing them happens on the computer Crackio runs on.
 */
export function ServerlessConnections() {
  const [list, setList] = useState<Endpoint[] | null>(null);
  // The same settings Accounts' key rows save: a RunPod key added above counts here at once.
  const { settings } = useSettings();
  const hasKey = Boolean(settings?.keys.runpod?.saved);
  const [serverKey, setServerKey] = useState(false);
  const [here, setHere] = useState(true);
  const [id, setId] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const none: { endpoints: Endpoint[]; here?: boolean; serverKey?: boolean } = { endpoints: [] };
    const eps = await fetch("/api/serverless", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<typeof none>) : none))
      .catch(() => none);
    setList(eps.endpoints);
    setHere(eps.here ?? true);
    setServerKey(Boolean(eps.serverKey));
  }, []);

  useEffect(() => {
    const first = setTimeout(() => void load(), 0);
    return () => clearTimeout(first);
  }, [load]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch("/api/serverless/endpoints", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpointId: id.trim(), label: label.trim() || undefined }) });
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    setBusy(false);
    if (!res.ok) return setError(body.error ?? "Couldn't add it.");
    setId("");
    setLabel("");
    void load();
  }

  async function remove(endpointId: string) {
    await fetch(`/api/serverless/endpoints?endpointId=${encodeURIComponent(endpointId)}`, { method: "DELETE" });
    void load();
  }

  const keyed = hasKey || serverKey;

  return (
    <div className="space-y-3">
      <Heading title="RunPod Serverless" note="A GPU that runs only while your job runs, paid by the second. Good when you have no GPU of your own." />
      <details className="group max-w-[80ch]">
        <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-[13px] font-semibold text-fog hover:text-paper [&::-webkit-details-marker]:hidden">
          <ChevronRight size={14} className="transition-transform group-open:rotate-90" />
          How to set it up
        </summary>
        <ol className="mt-2 list-decimal space-y-1.5 pl-9 text-[13px] leading-relaxed text-haze">
          <li>
            Make a{" "}
            <a href="https://console.runpod.io/signup" target="_blank" rel="noreferrer" className={LINK}>
              RunPod account
            </a>{" "}
            and add about $10 of credit.
          </li>
          <li>
            Create an{" "}
            <a href="https://console.runpod.io/user/settings" target="_blank" rel="noreferrer" className={LINK}>
              API key
            </a>{" "}
            and paste it under Rent GPUs, above.
          </li>
          <li>
            Deploy Crackio&rsquo;s worker as a Serverless endpoint (
            <a href={DOCS} target="_blank" rel="noreferrer" className={LINK}>
              the guide
            </a>
            , docs/SERVERLESS.md).
          </li>
          <li>Paste the endpoint&rsquo;s ID below. It&rsquo;s on RunPod under Serverless, on your endpoint&rsquo;s page.</li>
        </ol>
        <p className="mt-2 pl-4 text-[12.5px] text-haze">
          Measured on an RTX 4090: about $0.02 a picture from a cold start, $0.001 once it&rsquo;s warm, $0.06 for a 2-second 720p clip.
        </p>
      </details>
      <Panel className="divide-y divide-line">
        {(list ?? []).map((ep) => (
          <div key={ep.endpointId} className="flex flex-wrap items-center gap-3 p-4">
            <span className="grid size-10 shrink-0 place-items-center rounded-[12px] bg-white/[0.05] text-fog">
              <CloudLightning size={18} />
            </span>
            <div className="min-w-0 flex-1">
              <h3 className="text-[15px] font-semibold">{ep.label}</h3>
              <p className="mt-0.5 text-[13px] text-haze">
                <span className={cn("font-semibold", ep.ok ? "text-chroma" : "text-tungsten")}>{ep.ok ? "Answering" : "Not answering"}</span>
                {" · "}
                <span className="font-mono text-[12px]">{ep.endpointId}</span>
                {ep.gpu ? ` · ${ep.gpu}` : ""}
                {` · ${ep.files.length} model file${ep.files.length === 1 ? "" : "s"}`}
                {ep.comfyui ? ` · ComfyUI ${ep.comfyui}` : ""}
              </p>
            </div>
            {!ep.removable ? (
              <span className="text-[12.5px] text-haze">Set by this server</span>
            ) : here ? (
              <ConfirmButton look="text" confirm={`Remove ${ep.label}`} onConfirm={() => remove(ep.endpointId)} className="press text-[12.5px] font-semibold text-fog hover:text-tally">
                Remove
              </ConfirmButton>
            ) : null}
          </div>
        ))}
        {here ? (
          <form onSubmit={add} className="flex flex-wrap items-center gap-2 p-4">
            <input
              value={id}
              onChange={(e) => setId(e.target.value)}
              placeholder="Endpoint ID (RunPod → Serverless → your endpoint)"
              aria-label="RunPod endpoint ID"
              className="field-focus h-10 min-w-[260px] flex-1 rounded-btn bg-white/[0.03] px-4 font-mono text-[13px] outline-none shadow-[inset_0_0_0_1px_var(--color-line)] placeholder:font-sans placeholder:text-haze"
            />
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Name (optional)"
              aria-label="Name"
              className="field-focus h-10 w-[180px] rounded-btn bg-white/[0.03] px-4 text-[13.5px] outline-none shadow-[inset_0_0_0_1px_var(--color-line)] placeholder:text-haze"
            />
            <button
              type="submit"
              disabled={!id.trim() || busy || !keyed}
              title={keyed ? undefined : "Add your RunPod key under Rent GPUs, above, first"}
              className="press inline-flex h-10 items-center gap-1.5 rounded-btn bg-spike px-5 text-[13px] font-bold text-spike-ink hover:bg-spike-hi disabled:opacity-40"
            >
              {busy ? <LoaderCircle size={14} className="animate-spin" /> : null}
              Add endpoint
            </button>
            <a href="https://console.runpod.io/serverless" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[12.5px] font-semibold text-fog hover:text-paper">
              RunPod console <ExternalLink size={13} />
            </a>
            {!keyed ? <p className="w-full text-[12.5px] text-haze">Add your RunPod key under Rent GPUs, above, first.</p> : null}
            {error ? <p className="w-full text-[12.5px] text-tally">{error}</p> : null}
          </form>
        ) : (
          <p className="p-4 text-[13px] text-haze">
            {list && !list.length ? "No endpoints yet. " : ""}Add or change endpoints on the computer Crackio runs on.
          </p>
        )}
      </Panel>
    </div>
  );
}
