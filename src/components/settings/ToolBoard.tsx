"use client";

import Image from "next/image";
import { useState, type CSSProperties } from "react";
import { ArrowUpRight, LoaderCircle } from "lucide-react";
import { Button, ButtonLink } from "@/components/ui/Button";
import { AppIcon } from "@/components/ui/ToolTile";
import { setUp, stopSetUp } from "@/lib/hooks/use-setup";
import { kitById } from "@/lib/setup/kits";
import type { Kit, KitId, ToolStatus } from "@/lib/setup/types";
import { cn } from "@/lib/cn";
import { Lamp, Progress } from "./parts";
import { bytesText, fits, gbText, plainWhy, REQ_TONE, toolWords } from "./words";
import { hasChoice, type Choice } from "./ModelChooser";
import { ToolSheet, type SheetCtx } from "./ToolSheet";

/**
 * Settings → Tools as a board: every tool's own artwork, lit in its colour when it's ready on the machine picked and
 * dimmed when it isn't, with its state and one button. A card opens its set-up (the models it can use here, their
 * versions, an estimate) in a sheet from the right (ToolSheet).
 */

type Ctx = SheetCtx;

/** The one button a tool offers on a machine, and the error it last hit. */
function useToolAction(kitId: KitId, status: ToolStatus, { m, live }: Ctx) {
  const kit = kitById(kitId)!;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const job = live?.kits.includes(kitId) ? live : null;
  async function go(include?: string[], choices?: Record<string, Choice>) {
    setBusy(true);
    setError(null);
    const r = await setUp(m.id, [kitId], include, choices);
    setError(r.error);
    setBusy(false);
  }
  const spin = busy ? <LoaderCircle size={14} className="animate-spin" /> : null;
  let action: React.ReactNode = null;
  if (m.online && !m.metered) {
    switch (status.state) {
      case "ready":
        action = (
          <ButtonLink href={kit.href} variant="ghost" size="sm">
            Open <ArrowUpRight size={13} />
          </ButtonLink>
        );
        break;
      case "missing":
      case "no-comfy":
        action = !fits(m, status.bytes) ? (
          <ButtonLink href={`/settings/storage?machine=${encodeURIComponent(m.id)}`} variant="ghost" size="sm" title={`Needs ${bytesText(status.bytes)}; ${gbText(m.diskFreeGb)} free`}>
            Make room · {bytesText(status.bytes)}
          </ButtonLink>
        ) : (
          <Button variant="outline" size="sm" onClick={() => void go()} disabled={busy || Boolean(live)}>
            {spin}Set up · {bytesText(status.bytes)}
          </Button>
        );
        break;
      case "broken":
        action = (
          <Button variant="outline" size="sm" onClick={() => void go()} disabled={busy || Boolean(live)}>
            {spin}Try again
          </Button>
        );
        break;
      case "needs-update":
        action =
          m.bridge.update === "this-computer" || status.reqs.some((r) => r.state === "outdated" && r.plan) ? (
            <Button variant="outline" size="sm" onClick={() => void go()} disabled={busy || Boolean(live)}>
              {spin}Update
            </Button>
          ) : (
            <ButtonLink href={`/settings/machines?machine=${encodeURIComponent(m.id)}`} variant="ghost" size="sm">
              How to update
            </ButtonLink>
          );
        break;
      case "needs-key":
        action = (
          <ButtonLink href="/settings/accounts#hf" variant="outline" size="sm">
            Add the key
          </ButtonLink>
        );
        break;
      case "installing":
        action = job ? (
          <Button variant="ghost" size="sm" onClick={() => void stopSetUp(job.id)}>
            Stop
          </Button>
        ) : null;
        break;
    }
  }
  return { action, go, busy, error, job };
}

export function ToolBoard({ rows, ctx, focus, model }: { rows: { kit: Kit; status: ToolStatus }[]; ctx: Ctx; focus?: string | null; model?: string | null }) {
  // ?tool= (from Overview's "Set up", a pill's "Details") opens that tool's drawer; ?model= picks that model in it.
  const asked = focus && kitById(focus) ? (focus as KitId) : null;
  const [open, setOpen] = useState<KitId | null>(asked);
  return (
    <>
      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {rows.map(({ kit, status }) => (
          <ToolCard key={kit.id} kit={kit} status={status} ctx={ctx} onOpen={() => setOpen(kit.id)} />
        ))}
      </ul>
      <ToolSheet kitId={open} ctx={ctx} onClose={() => setOpen(null)} pick={open === asked ? model : null} />
    </>
  );
}

