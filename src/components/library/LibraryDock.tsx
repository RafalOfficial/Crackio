"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { FolderInput, Trash, TriangleAlert, X } from "lucide-react";
import { Popover } from "@/components/ui/Popover";
import { useShell } from "@/components/shell/shell-store";
import { MoveMenu } from "./MoveMenu";
import { ProjectIcon } from "./ProjectIcon";
import { useDropTarget, type DragState, type FolderInfo } from "./folders";
import type { ProjectInput } from "@/lib/library/types";
import { cn } from "@/lib/cn";

export type Toast = {
  id: number;
  /** The message, given the folder's name as it is now (it may be renamed while the note is up). */
  text: (name: ReactNode) => ReactNode;
  folder?: FolderInfo;
  error?: boolean;
  undo?: () => void;
  open?: () => void;
};

const pop = {
  initial: { opacity: 0, y: 14, scale: 0.98 },
  animate: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, y: 10, scale: 0.98 },
  transition: { duration: 0.2, ease: [0.22, 1, 0.36, 1] as const },
};

/** Solid, not blurred: these sit over playing clips (see "Dashboard scroll glitches"). */
const bar = "squircle pointer-events-auto rounded-[18px] bg-apple-2 shadow-[0_0_0_1px_var(--color-line-strong),0_18px_44px_-10px_rgb(0_0_0/0.7)]";

const noop = () => () => {};

/**
 * The bottom of the Library: what's selected and where it can go, folders to drop dragged takes
 * on when the folder row has scrolled away, and the note after a move (with Undo). It's drawn
 * over the page rather than in it, so it stays usable above the viewer (`viewer`: over its
 * stage, clear of the strip of takes and the details panel).
 */
export function LibraryDock({
  toast,
  folders,
  onDismiss,
  selection,
  dock,
  viewer,
}: {
  toast: Toast | null;
  folders: FolderInfo[];
  onDismiss: () => void;
  selection: ReactNode;
  dock: ReactNode;
  viewer?: { info: boolean };
}) {
  const collapsed = useShell((s) => s.collapsed);
  const client = useSyncExternalStore(noop, () => true, () => false);
  const folder = toast?.folder ? (folders.find((f) => f.id === toast.folder!.id) ?? toast.folder) : undefined;
  if (!client) return null;
  return createPortal(
    <div
      className={cn(
        "pointer-events-none fixed inset-x-0 flex flex-col items-center gap-2.5 px-4",
        viewer
          ? cn("bottom-[132px] z-[65]", viewer.info && "lg:right-[384px]")
          : cn("bottom-5 z-40", collapsed ? "lg:left-[68px]" : "lg:left-[var(--sidebar-w)]"),
      )}
    >
      <AnimatePresence mode="popLayout">
        {toast ? (
          <motion.div key={toast.id} {...pop} role="status" className={cn(bar, "flex max-w-full items-center gap-3 py-2 pl-2.5 pr-2")}>
            {toast.error ? (
              <span className="grid size-[30px] shrink-0 place-items-center rounded-[10px] bg-tally/15 text-tally">
                <TriangleAlert size={16} />
              </span>
            ) : folder ? (
              <ProjectIcon icon={folder.icon} color={folder.color} size={30} tile />
            ) : null}
            <span className="min-w-0 truncate text-[13.5px] text-fog">{toast.text(<b className="font-semibold text-paper">{folder?.name}</b>)}</span>
            <span className="flex shrink-0 items-center gap-0.5">
              {toast.open ? (
                <button type="button" onClick={toast.open} className="press h-8 rounded-[10px] px-2.5 text-[13px] font-semibold text-fog hover:bg-white/[0.06] hover:text-paper">
                  Open
                </button>
              ) : null}
              {toast.undo ? (
                <button type="button" onClick={toast.undo} className="press h-8 rounded-[10px] bg-white/[0.07] px-3 text-[13px] font-semibold text-paper hover:bg-white/[0.12]">
                  Undo
                </button>
              ) : null}
              <button type="button" onClick={onDismiss} aria-label="Dismiss" className="press grid size-8 place-items-center rounded-[10px] text-haze hover:bg-white/[0.06] hover:text-paper">
                <X size={15} />
              </button>
            </span>
          </motion.div>
        ) : null}
      </AnimatePresence>
      <AnimatePresence mode="popLayout">{viewer ? null : (dock ?? selection)}</AnimatePresence>
    </div>,
    document.body,
  );
}

