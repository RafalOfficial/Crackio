"use client";

/**
 * Muted previews that loop on screen share a budget, so a page full of clips never decodes more
 * than a handful at once: the ones that came into view first play, the rest wait on their opening
 * frame and take over as others scroll away.
 */
const AT_ONCE = 10;

type Slot = { play: () => void; pause: () => void; on: boolean };
const wanting: Slot[] = [];

function settle() {
  wanting.forEach((s, i) => {
    const on = i < AT_ONCE;
    if (on === s.on) return;
    s.on = on;
    if (on) s.play();
    else s.pause();
  });
}

/** A place in the line for one preview: `want` while it's on screen, `drop` when it leaves (or unmounts). */
export function playbackSlot(play: () => void, pause: () => void) {
  const slot: Slot = { play, pause, on: false };
  return {
    want() {
      if (wanting.includes(slot)) return;
      wanting.push(slot);
      settle();
    },
    drop() {
      const i = wanting.indexOf(slot);
      if (i < 0) return;
      wanting.splice(i, 1);
      if (slot.on) {
        slot.on = false;
        slot.pause();
      }
      settle();
    },
  };
}
