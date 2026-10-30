"use client";

import { type ReactNode } from "react";
import { ChevronDown, Copy, Film, Gauge, ImageIcon, Music2, Scissors, Sparkles, SunDim, Timer, Trash2, Volume2, VolumeX, ZoomIn } from "lucide-react";
import { useEditor } from "@/lib/storyboard/edit-store";
import { lengthOf, MAX_STILL_SECONDS, speedOf, type EditClip } from "@/lib/storyboard/edit";
import { patchClip } from "@/lib/storyboard/edit-ops";
import { Popover } from "@/components/ui/Popover";
import { ToolButton, ToolGroup, ToolPill } from "@/components/director/TitleBar";
import { cut, fileOfClip } from "./Timeline";
import { cn } from "@/lib/cn";

/**
 * Everything the selected shot can do, in the timeline's bar (CapCut's way): how long a picture stays and whether it
 * pushes in, a clip's trim, speed and sound, fill or fit, fades, and for a picture the one that matters most, making
 * it move. Nothing selected, the bar shows the next step instead (Timeline).
 */
export function ShotTools({ clip, music, number }: { clip: EditClip; music: boolean; number: number | null }) {
  const change = useEditor((s) => s.change);
  const set = (patch: Partial<EditClip>) => change((t) => patchClip(t, clip.id, patch));
  const live = (patch: Partial<EditClip>) => change((t) => patchClip(t, clip.id, patch), true);
  const start = () => useEditor.getState().checkpoint();
  const length = lengthOf(clip);
  const Kind = clip.kind === "image" ? ImageIcon : clip.kind === "video" ? Film : Music2;
  const making = Boolean(clip.making);

  return (
    <>
      <ToolGroup>
        <span className="flex h-8 items-center gap-1.5 px-2 text-[12.5px] font-semibold text-paper" title={clip.name}>
          {number ? <span className="tabular grid h-5 min-w-5 place-items-center rounded-[6px] bg-white/[0.12] px-1 font-mono text-[11px]">{number}</span> : null}
          <Kind size={13} className="text-haze" />
          <span className="tabular">{length.toFixed(1)}s</span>
        </span>
      </ToolGroup>

      <ToolGroup label="Shot settings">
        {clip.kind === "image" ? (
          <>
            <Menu icon={<Timer size={14} />} label="Length" title="How long the picture stays on screen">
              <Setting title="On screen" value={`${length.toFixed(1)} s`}>
                <Slider value={clip.out} min={0.5} max={Math.min(MAX_STILL_SECONDS, 15)} step={0.1} onStart={start} onChange={(v) => live({ out: v })} />
              </Setting>
            </Menu>
            <ToolPill title="A slow push in while it's on screen" active={Boolean(clip.push)} onClick={() => set({ push: !clip.push || undefined })}>
              <ZoomIn size={14} /> <span className="hidden xl:inline">Push in</span>
            </ToolPill>
          </>
        ) : (
          <>
            <Menu icon={<Scissors size={14} />} label="Trim" title="Which part of it plays">
              <div className="grid grid-cols-2 gap-2">
                <NumberField label="From" value={clip.in} onChange={(v) => set({ in: v })} />
                <NumberField label="To" value={clip.out} onChange={(v) => set({ out: v })} />
              </div>
              {clip.length ? <p className="mt-2 text-[11.5px] text-haze">The whole {clip.kind === "audio" ? "sound" : "clip"} is {clip.length.toFixed(1)} s. Or drag its edges on the timeline.</p> : null}
            </Menu>
            <Menu icon={<Gauge size={14} />} label={`${speedOf(clip)}×`} title="Speed">
              <div className="grid grid-cols-3 gap-1">
                {[0.5, 0.75, 1, 1.5, 2, 3].map((s) => (
                  <Chip key={s} on={speedOf(clip) === s} onClick={() => set({ speed: s })}>
                    {s}×
                  </Chip>
                ))}
              </div>
            </Menu>
            {clip.kind === "video" && clip.sound === false ? null : (
              <Menu icon={clip.muted ? <VolumeX size={14} /> : <Volume2 size={14} />} label={clip.muted ? "Muted" : `${Math.round((clip.volume ?? (music ? 0.8 : 1)) * 100)}%`} title="Sound">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => set({ muted: !clip.muted || undefined })}
                    aria-pressed={Boolean(clip.muted)}
                    title={clip.muted ? "Unmute" : "Mute"}
                    className="press squircle grid size-8 shrink-0 place-items-center rounded-[10px] bg-white/[0.06] text-fog hover:bg-white/[0.1] hover:text-paper"
                  >
                    {clip.muted ? <VolumeX size={15} /> : <Volume2 size={15} />}
                  </button>
                  <Slider value={clip.volume ?? (music ? 0.8 : 1)} min={0} max={1} step={0.01} disabled={clip.muted} onStart={start} onChange={(v) => live({ volume: v })} />
                </div>
              </Menu>
            )}
          </>
        )}
        {!music ? (
          <ToolPill
            title={clip.fit === "fit" ? "Fit: all of it inside the frame (click to fill)" : "Fill: the frame is full, what spills over is cropped (click to fit)"}
            active={clip.fit === "fit"}
            onClick={() => set({ fit: clip.fit === "fit" ? undefined : "fit", ...(clip.fit !== "fit" ? { push: undefined } : {}) })}
          >
            <span className="rounded-[3px] border-[1.5px] border-current px-[3px] text-[9px] leading-[11px]">{clip.fit === "fit" ? "FIT" : "FILL"}</span>
          </ToolPill>
        ) : null}
        <Menu icon={<SunDim size={14} />} label="Fade" title="Fade in from black and out to it">
          <Setting title="In">
            <Fades value={clip.fadeIn ?? 0} onChange={(v) => set({ fadeIn: v || undefined })} />
          </Setting>
          <Setting title="Out">
            <Fades value={clip.fadeOut ?? 0} onChange={(v) => set({ fadeOut: v || undefined })} />
          </Setting>
        </Menu>
      </ToolGroup>

      {clip.kind === "image" && !music ? (
        <button
          type="button"
          disabled={making}
          onClick={() => useEditor.getState().setPick({ file: fileOfClip(clip), clip: clip.id })}
          className="press squircle inline-flex h-10 shrink-0 items-center gap-1.5 rounded-[12px] bg-spike px-3 text-[12.5px] font-bold text-spike-ink hover:bg-spike-hi disabled:opacity-60"
          title="Turn this picture into a moving shot"
        >
          <Sparkles size={14} /> {making ? "Making it move…" : "Make it move"}
        </button>
      ) : null}

      <ToolGroup label="Edit">
        <ToolButton label="Split at the playhead (S)" onClick={cut.split}>
          <Scissors size={15} />
        </ToolButton>
        <ToolButton label="Duplicate (Ctrl+D)" onClick={cut.duplicate}>
          <Copy size={15} />
        </ToolButton>
        <ToolButton label="Delete (Del)" onClick={cut.remove}>
          <Trash2 size={15} />
        </ToolButton>
      </ToolGroup>
    </>
  );
}

