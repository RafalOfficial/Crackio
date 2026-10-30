"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { Search, Upload } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ICON_GLYPHS, ProjectIcon, SvgGlyph } from "./ProjectIcon";
import {
  NAME_MAX,
  PROJECT_COLORS,
  PROJECT_ICONS,
  SVG_MAX_BYTES,
  clampName,
  cleanName,
  isCustomIcon,
  nameLength,
  nameProblem,
  type ProjectInput,
} from "@/lib/library/types";
import { cn } from "@/lib/cn";

/**
 * Name, icon and color for a project: making a new one, or changing one. The icon at the top
 * is the live preview. Lives inside a popover, so it's sized for one (308px of content).
 */
export function ProjectEditor({
  initial,
  taken,
  submitLabel,
  onSubmit,
  onCancel,
  onDelete,
  deleteNote,
}: {
  initial: ProjectInput;
  /** The other projects' names. */
  taken: string[];
  submitLabel: string;
  onSubmit: (input: ProjectInput) => Promise<void>;
  onCancel?: () => void;
  /** Editing an existing project: offers Delete (two clicks). */
  onDelete?: () => Promise<void>;
  /** What deleting does to the project's takes. */
  deleteNote?: string;
}) {
  const [name, setName] = useState(initial.name);
  const [icon, setIcon] = useState(initial.icon);
  const [color, setColor] = useState(initial.color);
  // An uploaded .svg keeps its own spot in the grid, so picking a built-in icon doesn't lose it.
  const [custom, setCustom] = useState(isCustomIcon(initial.icon) ? initial.icon : null);
  const [find, setFind] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [arming, setArming] = useState(false);
  const disarm = useRef<ReturnType<typeof setTimeout>>(undefined);
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => () => clearTimeout(disarm.current), []);

  const icons = useMemo(() => {
    const q = find.trim().toLowerCase();
    return q ? PROJECT_ICONS.filter((i) => i.words.includes(q)) : PROJECT_ICONS;
  }, [find]);
  const length = nameLength(name);
  const isPreset = PROJECT_COLORS.includes(color);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const problem = nameProblem(name, taken);
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ name: cleanName(name), icon, color });
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  async function upload(f?: File) {
    if (!f) return;
    setError(null);
    if (f.size > SVG_MAX_BYTES) return setError(`Keep the .svg under ${Math.round(SVG_MAX_BYTES / 1000)} KB.`);
    const text = await f.text();
    if (!/<svg[\s>]/i.test(text)) return setError("That file isn't an .svg.");
    let binary = "";
    for (const b of new TextEncoder().encode(text)) binary += String.fromCharCode(b);
    const next = `svg:${btoa(binary)}`;
    setCustom(next);
    setIcon(next);
  }

  async function remove() {
    if (!onDelete) return;
    if (!arming) {
      setArming(true);
      clearTimeout(disarm.current);
      disarm.current = setTimeout(() => setArming(false), 3000);
      return;
    }
    setBusy(true);
    try {
      await onDelete();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
      setArming(false);
    }
  }

  return (
    <form onSubmit={submit} className="w-[308px]">
      <div className="flex items-center gap-3">
        <ProjectIcon icon={icon} color={color} size={44} tile />
        <label className="field-focus squircle flex h-11 min-w-0 flex-1 items-center gap-2 rounded-[13px] bg-apple pl-3 pr-2.5 shadow-[inset_0_0_0_1px_var(--color-line)]">
          <input
            value={name}
            autoFocus
            onChange={(e) => {
              setName((e.nativeEvent as InputEvent).isComposing ? e.target.value : clampName(e.target.value));
              setError(null);
            }}
            onCompositionEnd={(e) => setName(clampName(e.currentTarget.value))}
            placeholder="Project name"
            aria-label="Project name"
            className="min-w-0 flex-1 bg-transparent text-[14px] font-semibold text-paper outline-none placeholder:font-normal placeholder:text-haze"
          />
          <span className={cn("tabular shrink-0 text-[11.5px]", length >= NAME_MAX ? "text-tungsten" : "text-haze")}>
            {length}/{NAME_MAX}
          </span>
        </label>
      </div>
      {error ? <p className="mt-2 text-[12.5px] leading-snug text-tally">{error}</p> : null}

      <p className="label mb-2 mt-4">Color</p>
      <div className="grid grid-cols-[repeat(13,minmax(0,1fr))] gap-[5px]" role="radiogroup" aria-label="Color">
        {PROJECT_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={color === c}
            aria-label={c}
            title={c}
            onClick={() => setColor(c)}
            className={cn(
              "press aspect-square rounded-full",
              color === c ? "shadow-[0_0_0_2px_var(--color-apple-2),0_0_0_3.5px_var(--color-paper)]" : "hover:scale-110",
            )}
            style={{ background: c }}
          />
        ))}
        {/* Any other color: the system color picker. */}
        <label
          title="Any color"
          className={cn(
            "press relative aspect-square cursor-pointer rounded-full",
            !isPreset ? "shadow-[0_0_0_2px_var(--color-apple-2),0_0_0_3.5px_var(--color-paper)]" : "hover:scale-110",
          )}
          style={{ background: isPreset ? "conic-gradient(from 90deg, #ff5c74, #f2b54b, #e8d35a, #5ad78f, #3fd0c0, #6f95ff, #d784ff, #ff5c74)" : color }}
        >
          <input
            type="color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            aria-label="Any color"
            className="absolute inset-0 size-full cursor-pointer opacity-0"
          />
        </label>
      </div>

      <div className="mb-2 mt-4 flex items-center justify-between gap-3">
        <p className="label">Icon</p>
        <label className="field-focus squircle flex h-7 w-[150px] items-center gap-1.5 rounded-[9px] bg-apple px-2 shadow-[inset_0_0_0_1px_var(--color-line)]">
          <Search size={12} className="shrink-0 text-haze" />
          <input
            value={find}
            onChange={(e) => setFind(e.target.value)}
            onKeyDown={(e) => {
              // Enter takes the first match instead of sending the form.
              if (e.key !== "Enter") return;
              e.preventDefault();
              if (icons[0]) setIcon(icons[0].id);
            }}
            placeholder="Find an icon"
            aria-label="Find an icon"
            className="min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:text-haze"
          />
        </label>
      </div>
      <div
        role="radiogroup"
        aria-label="Icon"
        className="project-tint scroll-thin -mx-1 grid max-h-[178px] grid-cols-8 gap-0.5 overflow-y-auto px-1 pb-1"
        style={{ "--hue": color } as CSSProperties}
      >
        <button
          type="button"
          onClick={() => file.current?.click()}
          title="Upload your own .svg"
          aria-label="Upload your own .svg"
          className="press squircle grid aspect-square place-items-center rounded-[10px] text-haze shadow-[inset_0_0_0_1px_var(--color-line)] hover:bg-white/[0.06] hover:text-paper"
        >
          <Upload size={15} />
        </button>
        {custom ? (
          <IconChoice selected={icon === custom} onPick={() => setIcon(custom)} label="Your .svg">
            <SvgGlyph icon={custom} size={17} />
          </IconChoice>
        ) : null}
        {icons.map((i) => {
          const Glyph = ICON_GLYPHS[i.id];
          return (
            <IconChoice key={i.id} selected={icon === i.id} onPick={() => setIcon(i.id)} label={i.id.replace(/-/g, " ")}>
              <Glyph size={17} strokeWidth={2} />
            </IconChoice>
          );
        })}
        {!icons.length ? <p className="col-span-8 py-3 text-center text-[12px] text-haze">No icon for &ldquo;{find.trim()}&rdquo;</p> : null}
      </div>
      <input
        ref={file}
        type="file"
        accept=".svg,image/svg+xml"
        hidden
        onChange={(e) => {
          void upload(e.target.files?.[0]);
          e.target.value = "";
        }}
      />

      <div className="mt-4 flex items-center gap-2">
        {onDelete ? (
          <button
            type="button"
            onClick={() => void remove()}
            disabled={busy}
            title={deleteNote}
            className={cn(
              "press squircle h-8 rounded-[11px] px-2.5 text-[12.5px] font-semibold disabled:opacity-45",
              arming ? "bg-tally text-white" : "text-tally hover:bg-tally/10",
            )}
          >
            {arming ? "Click again to delete" : "Delete project"}
          </button>
        ) : null}
        <div className="ml-auto flex items-center gap-1.5">
          {onCancel ? (
            <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
              Cancel
            </Button>
          ) : null}
          <Button type="submit" variant="paper" size="sm" disabled={busy || !cleanName(name)}>
            {submitLabel}
          </Button>
        </div>
      </div>
      {arming && deleteNote ? <p className="mt-2 text-[12px] leading-snug text-fog">{deleteNote}</p> : null}
    </form>
  );
}

function IconChoice({ selected, onPick, label, children }: { selected: boolean; onPick: () => void; label: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={label}
      title={label}
      onClick={onPick}
      className={cn(
        "press squircle grid aspect-square place-items-center rounded-[10px]",
        selected
          ? "bg-[color-mix(in_oklab,var(--tint)_16%,transparent)] text-[var(--tint)] shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--tint)_40%,transparent)]"
          : "text-fog hover:bg-white/[0.06] hover:text-[var(--tint)]",
      )}
    >
      {children}
    </button>
  );
}
