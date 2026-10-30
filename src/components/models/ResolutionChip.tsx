"use client";

import { useEffect, useRef } from "react";
import { ChevronDown } from "lucide-react";
import { MenuItem, Popover } from "@/components/ui/Popover";
import { resolveAuto, useModels } from "@/lib/hooks/use-models";
import { useModelInfo } from "@/lib/hooks/use-custom-models";
import { fitResolution } from "@/lib/models/caps";
import { cn } from "@/lib/cn";

/**
 * A picture model's resolution as a chip beside its picker, for tools that keep it with their work (Storyboard's frames,
 * Cast's sheets): the choices the model itself offers (models/builtin-caps: Draft to 4K on your GPU, 1K to 4K on Comfy
 * Cloud, 1K or 2K on Grok), nothing when it has no choice. A saved value the model doesn't take moves to the nearest one
 * it does, so a job never asks a model for a size it can't make.
 */
export function ResolutionChip({
  model,
  value,
  onChange,
  placement = "bottom-end",
  className,
}: {
  /** The picture model, or "auto" for the one Auto picks. */
  model: string | null;
  /** The saved resolution; null for the model's own default. */
  value: string | null;
  onChange: (value: string) => void;
  placement?: "bottom-end" | "top-start";
  className?: string;
}) {
  const { models, defaults } = useModels();
  const id = !model || model === "auto" ? (resolveAuto("image", models, defaults)?.id ?? null) : model;
  const caps = useModelInfo(id).caps;
  const choices = caps?.resolution?.choices ?? [];
  const fitted = choices.length ? String(fitResolution(choices, value ?? undefined, caps?.resolution?.default ?? null) ?? choices[0].value) : null;
  // Asked once per move, while a saved value catches up.
  const moved = useRef<string | null>(null);
  useEffect(() => {
    if (!fitted || value === null || fitted === value || moved.current === `${value}>${fitted}`) return;
    moved.current = `${value}>${fitted}`;
    onChange(fitted);
  }, [fitted, value, onChange]);
  if (!fitted || choices.length < 2) return null;
  const label = choices.find((c) => String(c.value) === fitted)?.label ?? fitted;
  return (
    <Popover
      placement={placement}
      panelClassName="w-[150px] p-1"
      trigger={({ open, toggle }) => (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-haspopup="menu"
          title="The resolution the pictures are made at"
          className={cn("press inline-flex h-9 items-center gap-1 rounded-chip bg-apple-2 px-2.5 text-[13px] font-semibold text-paper hover:bg-gaffer", open && "bg-gaffer", className)}
        >
          {label}
          <ChevronDown size={13} className={cn("text-haze transition-transform", open && "rotate-180")} />
        </button>
      )}
    >
      {(close) => (
        <div role="menu" aria-label="Resolution">
          {choices.map((c) => (
            <MenuItem
              key={String(c.value)}
              selected={String(c.value) === fitted}
              onSelect={() => {
                onChange(String(c.value));
                close();
              }}
            >
              {c.label}
            </MenuItem>
          ))}
        </div>
      )}
    </Popover>
  );
}
