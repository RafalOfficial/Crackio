"use client";

import { useRef, useState } from "react";
import { toolBySlug } from "@/lib/tools";
import { LIGHT_SETUPS, MOODS, kelvinToRgb } from "@/lib/director/vocab";
import { describeLight, relightPrompt, type Light } from "@/lib/relight";
import { Slider } from "@/components/ui/Slider";
import { Switch } from "@/components/ui/Panel";
import { ControlSection, EditToolShell } from "./EditToolShell";
import { cn } from "@/lib/cn";

export function RelightTool() {
  const tool = toolBySlug("relight")!;
  const [light, setLight] = useState<Light>({ azimuth: 55, elevation: 40, softness: 0.3, kelvin: 3400, mood: null, background: true });
  const set = (p: Partial<Light>) => setLight((l) => ({ ...l, ...p }));

  return (
    <EditToolShell
      tool={tool}
      hint="A portrait, product or scene. Then move the light until it looks right."
      actionLabel="Relight"
      compile={() => ({
        summary: `Relight · ${describeLight(light).split(";")[0]}`,
        prompt: relightPrompt(light),
        params: { light },
      })}
      controls={() => (
        <>
          <ControlSection title="Light setup" hint="Pick by look">
            <div className="grid grid-cols-2 gap-1.5">
              {LIGHT_SETUPS.map((s) => {
                const active = Math.abs(light.azimuth - s.offset) < 8 && Math.abs(light.elevation - s.elevation) < 8;
                return (
                  <button
                    key={s.id}
                    onClick={() => set({ azimuth: s.offset, elevation: s.elevation })}
                    aria-pressed={active}
                    className={cn("press squircle flex flex-col rounded-[14px] p-1.5 text-left", active ? "bg-apple-2 shadow-[inset_0_0_0_1.5px_var(--color-spike)]" : "hover:bg-apple-2/70")}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={`/assets/vocab-light-${s.id}.webp`} alt="" className="aspect-[3/2] w-full rounded-[9px] object-cover" />
                    <span className={cn("mt-1.5 block px-0.5 text-[12.5px] font-semibold", active && "text-spike")}>{s.term}</span>
                    <span className="line-clamp-2 block px-0.5 text-[11.5px] leading-snug text-haze">{s.plain}</span>
                  </button>
                );
              })}
            </div>
          </ControlSection>

          <ControlSection title="Direction" hint="Seen from above · camera at the bottom">
            <LightRing azimuth={light.azimuth} kelvin={light.kelvin} onChange={(azimuth) => set({ azimuth })} />
          </ControlSection>

          <ControlSection title="Fine-tune">
            <div className="space-y-4 rounded-[14px] bg-flat p-3.5">
              <Slider label="Height" value={light.elevation} min={-20} max={85} origin={0} onChange={(elevation) => set({ elevation })} format={(v) => `${Math.round(v)}°`} hint={["From below", "From above"]} />
              <Slider
                label="Softness"
                value={light.softness}
                min={0}
                max={1}
                step={0.01}
                onChange={(softness) => set({ softness })}
                format={(v) => (v < 0.25 ? "Hard" : v < 0.6 ? "Medium" : "Soft")}
                hint={["Crisp shadows", "No shadows"]}
              />
              <Slider
                label="Color"
                value={light.kelvin}
                min={1800}
                max={10000}
                step={50}
                onChange={(kelvin) => set({ kelvin })}
                format={(v) => `${Math.round(v / 50) * 50} K`}
                hint={["Warm", "Cool"]}
                track="linear-gradient(90deg, #ff8a2b, #ffc27a 25%, #fff1dc 45%, #f4f6ff 60%, #9cc4ff 100%)"
              />
            </div>
          </ControlSection>

          <ControlSection title="Time & mood" hint="Optional">
            <div className="grid grid-cols-4 gap-1.5">
              {MOODS.map((m) => (
                <button
                  key={m.id}
                  onClick={() => set(light.mood === m.id ? { mood: null } : { mood: m.id, kelvin: m.kelvin, softness: m.softness })}
                  aria-pressed={light.mood === m.id}
                  title={m.plain}
                  className={cn("press squircle rounded-[10px] p-1 text-center", light.mood === m.id ? "bg-apple-2 shadow-[inset_0_0_0_1.5px_var(--color-spike)]" : "hover:bg-apple-2/70")}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`/assets/vocab-mood-${m.id}.webp`} alt="" className="aspect-square w-full rounded-[7px] object-cover" />
                  <span className="mt-1 block text-[10.5px] font-semibold leading-tight">{m.term}</span>
                </button>
              ))}
            </div>
          </ControlSection>

          <div className="mt-5 flex items-center justify-between gap-3 rounded-[12px] bg-flat px-3.5 py-3 text-[13px]">
            <span>
              <span className="block font-semibold">Relight the background too</span>
              <span className="text-[12px] text-haze">Off keeps the background&rsquo;s light as it is.</span>
            </span>
            <Switch checked={light.background} onChange={(v) => set({ background: v })} title="Relight the background too" />
          </div>
        </>
      )}
    />
  );
}

