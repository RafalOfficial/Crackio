"use client";

import { useState } from "react";
import { toolBySlug } from "@/lib/tools";
import { ASPECTS, type AspectId } from "@/lib/shot";
import { Segmented } from "@/components/ui/Panel";
import { Slider } from "@/components/ui/Slider";
import { AspectGlyph } from "@/components/ui/AspectGlyph";
import { ControlSection, EditToolShell } from "./EditToolShell";
import { VideoUpscale } from "./VideoUpscale";
import { isCustomModel } from "@/lib/hooks/use-custom-models";
import type { Caps } from "@/lib/models/caps";
import { cn } from "@/lib/cn";

type Mode = "upscale" | "reframe" | "video";

const FLAVORS = [
  { id: "photo", term: "Photo", plain: "Natural texture for photographs" },
  { id: "sublime", term: "Art & renders", plain: "Clean edges for illustrations and 3D" },
  { id: "photo_denoiser", term: "Noisy photo", plain: "Cleans grain from low-light shots" },
] as const;

/** The factors a Custom-tab upscaler offers: its own list, or whole steps across its range (up to 8×). */
function scaleChoices(caps: Caps | null): number[] | null {
  const s = caps?.scale;
  if (!s) return null;
  if (s.choices?.length) return [...new Set(s.choices)].sort((a, b) => a - b).slice(0, 6);
  const lo = Math.max(1, Math.ceil(s.min));
  const hi = Math.min(8, Math.floor(s.max));
  return [2, 3, 4, 6, 8].filter((n) => n >= lo && n <= hi);
}

/** The factor that will be used: yours, snapped to what a Custom-tab upscaler offers (null when it has no setting). */
function factorFor(id: string | null, caps: Caps | null, wanted: number): number | null {
  if (!isCustomModel(id)) return wanted;
  const list = scaleChoices(caps);
  if (!list?.length) return null;
  return list.reduce((b, v) => (Math.abs(v - wanted) < Math.abs(b - wanted) ? v : b));
}

