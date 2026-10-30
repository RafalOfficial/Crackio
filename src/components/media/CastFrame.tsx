"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { Sparkles } from "lucide-react";
import { ModelPicker } from "@/components/models/ModelPicker";
import { Switch } from "@/components/ui/Panel";
import { cn } from "@/lib/cn";

/**
 * A clip with your Cast in it and no start frame (server/cast-refs: castClipJob). A clip model that takes reference
 * pictures (Grok's, Kling's) gets theirs and builds the shot itself; `first` asks for an opening frame drawn with them
 * anyway, for an exact layout. A model that takes none needs that frame to see them at all; `on: false` sends them in
 * words instead. `model` is the image model that draws it (null: the one Cast picks). Remembered in this browser; a clip
 * job carries it as `castFrame` and `frameModel`.
 */
export type CastFrameSetting = { on: boolean; first: boolean; model: string | null };

const KEY = "crackio:cast-frame";
const CHANGED = "crackio:cast-frame";
let memory: string | null = null;

function read() {
  try {
    return localStorage.getItem(KEY) ?? memory;
  } catch {
    return memory;
  }
}

function subscribe(changed: () => void) {
  window.addEventListener(CHANGED, changed);
  window.addEventListener("storage", changed);
  return () => {
    window.removeEventListener(CHANGED, changed);
    window.removeEventListener("storage", changed);
  };
}

export function useCastFrame() {
  const raw = useSyncExternalStore(subscribe, read, () => null);
  const setting = useMemo<CastFrameSetting>(() => {
    try {
      const v = raw ? (JSON.parse(raw) as Partial<CastFrameSetting>) : null;
      return { on: v?.on !== false, first: v?.first === true, model: typeof v?.model === "string" ? v.model : null };
    } catch {
      return { on: true, first: false, model: null };
    }
  }, [raw]);
  const set = useCallback((next: CastFrameSetting) => {
    memory = JSON.stringify(next);
    try {
      localStorage.setItem(KEY, memory);
    } catch {
      /* private mode: kept for this visit */
    }
    window.dispatchEvent(new Event(CHANGED));
  }, []);
  return [setting, set] as const;
}

/** Names in a sentence: "Pigeongoo and Bluebird", "Mia, Leo and Bluebird". */
export const namesOf = (names: string[]) => (names.length < 2 ? (names[0] ?? "them") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

/** Whether the clip model draws the shot from the cast's pictures itself (`refs`), or needs a first frame drawn with them. */
export const drawsFirst = (s: CastFrameSetting, refs: boolean) => (refs ? s.first : s.on);

/** What a clip job carries for it. */
export const castFrameParams = (s: CastFrameSetting, refs: boolean): Record<string, unknown> =>
  refs ? (s.first ? { castFrame: true, ...(s.model ? { frameModel: s.model } : {}) } : {}) : !s.on ? { castFrame: false } : s.model ? { frameModel: s.model } : {};

/** The switch, the model that draws the frame, and what each choice does to the clip. */
export function CastFrameControl({
  setting,
  onChange,
  auto,
  who,
  refs,
  className,
}: {
  setting: CastFrameSetting;
  onChange: (next: CastFrameSetting) => void;
  /** The image model Cast would pick. */
  auto: { id: string; name: string } | null;
  /** Who's in the shot: "Pigeongoo and Bluebird". */
  who: string;
  /** The clip model takes reference pictures: it gets theirs, and the drawn frame is optional. */
  refs: boolean;
  className?: string;
}) {
  const on = drawsFirst(setting, refs);
  const turn = (v: boolean) => onChange(refs ? { ...setting, first: v } : { ...setting, on: v });
  return (
    <div className={cn("rounded-[14px] bg-white/[0.03] p-2.5 shadow-[inset_0_0_0_1px_var(--color-line)]", className)}>
      <div className="flex items-center gap-2">
        <Sparkles size={14} className={cn("shrink-0", on ? "text-spike" : "text-haze")} />
        <p className="min-w-0 flex-1 text-[12.5px] font-semibold leading-snug">First, draw {who} into the opening frame</p>
        <Switch checked={on} onChange={turn} title={on ? (refs ? "Let the clip model build the shot from their pictures" : "Let the clip model start from words") : "Draw the opening frame first"} />
      </div>
      {on ? (
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-[12px] text-haze">Drawn on</span>
          <ModelPicker kind="image" task="edit" value={setting.model ?? auto?.id ?? "auto"} onChange={(id) => onChange({ ...setting, model: id })} variant="chip" />
          {setting.model ? (
            <button type="button" onClick={() => onChange({ ...setting, model: null })} className="text-[12px] font-semibold text-fog hover:text-paper">
              Let Cast pick
            </button>
          ) : (
            <span className="text-[11.5px] text-haze">Cast&rsquo;s pick</span>
          )}
        </div>
      ) : null}
      <p className="mt-1.5 text-[11.5px] leading-snug text-haze">
        {refs
          ? on
            ? "The clip starts from a still drawn with them, for an exact layout; their photos still go along. Adding your own start frame skips the drawing."
            : "Their photos go to the clip model as reference pictures, and it builds the shot around them."
          : on
            ? "This clip model can't take pictures, so it starts from a still of them drawn first. Adding your own start frame skips this."
            : "The clip model gets them in words only, so they may not look like your cast."}
      </p>
    </div>
  );
}
