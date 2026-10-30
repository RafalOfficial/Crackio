"use client";

import { useState, type DragEvent } from "react";
import type { LibraryProject } from "@/lib/library/types";
import type { TakeKey } from "@/lib/hooks/use-library";

/** General or a project, as the Library shows it. */
export type FolderInfo = {
  /** GENERAL or the project's id. */
  id: string;
  name: string;
  icon: string;
  color: string;
  count: number;
  project?: LibraryProject;
};

/** Takes being dragged, and the folder they're dragged out of. */
export type DragState = { keys: TakeKey[]; from: string };

export const DRAG_TYPE = "application/x-crackio-takes";

/**
 * Makes an element a place to drop dragged takes. It only lights up for takes from another
 * folder; dropping them back where they are does nothing.
 */
export function useDropTarget(id: string, drag: DragState | null, onDrop: (folder: string) => void) {
  // Tied to the drag it was set for, so a cancelled drag can't leave a folder lit.
  const [overFor, setOverFor] = useState<DragState | null>(null);
  const can = Boolean(drag) && drag?.from !== id;
  const props = can
    ? {
        onDragEnter: (e: DragEvent) => {
          e.preventDefault();
          setOverFor(drag);
        },
        onDragOver: (e: DragEvent) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
        },
        onDragLeave: (e: DragEvent) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOverFor(null);
        },
        onDrop: (e: DragEvent) => {
          e.preventDefault();
          setOverFor(null);
          onDrop(id);
        },
      }
    : {};
  return { over: can && overFor === drag, props };
}

export const itemsLabel = (n: number) => `${n.toLocaleString()} ${n === 1 ? "item" : "items"}`;