export function UpscaleTool() {
  const tool = toolBySlug("upscale")!;
  const [mode, setMode] = useState<Mode>("upscale");
  const [scale, setScale] = useState<number>(2);
  const [creativity, setCreativity] = useState(0);
  const [flavor, setFlavor] = useState<(typeof FLAVORS)[number]["id"]>("photo");
  const [target, setTarget] = useState<AspectId>("16:9");
  const [fill, setFill] = useState("");

  const modeSwitch = (
    <ControlSection title="What to do">
      <Segmented
        value={mode}
        onChange={setMode}
        options={[
          { id: "upscale", label: "Upscale" },
          { id: "reframe", label: "Reframe" },
          { id: "video", label: "Video", title: "Upscale a clip to 1080p, 2K or 4K" },
        ]}
      />
    </ControlSection>
  );

  // Clips have their own section: a clip in, the upscalers that take one, the size it ends at.
  if (mode === "video") return <VideoUpscale tool={tool} modeSwitch={modeSwitch} />;

  return (
    <EditToolShell
      tool={tool}
      kind={mode}
      allowTakes={false}
      hint={mode === "upscale" ? "Any image. Small or soft ones gain the most." : "Any image. Crackio extends the scene around it."}
      actionLabel={({ id, caps }) => {
        if (mode !== "upscale") return `Reframe to ${target}`;
        const s = factorFor(id, caps, scale);
        return s ? `Upscale ${s}×` : "Upscale";
      }}
      upscaleBy={({ id, caps }) => (mode === "upscale" ? (factorFor(id, caps, scale) ?? scale) : null)}
      compile={(_, { id, caps }) =>
        mode === "upscale"
          ? {
              prompt: "",
              summary: `Upscale${factorFor(id, caps, scale) ? ` ${factorFor(id, caps, scale)}×` : ""}${creativity > 0 ? ` · creativity ${Math.round(creativity * 100)}%` : ""}`,
              params: { options: { scale: factorFor(id, caps, scale) ?? scale, creativity, flavor } },
            }
          : {
              prompt: fill.trim(),
              summary: `Reframe to ${target}${fill.trim() ? ` · ${fill.trim()}` : ""}`,
              params: { options: { targetAspect: target } },
            }
      }
      controls={(_, modelId, caps) => {
        // A Custom-tab upscaler offers its own factors (or none: it upscales by a set amount).
        const custom = isCustomModel(modelId);
        const factors = custom ? scaleChoices(caps) : [2, 4];
        return (
        <>
          {modeSwitch}

          {mode === "upscale" ? (
            <>
              <ControlSection title="Size" hint={custom && !factors?.length ? "Set by the model" : undefined}>
                {custom && !factors?.length ? (
                  <p className="rounded-[12px] bg-white/[0.03] px-3 py-2.5 text-[12.5px] text-haze">This model upscales by a fixed amount.</p>
                ) : null}
                <div className={cn("grid gap-1.5", (factors?.length ?? 0) > 2 ? "grid-cols-3" : "grid-cols-2")}>
                  {(factors ?? []).map((s) => (
                    <button
                      key={s}
                      onClick={() => setScale(s)}
                      aria-pressed={factorFor(modelId, caps, scale) === s}
                      className={cn(
                        "press squircle flex flex-col rounded-[14px] px-3 py-3 text-left",
                        factorFor(modelId, caps, scale) === s ? "bg-white/[0.07] shadow-[inset_0_0_0_1.5px_var(--color-spike)]" : "shadow-[inset_0_0_0_1px_var(--color-line)] hover:bg-white/[0.03]",
                      )}
                    >
                      <span className={cn("block font-display text-[22px]", factorFor(modelId, caps, scale) === s && "text-spike")}>{s}×</span>
                      <span className="text-[12px] text-haze">{s === 2 ? "Twice the width and height" : s === 4 ? "Four times, for print" : `${s} times the width and height`}</span>
                    </button>
                  ))}
                </div>
              </ControlSection>
              {!modelId || (!custom && modelId.includes("crystal-upscaler")) ? (
              <ControlSection title="Creativity">
                <Slider
                  label="New detail"
                  value={creativity}
                  min={0}
                  max={1}
                  step={0.05}
                  onChange={setCreativity}
                  format={(v) => (v === 0 ? "Faithful" : v < 0.5 ? "Light" : "Strong")}
                  hint={["Keep it exact", "Invent texture"]}
                />
              </ControlSection>
              ) : null}
              {!custom && modelId?.includes("precision") ? (
              <ControlSection title="Kind of image">
                <div className="space-y-1.5">
                  {FLAVORS.map((f) => (
                    <button
                      key={f.id}
                      onClick={() => setFlavor(f.id)}
                      aria-pressed={flavor === f.id}
                      className={cn(
                        "press squircle flex w-full items-baseline justify-between gap-3 rounded-[12px] px-3 py-2 text-left",
                        flavor === f.id ? "bg-white/[0.07]" : "hover:bg-white/[0.03]",
                      )}
                    >
                      <span className={cn("text-[13.5px] font-semibold", flavor === f.id && "text-spike")}>{f.term}</span>
                      <span className="text-[12px] text-haze">{f.plain}</span>
                    </button>
                  ))}
                </div>
              </ControlSection>
              ) : null}
            </>
          ) : (
            <>
              <ControlSection title="New frame">
                <div className="grid grid-cols-4 gap-1.5">
                  {ASPECTS.filter((a) => a.id !== "21:9").map((a) => (
                    <button
                      key={a.id}
                      onClick={() => setTarget(a.id)}
                      aria-pressed={target === a.id}
                      title={a.label}
                      className={cn(
                        "flex flex-col items-center gap-1.5 rounded-[10px] py-2.5 text-[11.5px] font-semibold",
                        target === a.id ? "bg-white/[0.07] text-spike shadow-[inset_0_0_0_1.5px_var(--color-spike)]" : "text-fog hover:bg-white/[0.03]",
                      )}
                    >
                      <AspectGlyph id={a.id} max={20} />
                      {a.id}
                    </button>
                  ))}
                </div>
              </ControlSection>
              <ControlSection title="What fills the new space" hint="Optional, any language">
                <textarea
                  value={fill}
                  onChange={(e) => setFill(e.target.value)}
                  rows={2}
                  placeholder="more of the beach and sky"
                  className="w-full resize-none rounded-[12px] bg-white/[0.02] px-3 py-2.5 text-[13.5px] outline-none shadow-[inset_0_0_0_1px_var(--color-line)] placeholder:text-haze focus:shadow-[inset_0_0_0_1px_var(--color-line-strong)]"
                />
              </ControlSection>
            </>
          )}
        </>
        );
      }}
    />
  );
}