function Menu({ icon, label, title, children }: { icon: ReactNode; label: string; title: string; children: ReactNode }) {
  return (
    <Popover
      placement="top-start"
      panelClassName="w-[264px] p-3"
      trigger={({ open, toggle }) => (
        <ToolPill title={title} onClick={toggle} active={open}>
          {icon} <span className="tabular hidden lg:inline">{label}</span>
          <ChevronDown size={12} className="text-haze" />
        </ToolPill>
      )}
    >
      {() => (
        <div>
          <p className="mb-2.5 text-[12.5px] font-semibold">{title}</p>
          {children}
        </div>
      )}
    </Popover>
  );
}

function Setting({ title, value, children }: { title: string; value?: string; children: ReactNode }) {
  return (
    <div className="mt-2.5 first:mt-0">
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="label">{title}</span>
        {value ? <span className="tabular text-[11.5px] text-haze">{value}</span> : null}
      </div>
      {children}
    </div>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={cn("press squircle tabular h-8 rounded-[10px] text-[12px] font-semibold", on ? "bg-paper text-[#16131b]" : "bg-white/[0.05] text-fog hover:bg-white/[0.09] hover:text-paper")}
    >
      {children}
    </button>
  );
}

const FADES = [0, 0.25, 0.5, 1, 2];

function Fades({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="grid grid-cols-5 gap-1">
      {FADES.map((f) => (
        <Chip key={f} on={Math.abs(value - f) < 0.01} onClick={() => onChange(f)}>
          {f ? `${f}s` : "None"}
        </Chip>
      ))}
    </div>
  );
}

function Slider({ value, min, max, step, onChange, onStart, disabled }: { value: number; min: number; max: number; step: number; onChange: (v: number) => void; onStart?: () => void; disabled?: boolean }) {
  return (
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      onPointerDown={onStart}
      onKeyDown={onStart}
      onChange={(e) => onChange(Number(e.target.value))}
      className="block w-full accent-[var(--color-spike)] disabled:opacity-40"
    />
  );
}

function NumberField({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <label className="squircle flex h-10 items-center gap-2 rounded-[12px] bg-white/[0.05] px-3 shadow-[inset_0_0_0_1px_var(--color-line)] focus-within:shadow-[inset_0_0_0_1px_var(--color-line-strong)]">
      <span className="text-[11.5px] text-haze">{label}</span>
      <input
        key={value}
        type="number"
        defaultValue={Math.round(value * 100) / 100}
        step={0.1}
        min={0}
        onBlur={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v) && Math.abs(v - value) > 0.001) onChange(v);
        }}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        className="tabular min-w-0 flex-1 bg-transparent text-right font-mono text-[13px] text-paper outline-none"
      />
      <span className="text-[11.5px] text-haze">s</span>
    </label>
  );
}
