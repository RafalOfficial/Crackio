import type { KeyboardEvent } from "react";

/**
 * Enter that should send what's typed: not Shift+Enter (a new line), and not the Enter that confirms a word in a
 * Japanese, Chinese or Korean input method (`isComposing`; Safari reports that last Enter as key code 229 instead).
 */
export const isSubmitEnter = (e: KeyboardEvent) =>
  e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229;
