"use client";

import { useCallback, useState } from "react";
import { nanoid } from "nanoid";

export type LocalRef = {
  id: string;
  name: string;
  /** Object URL for instant preview while the upload runs. */
  preview: string;
  /** Server URL once uploaded. */
  url?: string;
  width?: number;
  height?: number;
  status: "uploading" | "ready" | "error";
  error?: string;
};

export function useUploads(max = 14) {
  const [refs, setRefs] = useState<LocalRef[]>([]);

  /** Adds pictures and returns their ids right away; each one uploads in the background. */
  const add = useCallback(
    (files: File[]) => {
      const images = files.filter((f) => f.type.startsWith("image/"));
      if (!images.length) return [];
      const pending = images.map<LocalRef>((f) => ({
        id: nanoid(8),
        name: f.name.replace(/\.[^.]+$/, ""),
        preview: URL.createObjectURL(f),
        status: "uploading",
      }));
      setRefs((r) => [...r, ...pending].slice(0, max));

      void Promise.all(
        images.map(async (file, i) => {
          const id = pending[i].id;
          const body = new FormData();
          body.append("file", file);
          try {
            const res = await fetch("/api/uploads", { method: "POST", body });
            const data = (await res.json()) as {
              items?: { url: string; width: number; height: number }[];
              error?: string;
            };
            if (!res.ok || !data.items?.[0]) throw new Error(data.error ?? "Upload failed");
            const item = data.items[0];
            setRefs((r) => r.map((x) => (x.id === id ? { ...x, ...item, status: "ready" } : x)));
          } catch (err) {
            setRefs((r) =>
              r.map((x) => (x.id === id ? { ...x, status: "error", error: (err as Error).message } : x)),
            );
          }
        }),
      );
      return pending.map((p) => p.id);
    },
    [max],
  );

  /** A picture already on Crackio (a generation, a frame just made): no upload. Returns its id. */
  const addRemote = useCallback(
    (url: string, name: string, size?: { width?: number; height?: number }) => {
      const id = nanoid(8);
      setRefs((r) => [...r, { id, name, preview: url, url, width: size?.width, height: size?.height, status: "ready" as const }].slice(0, max));
      return id;
    },
    [max],
  );

  /** Moves a picture to another place in the order (references are numbered by it). */
  const move = useCallback((id: string, to: number) => {
    setRefs((r) => {
      const from = r.findIndex((x) => x.id === id);
      if (from < 0) return r;
      const next = [...r];
      const [it] = next.splice(from, 1);
      next.splice(Math.max(0, Math.min(to, next.length)), 0, it);
      return next;
    });
  }, []);

  const remove = useCallback((id: string) => {
    setRefs((r) => {
      const gone = r.find((x) => x.id === id);
      if (gone?.preview.startsWith("blob:")) URL.revokeObjectURL(gone.preview);
      return r.filter((x) => x.id !== id);
    });
  }, []);

  const rename = useCallback((id: string, name: string) => {
    setRefs((r) => r.map((x) => (x.id === id ? { ...x, name } : x)));
  }, []);

  const clear = useCallback(
    () =>
      setRefs((r) => {
        // Each preview holds its picture in memory until it's let go.
        for (const x of r) if (x.preview.startsWith("blob:")) URL.revokeObjectURL(x.preview);
        return [];
      }),
    [],
  );

  return { refs, add, addRemote, move, remove, rename, clear, uploading: refs.some((r) => r.status === "uploading") };
}
