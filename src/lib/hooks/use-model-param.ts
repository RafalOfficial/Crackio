"use client";

import { useEffect } from "react";

/** `?model=` in the address picks a tool's model (the Local page's "Use it"); read after the first render, so it hydrates cleanly. */
export function useModelParam(set: (id: string) => void) {
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("model");
    if (id) set(id);
  }, [set]);
}