/** "3 selected": select everything shown, move the lot, delete it, or stop selecting. */
export function SelectionBar({
  count,
  total,
  doomed,
  folders,
  current,
  newColor,
  onSelectAll,
  onClear,
  onMove,
  onCreate,
  onDelete,
}: {
  count: number;
  total: number;
  /** How many takes deleting would remove: a run's other takes go with it. */
  doomed: number;
  folders: FolderInfo[];
  current: string;
  newColor: string;
  onSelectAll: () => void;
  onClear: () => void;
  onMove: (folder: string) => void;
  onCreate: (input: ProjectInput) => Promise<void>;
  onDelete: () => void;
}) {
  return (
    <motion.div key="selection" {...pop} className={cn(bar, "flex max-w-full items-center gap-1 p-1.5 pl-4")}>
      <span className="tabular mr-1.5 whitespace-nowrap text-[13.5px] font-semibold text-paper">{count ? `${count.toLocaleString()} selected` : "Select items"}</span>
      <button
        type="button"
        onClick={onSelectAll}
        disabled={count === total}
        className="press h-9 whitespace-nowrap rounded-[12px] px-3 text-[13px] font-semibold text-fog hover:bg-white/[0.06] hover:text-paper disabled:opacity-40"
      >
        Select all{total > count ? <span className="tabular ml-1 font-normal text-haze">{total.toLocaleString()}</span> : null}
      </button>
      <Popover
        placement="top-start"
        trigger={({ open, toggle, id }) => (
          <button
            type="button"
            onClick={toggle}
            disabled={!count}
            aria-expanded={open}
            aria-controls={id}
            data-popover-open={open || undefined}
            className="press squircle inline-flex h-9 items-center gap-2 whitespace-nowrap rounded-[12px] bg-paper px-3.5 text-[13px] font-semibold text-[#16131b] hover:bg-white disabled:opacity-40"
          >
            <FolderInput size={15} /> Move to
          </button>
        )}
      >
        {(close) => <MoveMenu folders={folders} current={current} count={count} close={close} onMove={onMove} onCreate={onCreate} newColor={newColor} />}
      </Popover>
      <DeleteSelected key={count} count={count} doomed={doomed} onDelete={onDelete} />
      <button type="button" onClick={onClear} aria-label="Stop selecting" title="Stop selecting (Esc)" className="press grid size-9 place-items-center rounded-[12px] text-haze hover:bg-white/[0.06] hover:text-paper">
        <X size={16} />
      </button>
    </motion.div>
  );
}

/** Two clicks: the first says exactly how many takes will go. */
function DeleteSelected({ count, doomed, onDelete }: { count: number; doomed: number; onDelete: () => void }) {
  const [arming, setArming] = useState(false);
  const disarm = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(disarm.current), []);
  const label = arming ? `Delete ${doomed.toLocaleString()} ${doomed === 1 ? "take" : "takes"}?` : "Delete";
  return (
    <button
      type="button"
      disabled={!count}
      onClick={() => {
        if (arming) return onDelete();
        setArming(true);
        clearTimeout(disarm.current);
        disarm.current = setTimeout(() => setArming(false), 3200);
      }}
      title={arming && doomed > count ? "Takes from the same run go together" : label}
      className={cn(
        "press squircle inline-flex h-9 items-center gap-1.5 whitespace-nowrap rounded-[12px] px-3 text-[13px] font-semibold disabled:opacity-40",
        arming ? "bg-tally text-white" : "text-fog hover:bg-white/[0.06] hover:text-paper",
      )}
    >
      <Trash size={14} /> {label}
    </button>
  );
}

/** While takes are dragged and the folder row is off screen: the folders, down here. */
export function DropDock({ folders, drag, onDrop }: { folders: FolderInfo[]; drag: DragState; onDrop: (folder: string) => void }) {
  const targets = folders.filter((f) => f.id !== drag.from);
  return (
    <motion.div key="dock" {...pop} className={cn(bar, "flex max-w-full items-center gap-1.5 overflow-x-auto p-2 scrollbar-none")}>
      <span className="label shrink-0 px-2">{drag.keys.length > 1 ? `Move ${drag.keys.length} to` : "Move to"}</span>
      {targets.length ? (
        targets.map((f) => <DockTarget key={f.id} folder={f} drag={drag} onDrop={onDrop} />)
      ) : (
        <span className="px-2 text-[13px] text-haze">Make a project first</span>
      )}
    </motion.div>
  );
}

function DockTarget({ folder, drag, onDrop }: { folder: FolderInfo; drag: DragState; onDrop: (folder: string) => void }) {
  const drop = useDropTarget(folder.id, drag, onDrop);
  return (
    <div
      {...drop.props}
      data-drop={drop.over || undefined}
      className="folder-card project-tint press squircle flex h-11 shrink-0 items-center gap-2 rounded-[13px] pl-1.5 pr-3.5"
      style={{ "--hue": folder.color } as CSSProperties}
    >
      <ProjectIcon icon={folder.icon} color={folder.color} size={30} tile />
      <span className="max-w-[180px] truncate text-[13px] font-semibold text-paper">{folder.name}</span>
    </div>
  );
}