function LightRing({ azimuth, kelvin, onChange }: { azimuth: number; kelvin: number; onChange: (az: number) => void }) {
  const ref = useRef<SVGSVGElement>(null);
  const [r, g, b] = kelvinToRgb(kelvin);
  const color = `rgb(${r} ${g} ${b})`;
  const rad = (azimuth * Math.PI) / 180;
  // Camera sits at the bottom of the ring; positive azimuth = light on the right.
  // Rounded so server and browser render identical numbers.
  const lx = round2(Math.sin(rad) * 62);
  const ly = round2(Math.cos(rad) * 62);
  const set = (e: React.PointerEvent) => {
    const box = ref.current!.getBoundingClientRect();
    const dx = e.clientX - (box.left + box.width / 2);
    const dy = e.clientY - (box.top + box.height / 2);
    onChange(Math.round((Math.atan2(dx, dy) * 180) / Math.PI));
  };
  return (
    <svg
      ref={ref}
      viewBox="-90 -90 180 180"
      className="mx-auto w-full max-w-[260px] cursor-grab touch-none rounded-[14px] bg-flat outline-none focus-visible:shadow-[0_0_0_2px_var(--color-spike)] active:cursor-grabbing"
      onPointerDown={(e) => {
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
        set(e);
      }}
      onPointerMove={(e) => e.buttons && set(e)}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 15 : 5;
        const turn = e.key === "ArrowRight" || e.key === "ArrowUp" ? step : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -step : 0;
        if (!turn) return;
        e.preventDefault();
        onChange(((((azimuth + turn + 180) % 360) + 360) % 360) - 180);
      }}
      tabIndex={0}
      role="slider"
      aria-label="Light direction"
      aria-valuemin={-180}
      aria-valuemax={180}
      aria-valuenow={azimuth}
      aria-valuetext={Math.abs(azimuth) < 15 ? "From the front" : Math.abs(azimuth) > 160 ? "From behind" : `${Math.abs(Math.round(azimuth))} degrees ${azimuth > 0 ? "right" : "left"}`}
    >
      <defs>
        <radialGradient id="ring-head" cx={round2(0.5 + Math.sin(rad) * 0.35)} cy={round2(0.5 + Math.cos(rad) * 0.35)}>
          <stop offset="0%" stopColor={color} />
          <stop offset="100%" stopColor="#202227" />
        </radialGradient>
      </defs>
      <circle r={62} fill="none" stroke="rgb(255 255 255 / 0.1)" strokeDasharray="3 4" />
      <line x1={lx} y1={ly} x2={0} y2={0} stroke={color} strokeOpacity={0.5} strokeWidth={2} />
      {/* Subject from above: head with nose pointing at the camera */}
      <circle r={20} fill="url(#ring-head)" stroke="rgb(255 255 255 / 0.15)" />
      <path d="M -5 18 L 0 26 L 5 18 Z" fill="#a3a5ac" />
      {/* Camera at the bottom */}
      <g transform="translate(0 78)">
        <rect x={-8} y={-6} width={16} height={11} rx={2.5} fill="#f3f2ee" />
        <path d="M -5 -6 L 0 -11 L 5 -6 Z" fill="#ff5b2e" />
      </g>
      <circle cx={lx} cy={ly} r={16} fill={color} fillOpacity={0.18} />
      <circle cx={lx} cy={ly} r={8} fill={color} stroke="#101114" strokeWidth={2} />
    </svg>
  );
}

const round2 = (n: number) => Math.round(n * 100) / 100;