/** The ready glow in the tool's own colour; neutral tiles (Image, Video) glow in paper. */
const glow = (hue: string): CSSProperties => {
  const c = hue || "var(--color-paper)";
  return { boxShadow: `0 0 0 1px color-mix(in oklab, ${c} 42%, transparent), 0 26px 60px -34px ${c}` };
};

function ToolCard({ kit, status, ctx, onOpen }: { kit: Kit; status: ToolStatus; ctx: Ctx; onOpen: () => void }) {
  const words = toolWords(status);
  const { action, error, job } = useToolAction(kit.id, status, ctx);
  const step = job?.steps.find((s) => s.state === "running");
  const lit = status.state === "ready";
  const elsewhere = status.state === "unsupported" && ctx.snap.runsOn[kit.id] && ctx.snap.runsOn[kit.id] !== ctx.m.id ? ctx.snap.machines.find((x) => x.id === ctx.snap.runsOn[kit.id]) : null;
  const required = status.reqs.filter((r) => !r.optional);
  return (
    <li className="group relative">
      <div className={cn("squircle relative flex h-full flex-col overflow-hidden rounded-[20px] bg-apple transition-[box-shadow,transform] duration-300", !lit && "shadow-[inset_0_0_0_1px_var(--color-line)]")} style={lit ? glow(kit.hue) : undefined}>
        <button type="button" onClick={onOpen} className="relative block aspect-[16/10] w-full overflow-hidden text-left" aria-label={`${kit.name}: ${words.label}. Details`}>
          <Image
            src={kit.media}
            alt=""
            fill
            sizes="(min-width: 1536px) 25vw, (min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw"
            className={cn("object-cover transition-[filter,opacity,transform] duration-500", lit ? "" : "opacity-45 grayscale-[0.9] group-hover:opacity-75 group-hover:grayscale-[0.3]")}
          />
          <span className="pointer-events-none absolute inset-0 bg-gradient-to-t from-apple via-apple/25 to-transparent" />
          <span className="absolute left-3 top-3 inline-flex items-center gap-1.5 rounded-full bg-black/55 px-2.5 py-1 text-[11.5px] font-semibold text-paper shadow-[inset_0_0_0_1px_rgb(255_255_255/0.1)]">
            <Lamp tone={words.tone} />
            {words.label}
          </span>
          {status.bytes && !lit && status.state !== "unsupported" ? <span className="absolute right-3 top-3 rounded-full bg-black/55 px-2.5 py-1 text-[11.5px] font-medium tabular text-fog">{bytesText(status.bytes)}</span> : null}
        </button>
        <div className="relative -mt-6 flex flex-1 flex-col px-4 pb-4">
          <AppIcon glyph={kit.glyph} hue={kit.hue || undefined} size={38} className={cn("transition-[filter,opacity]", !lit && "opacity-70 grayscale-[0.6]")} />
          <button type="button" onClick={onOpen} className="mt-2.5 text-left">
            <span className="block font-display text-[19px] uppercase leading-none tracking-[0.005em] text-paper">{kit.name}</span>
            <span className="mt-1.5 line-clamp-2 block min-h-[2.6em] text-[12.5px] leading-snug text-haze">
              {status.state === "installing" && step ? `${step.label}: ${step.detail}` : words.why}
              {status.state === "missing" && required.some((r) => hasChoice(r, ctx.m)) ? <span className="text-fog"> · or pick another</span> : null}
              {elsewhere ? ` · runs on ${elsewhere.label}` : ""}
              {status.state === "unsupported" && !elsewhere && status.cloud ? " · works on your Comfy key" : ""}
            </span>
          </button>
          {status.state === "installing" && step?.progress ? <Progress received={step.progress.received} total={step.progress.total} className="mt-2" /> : null}
          <div className="mt-auto flex items-center justify-between gap-2 pt-3">
            <span className="flex items-center gap-1" title={required.map((r) => `${r.label}: ${plainWhy(r.why)}`).join("\n")}>
              {required.map((r) => (
                <Lamp key={r.id} tone={REQ_TONE[r.state]} className="size-1.5" />
              ))}
              <span className="ml-1 text-[11.5px] text-haze">
                {required.filter((r) => r.state === "ready" || r.state === "auto").length} of {required.length} {required.length === 1 ? "part" : "parts"}
              </span>
            </span>
            {action}
          </div>
          {error ? <p className="mt-2 text-[12px] text-tally">{error}</p> : null}
        </div>
      </div>
    </li>
  );
}
