"use client";

import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { useDirector } from "@/lib/director/store";
import { useCompiled } from "@/lib/director/use-compiled";
import { cameraHeight, horizontalFov, pedestalTo } from "@/lib/director/camera";
import { ANGLES, APERTURES, LENSES, LIGHT_SETUPS, MOODS, SHOT_SIZES, STYLES } from "@/lib/director/vocab";
import { ASPECTS, aspectById } from "@/lib/shot";
import { Slider } from "@/components/ui/Slider";
import { AngleGlyph, ApertureGlyph, LensGlyph, ShotSizeGlyph } from "./glyphs";
import { cn } from "@/lib/cn";

/**
 * Right panel: the shot, picked by sight, all in one list: how close, from where, the look and the frame. Lens, focus,
 * light and exact numbers wait under More (light comes from the place itself once it's built all around). Three tabs
 * hid Light and Look so well that even the user forgot them.
 */
export function ShotPanel() {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="p-3 pb-0">
        <ShotReadout />
      </div>
      <div className="scroll-thin mt-1 min-h-0 flex-1 overflow-y-auto px-3 pb-6">
        <CameraTab />
        <LookTab />
        <More title="Lens, focus and light">
          <CameraMore />
          <LightTab />
        </More>
      </div>
    </div>
  );
}

function More({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="mt-6">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="press squircle flex h-9 w-full items-center justify-between rounded-[12px] bg-white/[0.04] px-3 text-[12.5px] font-semibold text-fog hover:text-paper"
      >
        {title}
        <ChevronDown size={15} className={cn("transition-transform", open && "rotate-180")} />
      </button>
      {open ? children : null}
    </section>
  );
}

/** What the camera is doing right now, in film terms. */
function ShotReadout() {
  const scene = useDirector((s) => s.scene);
  const { sheet } = useCompiled();
  const get = (key: string) => sheet.find((s) => s.key === key)?.value;
  return (
    <div className="squircle rounded-[14px] bg-white/[0.03] px-3 py-2.5 shadow-[inset_0_0_0_1px_var(--color-line)]">
      <p className="truncate text-[14px] font-semibold">
        {get("shot")} <span className="text-haze">·</span> {get("angle")}
      </p>
      <p className="tabular mt-0.5 truncate font-mono text-[11.5px] text-haze">
        {Math.round(scene.camera.focal)}mm · f/{scene.camera.aperture} · {scene.aspect} · {scene.camera.distance.toFixed(1)} m away
      </p>
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="mt-5 first:mt-2">
      <div className="mb-2 flex items-baseline justify-between gap-2 px-0.5">
        <h3 className="label">{title}</h3>
        {hint ? <span className="text-[11.5px] text-haze">{hint}</span> : null}
      </div>
      {children}
    </section>
  );
}

function Tile({
  selected,
  onClick,
  visual,
  term,
  plain,
  image,
}: {
  selected: boolean;
  onClick: () => void;
  visual?: ReactNode;
  term: string;
  plain: string;
  image?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      title={plain}
      className={cn(
        "press squircle group flex flex-col rounded-[14px] p-1.5 text-left",
        selected ? "bg-white/[0.07] shadow-[inset_0_0_0_1.5px_var(--color-spike)]" : "hover:bg-white/[0.04]",
      )}
    >
      <div className={cn("relative grid aspect-[3/2] place-items-center overflow-hidden rounded-[9px] bg-white/[0.035]", selected ? "text-paper" : "text-paper/70")}>
        {image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={image} alt="" loading="lazy" className="size-full object-cover" onError={(e) => (e.currentTarget.style.display = "none")} />
        ) : (
          <div className="size-full p-1.5">{visual}</div>
        )}
      </div>
      <div className={cn("mt-1.5 px-0.5 text-[12.5px] font-semibold leading-tight", selected && "text-spike")}>{term}</div>
      <div className="line-clamp-1 px-0.5 pt-0.5 text-[11.5px] leading-snug text-haze">{plain}</div>
    </button>
  );
}

function CameraTab() {
  const { applyShotSize, applyAngle } = useDirector.getState();
  const { measured } = useCompiled();

  return (
    <>
      <Section title="Shot size" hint="How close">
        <div className="grid grid-cols-2 gap-1.5">
          {SHOT_SIZES.map((s) => (
            <Tile key={s.id} selected={measured.shotSize === s.id} onClick={() => applyShotSize(s.id)} visual={<ShotSizeGlyph share={s.body} />} term={s.term} plain={s.plain} />
          ))}
        </div>
      </Section>

      <Section title="Angle" hint="From where">
        <div className="grid grid-cols-2 gap-1.5">
          {ANGLES.map((g) => (
            <Tile
              key={g.id}
              selected={measured.angle === g.id || (g.id === "eye" && measured.angle === "ground")}
              onClick={() => applyAngle(g.id)}
              visual={<AngleGlyph elevation={g.elevation} />}
              term={g.term}
              plain={g.plain}
            />
          ))}
        </div>
      </Section>
    </>
  );
}

