"use client";

import { useEffect, useState } from "react";

/**
 * The time, once the page is in the browser (null while it prerenders), so date-dependent UI (a
 * seasonal template's last week) never bakes the build's clock into the page.
 */
export function useNow(): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    void Promise.resolve().then(() => setNow(Date.now()));
  }, []);
  return now;
}
