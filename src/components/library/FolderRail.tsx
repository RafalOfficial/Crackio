"use client";

import type { CSSProperties, ReactNode, Ref } from "react";
import { Ellipsis, FolderPlus } from "lucide-react";
import { Popover } from "@/components/ui/Popover";
import { ProjectEditor } from "./ProjectEditor";
import { ProjectIcon } from "./ProjectIcon";
import { itemsLabel, useDropTarget, type DragState, type FolderInfo } from "./folders";
import type { ProjectInput } from "@/lib/library/types";
import { cn } from "@/lib/cn";

/**
 * The Library's folders: General first, then your projects, then "New project". Each one is
 * also a place to drop dragged takes.
 */
export function FolderRail({
  folders,
  current,
  loaded,
  drag,
  landed,
  newColor,
  railRef,
  onOpen,
  onDrop,
  onCreate,
  onUpdate,
  onDelete,
}: {
  folders: FolderInfo[];
  current: string;
  loaded: boolean;
  drag: DragState | null;
  /** The folder that just took a drop, for a short flash. */
  landed: string | null;
  newColor: string;
  railRef: Ref<HTMLDivElement>;
  onOpen: (folder: string) => void;
  onDrop: (folder: string) => void;
  onCreate: (input: ProjectInput) => Promise<void>;
  onUpdate: (id: string, input: ProjectInput) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const names = folders.filter((f) => f.project).map((f) => f.name);
  return (
    <div ref={railRef} role="group" aria-label="Folders" className="scrollbar-none -m-1 mt-6 flex gap-2.5 overflow-x-auto p-1 sm:flex-wrap sm:overflow-visible">
      {!loaded ? (
        Array.from({ length: 2 }, (_, i) => <div key={i} className="skeleton squircle h-[58px] w-[188px] shrink-0 rounded-[17px]" />)
      ) : (
        <>
          {folders.map((f) => (
            <FolderCard
              key={f.id}
              folder={f}
              active={f.id === current}
              drag={drag}
              landed={landed === f.id}
              onOpen={onOpen}
              onDrop={onDrop}
              menu={
                f.project ? (
                  <ProjectMenu
                    folder={f}
                    active={f.id === current}
                    taken={names.filter((n) => n !== f.name)}
                    onUpdate={(input) => onUpdate(f.id, input)}
                    onDelete={() => onDelete(f.id)}
                  />
                ) : null
              }
            />
          ))}
          <Popover
            placement="bottom-start"
            className="shrink-0"
            panelClassName="p-3"
            trigger={({ open, toggle, id }) => (
              <button
                type="button"
                onClick={toggle}
                aria-expanded={open}
                aria-controls={id}
                data-popover-open={open || undefined}
                className={cn(
                  "press squircle flex h-[58px] items-center gap-3 rounded-[17px] border border-dashed pl-2.5 pr-5 text-left",
                  open ? "border-haze bg-white/[0.04] text-paper" : "border-line-strong text-fog hover:border-haze hover:bg-white/[0.03] hover:text-paper",
                )}
              >
                <span className="squircle grid size-[38px] place-items-center rounded-[12px] bg-white/[0.05]">
                  <FolderPlus size={18} />
                </span>
                <span className="text-[14px] font-semibold">New project</span>
              </button>
            )}
          >
            {(close) => (
              <ProjectEditor
                initial={{ name: "", icon: "folder", color: newColor }}
                taken={names}
                submitLabel="Create project"
                onSubmit={async (input) => {
                  await onCreate(input);
                  close();
                }}
                onCancel={close}
              />
            )}
          </Popover>
        </>
      )}
    </div>
  );
}

function FolderCard({
  folder,
  active,
  drag,
  landed,
  onOpen,
  onDrop,
  menu,
}: {
  folder: FolderInfo;
  active: boolean;
  drag: DragState | null;
  landed: boolean;
  onOpen: (folder: string) => void;
  onDrop: (folder: string) => void;
  menu: ReactNode;
}) {
  const drop = useDropTarget(folder.id, drag, onDrop);
  return (
    <div className="group/folder folder-in relative shrink-0" {...drop.props}>
      <button
        type="button"
        onClick={() => onOpen(folder.id)}
        aria-current={active ? "true" : undefined}
        data-drop={drop.over || undefined}
        data-landed={landed || undefined}
        title={folder.project ? folder.name : "Everything that isn't in a project"}
        className={cn(
          "folder-card project-tint press squircle flex h-[58px] w-full min-w-[176px] max-w-[300px] items-center gap-3 rounded-[17px] pl-2.5 text-left",
          folder.project ? "pr-11" : "pr-5",
        )}
        style={{ "--hue": folder.color } as CSSProperties}
      >
        <ProjectIcon icon={folder.icon} color={folder.color} size={38} tile />
        <span className="min-w-0">
          <span className="block truncate text-[14px] font-semibold leading-tight text-paper">{folder.name}</span>
          <span className="tabular mt-1 block text-[12px] leading-none text-haze">{itemsLabel(folder.count)}</span>
        </span>
      </button>
      {menu}
    </div>
  );
}

/** A project's "…": its name, icon and color, and Delete. */
function ProjectMenu({
  folder,
  active,
  taken,
  onUpdate,
  onDelete,
}: {
  folder: FolderInfo;
  active: boolean;
  taken: string[];
  onUpdate: (input: ProjectInput) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  return (
    <Popover
      placement="bottom-end"
      className="absolute right-2 top-1/2 -translate-y-1/2"
      panelClassName="p-3"
      trigger={({ open, toggle, id }) => (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-controls={id}
          aria-label={`Edit ${folder.name}`}
          title="Edit project"
          data-popover-open={open || undefined}
          className={cn(
            "press squircle grid size-7 place-items-center rounded-[9px] text-haze hover:bg-white/[0.08] hover:text-paper focus-visible:opacity-100",
            open ? "bg-white/[0.08] text-paper opacity-100" : active ? "opacity-100" : "opacity-0 group-hover/folder:opacity-100",
          )}
        >
          <Ellipsis size={16} />
        </button>
      )}
    >
      {(close) => (
        <ProjectEditor
          initial={{ name: folder.name, icon: folder.icon, color: folder.color }}
          taken={taken}
          submitLabel="Save"
          deleteNote={
            folder.count
              ? `Only the folder goes: its ${itemsLabel(folder.count)} ${folder.count === 1 ? "moves" : "move"} back to General.`
              : "It's empty, so nothing else changes."
          }
          onSubmit={async (input) => {
            await onUpdate(input);
            close();
          }}
          onCancel={close}
          onDelete={async () => {
            await onDelete();
            close();
          }}
        />
      )}
    </Popover>
  );
}