/** Lens, focus and exact camera numbers. */
function CameraMore() {
  const scene = useDirector((s) => s.scene);
  const { applyLens, setCamera, checkpoint } = useDirector.getState();
  const { measured } = useCompiled();
  const a = aspectById(scene.aspect);
  const cam = scene.camera;

  return (
    <>
      <Section title="Lens" hint="Same size, new perspective">
        <div className="grid grid-cols-2 gap-1.5">
          {LENSES.map((l) => (
            <Tile key={l.id} selected={measured.lens === l.id} onClick={() => applyLens(l.focal)} visual={<LensGlyph fov={horizontalFov(l.focal, a.w / a.h)} />} term={l.term} plain={l.plain} />
          ))}
        </div>
      </Section>

      <Section title="Focus" hint="Background blur">
        <div className="grid grid-cols-2 gap-1.5">
          {APERTURES.map((ap) => (
            <Tile key={ap.id} selected={measured.aperture === ap.id} onClick={() => setCamera({ aperture: ap.f })} visual={<ApertureGlyph f={ap.f} />} term={ap.term} plain={ap.plain} />
          ))}
        </div>
      </Section>

      <Section title="Fine-tune">
        <div className="squircle space-y-4 rounded-[14px] bg-white/[0.03] p-3.5 shadow-[inset_0_0_0_1px_var(--color-line)]">
          <Slider
            label="Distance"
            value={Math.log(cam.distance)}
            min={Math.log(0.4)}
            max={Math.log(60)}
            step={0.005}
            onStart={checkpoint}
            onChange={(v) => setCamera({ distance: Math.round(Math.exp(v) * 100) / 100 }, true)}
            format={(v) => `${Math.exp(v).toFixed(1)} m`}
            hint={["Closer", "Farther"]}
          />
          <Slider
            label="Camera height"
            value={Math.log(cameraHeight(cam))}
            min={Math.log(0.05)}
            max={Math.log(120)}
            step={0.005}
            onStart={checkpoint}
            onChange={(v) => setCamera(pedestalTo(cam, Math.exp(v)), true)}
            format={(v) => `${Math.exp(v) < 10 ? Math.exp(v).toFixed(2) : Math.round(Math.exp(v))} m`}
            hint={["Lower", "Higher"]}
          />
          <Slider
            label="Height angle"
            value={cam.elevation}
            min={-80}
            max={89}
            onStart={checkpoint}
            onChange={(v) => setCamera({ elevation: v }, true)}
            format={(v) => `${Math.round(v)}°`}
            hint={["Looking up", "Looking down"]}
          />
          <Slider
            label="Around the subject"
            value={normalize(cam.azimuth)}
            min={-180}
            max={180}
            onStart={checkpoint}
            onChange={(v) => setCamera({ azimuth: v }, true)}
            format={(v) => `${Math.round(v)}°`}
            hint={["Left side", "Right side"]}
          />
          <Slider
            label="Focal length"
            value={cam.focal}
            min={12}
            max={200}
            onStart={checkpoint}
            onChange={(v) => setCamera({ focal: v }, true)}
            format={(v) => `${Math.round(v)} mm`}
          />
          <Slider
            label="Dutch tilt"
            value={cam.roll}
            min={-30}
            max={30}
            onStart={checkpoint}
            onChange={(v) => setCamera({ roll: v }, true)}
            format={(v) => `${Math.round(v)}°`}
          />
        </div>
      </Section>
    </>
  );
}

/**
 * The place's own light (server/world-depth): put on the set when the place was measured; here to see what it was and
 * go back to it. Indoors it's soft and from above (a sun through a roof would be wrong); outdoors the sun when it's in
 * the sky, else the bright side of it.
 */
function PlaceLight() {
  const found = useDirector((s) => s.scene.place.world?.light);
  const light = useDirector((s) => s.scene.light);
  const indoor = useDirector((s) => s.scene.place.world?.depth?.indoor);
  if (!found) return <p className="mt-4 px-0.5 text-[12px] leading-snug text-haze">The place lights the shot. Set a light here only to change it.</p>;
  const same = Math.abs(normalize(light.azimuth - found.azimuth)) < 1 && Math.abs(light.elevation - found.elevation) < 1 && Math.abs(light.softness - found.softness) < 0.01 && light.kelvin === found.kelvin;
  const what = indoor ? "soft light from above, from the bright side of the room" : found.sun ? "the sun, where it is in the sky" : "daylight from the bright side of the sky";
  return (
    <div className="squircle mt-4 flex items-center gap-3 rounded-[14px] bg-white/[0.03] p-3 shadow-[inset_0_0_0_1px_var(--color-line)]">
      <p className="min-w-0 flex-1 text-[12px] leading-snug text-haze">
        <span className="font-semibold text-paper">Light from the place</span>: {what}, {found.kelvin} K.{same ? "" : " You've changed it."}
      </p>
      {same ? null : (
        <button
          onClick={() => {
            useDirector.getState().checkpoint();
            useDirector.getState().setLight({ azimuth: found.azimuth, elevation: found.elevation, softness: found.softness, kelvin: found.kelvin, mood: null }, true);
          }}
          className="press squircle shrink-0 rounded-[10px] bg-white/[0.08] px-2.5 py-1.5 text-[12px] font-semibold hover:bg-white/[0.12]"
        >
          Use it
        </button>
      )}
    </div>
  );
}

