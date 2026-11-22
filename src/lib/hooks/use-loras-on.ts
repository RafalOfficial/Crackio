"use client";

import { useEffect, useState } from "react";
import type { LoraLibrary } from "@/lib/local/loras";
import { useModelLoras } from "./use-model-loras";

/** A half's name without the words that tell the halves apart: both files of a Wan 2.2 pair come out the same. */
const stem = (file: string) => file.replace(/[_\- ]?(high|low)[_\- ]?noise/i, "");

/**
 * How many LoRAs a list of files is. A two-file LoRA (a Wan 2.2 14B pair: one file for each of the model's two halves)
 * is one LoRA: counted by its files, one LoRA switched on read "2 LoRAs". From the library when it's there (a pick's
 * files, a downloaded file's `pair`); until then by the halves' names.
 */
export function countLoras(files: string[], library: LoraLibrary | null) {
  const groups = new Set<string>();
  for (const file of files) {
    const pick = library?.entries.find((e) => e.local?.includes(file));
    const pair = library?.records[file]?.pair;
    groups.add(pick ? `pick:${pick.id}` : pair?.length ? [file, ...pair].sort().join("|") : library ? file : stem(file));
  }
  return groups.size;
}

/**
 * How many LoRAs are switched on for a model (the model picker and the library's cards say it). The library's code and
 * its list load only once a model has LoRAs on, so a page with a picker stays as light as it was.
 */
export function useLorasOn(crackio: string | null | undefined) {
  const picks = useModelLoras((s) => (crackio ? s.byModel[crackio] : undefined));
  const [library, setLibrary] = useState<LoraLibrary | null>(null);
  const any = Boolean(picks?.length);
  useEffect(() => {
    if (!any) return;
    let live = true;
    let stop: (() => void) | undefined;
    void import("./use-lora-library").then((m) => {
      if (!live) return;
      const read = () => setLibrary(m.useLoraLibrary.getState().library);
      read();
      stop = m.useLoraLibrary.subscribe(read);
      m.loadLoraLibrary();
    });
    return () => {
      live = false;
      stop?.();
    };
  }, [any]);
  return picks?.length ? countLoras(picks.map((p) => p.file), library) : 0;
}
