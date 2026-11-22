import type { KeyboardEvent } from "react";

/**
 * Arrow keys for a row of radio buttons (role="radiogroup" with role="radio" buttons): ←/→ (and ↑/↓) move between them,
 * Home and End go to the ends, Space or Enter picks. Only focus moves, so stepping past a choice never saves it (in
 * Settings a pick is saved at once). Pair it with `radioTab` so the group is one Tab stop.
 */
export function radioArrows(e: KeyboardEvent<HTMLElement>) {
  const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"];
  if (!keys.includes(e.key)) return;
  const radios = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]:not([disabled])')];
  const at = radios.indexOf(document.activeElement as HTMLElement);
  if (at < 0) return;
  e.preventDefault();
  const step = e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 1;
  const next = e.key === "Home" ? 0 : e.key === "End" ? radios.length - 1 : (at + step + radios.length) % radios.length;
  radios[next]?.focus();
}

/** The radio Tab lands on: the one picked, or the first when none is. */
export const radioTab = (on: boolean, index: number, anyOn: boolean) => (on || (!anyOn && index === 0) ? 0 : -1);
