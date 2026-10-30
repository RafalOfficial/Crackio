"use client";

import { useState } from "react";
import { ChevronLeft, Plus } from "lucide-react";
import { MenuItem } from "@/components/ui/Popover";
import { ProjectEditor } from "./ProjectEditor";
import { ProjectIcon } from "./ProjectIcon";
import type { FolderInfo } from "./folders";
import type { ProjectInput } from "@/lib/library/types";

/** Where takes can go: General, any project, or a project made on the spot. Popover content. */
export function MoveMenu({
  folders,
  current,
  count,
  close,
  onMove,
  onCreate,
  newColor,
}: {
  folders: FolderInfo[];
  /** The folder the takes are in now. */
  current: string;
  count: number;
  close: () => void;
  onMove: (folder: string) => void;
  /** Makes a project and moves the takes into it. */
  onCreate: (input: ProjectInput) => Promise<void>;
  newColor: string;
}) {
  const [making, setMaking] = useState(false);

  if (making) {
    return (
      <div className="p-1.5">
        <button
          type="button"
          onClick={() => setMaking(false)}
          className="press -ml-1 mb-3 inline-flex h-7 items-center gap-1 rounded-[9px] pl-1 pr-2 text-[12.5px] font-semibold text-fog hover:bg-white/[0.05] hover:text-paper"
        >
          <ChevronLeft size={15} /> Move to
        </button>
        <ProjectEditor
          initial={{ name: "", icon: "folder", color: newColor }}
          taken={folders.filter((f) => f.project).map((f) => f.name)}
          submitLabel={count > 1 ? `Create and move ${count}` : "Create and move"}
          onSubmit={async (input) => {
            await onCreate(input);
            close();
          }}
          onCancel={() => setMaking(false)}
        />
      </div>
    );
  }

  return (
    <div role="menu" className="w-[320px]">
      <p className="label px-2.5 pb-1.5 pt-1.5">{count > 1 ? `Move ${count} items to` : "Move to"}</p>
      {folders.map((f) => (
        <MenuItem
          key={f.id}
          selected={f.id === current}
          disabled={f.id === current}
          hint={f.id === current ? "Here" : f.count ? f.count.toLocaleString() : null}
          onSelect={() => {
            onMove(f.id);
            close();
          }}
        >
          <ProjectIcon icon={f.icon} color={f.color} size={26} tile />
          <span className="truncate font-medium">{f.name}</span>
        </MenuItem>
      ))}
      <div className="mx-2.5 my-1.5 h-px bg-line" />
      <MenuItem onSelect={() => setMaking(true)}>
        <span className="squircle grid size-[26px] shrink-0 place-items-center rounded-[8px] text-fog shadow-[inset_0_0_0_1px_var(--color-line-strong)]">
          <Plus size={14} />
        </span>
        <span className="font-medium">New project&hellip;</span>
      </MenuItem>
    </div>
  );
}