function LightTab() {
  const scene = useDirector((s) => s.scene);
  const { applyLightSetup, applyMood, setLight, checkpoint } = useDirector.getState();
  const { measured } = useCompiled();
  const light = scene.light;
  const world = Boolean(scene.place.world);

  return (
    <>
      {world ? <PlaceLight /> : null}
      <Section title="Key light" hint="Where it comes from">
        <div className="grid grid-cols-2 gap-1.5">
          {LIGHT_SETUPS.map((l) => (
            <Tile key={l.id} selected={measured.light === l.id} onClick={() => applyLightSetup(l.id)} image={`/assets/vocab-light-${l.id}.webp`} term={l.term} plain={l.plain} />
          ))}
        </div>
      </Section>

      <Section title="Time & mood">
        <div className="grid grid-cols-2 gap-1.5">
          {MOODS.map((m) => (
            <Tile
              key={m.id}
              selected={light.mood === m.id}
              onClick={() => applyMood(light.mood === m.id ? null : m.id)}
              image={`/assets/vocab-mood-${m.id}.webp`}
              term={m.term}
              plain={m.plain}
            />
          ))}
        </div>
      </Section>

      <Section title="Fine-tune">
        <div className="squircle space-y-4 rounded-[14px] bg-white/[0.03] p-3.5 shadow-[inset_0_0_0_1px_var(--color-line)]">
          <Slider
            label="Direction"
            value={normalize(light.azimuth - scene.camera.azimuth)}
            min={-180}
            max={180}
            onStart={checkpoint}
            onChange={(v) => setLight({ azimuth: scene.camera.azimuth + v }, true)}
            format={(v) => (Math.abs(v) < 15 ? "Front" : Math.abs(v) > 160 ? "Behind" : `${Math.abs(Math.round(v))}° ${v > 0 ? "right" : "left"}`)}
            hint={["From the left", "From the right"]}
          />
          <Slider
            label="Light height"
            value={light.elevation}
            min={-20}
            max={85}
            onStart={checkpoint}
            onChange={(v) => setLight({ elevation: v }, true)}
            format={(v) => `${Math.round(v)}°`}
            hint={["From below", "From above"]}
          />
          <Slider
            label="Softness"
            value={light.softness}
            min={0}
            max={1}
            step={0.01}
            onStart={checkpoint}
            onChange={(v) => setLight({ softness: v }, true)}
            format={(v) => (v < 0.25 ? "Hard" : v < 0.6 ? "Medium" : "Soft")}
            hint={["Crisp shadows", "No shadows"]}
          />
          <Slider
            label="Color"
            value={light.kelvin}
            min={1800}
            max={10000}
            step={50}
            onStart={checkpoint}
            onChange={(v) => setLight({ kelvin: v }, true)}
            format={(v) => `${Math.round(v / 50) * 50} K`}
            hint={["Warm", "Cool"]}
            track="linear-gradient(90deg, #ff8a2b, #ffc27a 25%, #fff1dc 45%, #f4f6ff 60%, #9cc4ff 100%)"
          />
        </div>
      </Section>
    </>
  );
}

function LookTab() {
  const scene = useDirector((s) => s.scene);
  const { setScene } = useDirector.getState();
  return (
    <>
      <Section title="Style">
        <div className="grid grid-cols-2 gap-1.5">
          {STYLES.map((s) => (
            <Tile key={s.id} selected={scene.style === s.id} onClick={() => setScene({ style: s.id })} image={`/assets/vocab-style-${s.id}.webp`} term={s.term} plain={s.plain} />
          ))}
        </div>
      </Section>
      <Section title="Frame">
        <div className="grid grid-cols-4 gap-1.5">
          {ASPECTS.map((a) => {
            const selected = scene.aspect === a.id;
            const max = 26;
            const w = a.w >= a.h ? max : (max * a.w) / a.h;
            const h = a.h >= a.w ? max : (max * a.h) / a.w;
            return (
              <button
                key={a.id}
                onClick={() => setScene({ aspect: a.id })}
                aria-pressed={selected}
                title={a.label}
                className={cn(
                  "press squircle flex flex-col items-center gap-1.5 rounded-[10px] py-2.5 text-[11.5px] font-semibold",
                  selected ? "bg-white/[0.07] text-spike shadow-[inset_0_0_0_1.5px_var(--color-spike)]" : "text-fog hover:bg-white/[0.04]",
                )}
              >
                <span className="grid h-7 place-items-center">
                  <span className="rounded-[3px] border-2 border-current" style={{ width: w, height: h }} />
                </span>
                {a.id}
              </button>
            );
          })}
        </div>
      </Section>
    </>
  );
}

const normalize = (deg: number) => ((((deg + 180) % 360) + 360) % 360) - 180;
