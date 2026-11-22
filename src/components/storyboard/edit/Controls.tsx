"use client";

import { Keyboard, Maximize, Minus, Plus, Redo2, Scissors, Undo2 } from "lucide-react";
import { useEditor } from "@/lib/storyboard/edit-store";
import { Popover } from "@/components/ui/Popover";
import { ToolButton, ToolPill } from "@/components/director/TitleBar";
import { cut, timelineZoom } from "./Timeline";
import { FreezeMenu, ShapeMenu, Transport, monitorScreen } from "./Monitor";

/**
 * The one row between the screen and the timeline (it was two bars, one over the screen and one over the timeline): undo
 * and split on the left, play in the middle, the timeline's zoom and the film's tools on the right. The selected shot's
 * own tools float over the screen instead (Monitor's selection bar), only while one is selected.
 */
export function Controls() {
  const empty = useEditor((s) => !s.timeline.main.length);
  const canUndo = useEditor((s) => s.past.length > 0);
  const canRedo = useEditor((s) => s.future.length > 0);
  const fit = useEditor((s) => s.zoom === null);
  const { undo, redo } = useEditor.getState();
  return (
    <div className="flex h-12 shrink-0 items-center gap-0.5 border-y border-white/[0.06] px-2">
      <ToolButton label="Undo (Ctrl+Z)" onClick={undo} disabled={!canUndo}>
        <Undo2 size={15} />
      </ToolButton>
      <ToolButton label="Redo (Ctrl+Shift+Z)" onClick={redo} disabled={!canRedo}>
        <Redo2 size={15} />
      </ToolButton>
      <ToolButton label="Split at the playhead (S)" onClick={cut.split} disabled={empty}>
        <Scissors size={15} />
      </ToolButton>
      <span className="min-w-2 flex-1" />
      <Transport disabled={empty} />
      <span className="min-w-2 flex-1" />
      <span className="hidden items-center gap-0.5 md:flex">
        <ToolButton label="Zoom out (Ctrl + scroll)" onClick={() => timelineZoom.by(1 / 1.4)}>
          <Minus size={15} />
        </ToolButton>
        <ToolPill title="The whole film in view" onClick={() => timelineZoom.fit()} active={fit} className="px-2 text-[12px]">
          Fit
        </ToolPill>
        <ToolButton label="Zoom in (Ctrl + scroll)" onClick={() => timelineZoom.by(1.4)}>
          <Plus size={15} />
        </ToolButton>
        <span aria-hidden className="mx-1.5 h-5 w-px bg-white/[0.08]" />
      </span>
      <FreezeMenu />
      <ShapeMenu />
      <ToolButton label="Full screen" onClick={() => void monitorScreen.el?.requestFullscreen?.().catch(() => {})} disabled={empty}>
        <Maximize size={15} />
      </ToolButton>
      <Keys />
    </div>
  );
}

/** The keys, one click away. */
function Keys() {
  return (
    <Popover
      placement="top-end"
      panelClassName="w-[292px] p-3"
      trigger={({ open, toggle }) => (
        <ToolButton label="Keyboard shortcuts" onClick={toggle} active={open}>
          <Keyboard size={15} />
        </ToolButton>
      )}
    >
      {() => (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[12px]">
          {[
            ["Space", "Play or pause"],
            ["S", "Split at the playhead"],
            ["Del", "Delete what's selected"],
            ["Ctrl D", "Duplicate it"],
            ["Alt ← →", "Move the selected shot earlier or later"],
            ["← →", "A frame back or on (Shift: a second)"],
            ["Ctrl Z", "Undo (Shift for redo)"],
            ["Drag", "The ruler or the playhead: move through the film"],
            ["Ctrl scroll", "Zoom the timeline"],
            ["Esc", "Let go of the selection"],
          ].map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="font-mono text-[11px] font-semibold text-fog">{k}</dt>
              <dd className="text-haze">{v}</dd>
            </div>
          ))}
        </dl>
      )}
    </Popover>
  );
}
