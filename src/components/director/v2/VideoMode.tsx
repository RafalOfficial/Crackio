"use client";

import { useRef, useState } from "react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { ArrowDownToLine, ArrowLeftRight, ArrowUpFromLine, Clapperboard, LoaderCircle, MoveHorizontal, RotateCcw, RotateCw, Undo2, Video, ZoomIn, ZoomOut } from "lucide-react";
import { useDirector } from "@/lib/director/store";
import { CAMERA_MOVES, hasKeys, type CameraMoveKind } from "@/lib/director/timeline";
import { photoMeters } from "@/lib/director/moge-scale";
import { useGenerations, useGenerationsStore } from "@/lib/hooks/use-generations";
import { useModelsStore } from "@/lib/hooks/use-models";
import { useToolTakes } from "@/components/tools/use-tool-takes";
import { cn } from "@/lib/cn";
import { setPlaceVideoFile } from "../intake";
import { useTakesFrom } from "../take-view";
import { isClip } from "../Clips";
import { notice } from "./notice";

/** The model the Director's video mode films with (local/catalog `director-video`, server/director-video). */
export const VIDEO_MODEL = "local:director-video";

/** Director video mode: the place is a video (Place.video), filmed again along the Camera path you set. */
export const useVideoMode = () => useDirector((s) => Boolean(s.scene.place.video));

type Quality = "draft" | "final";
/** How you film: a draft (the first stage only, about 0.5 MP: quick looks at a path) or final (both stages, about 2 MP). */
const useVideoFilm = create<{ quality: Quality; words: string }>()(
  persist(() => ({ quality: "draft" as Quality, words: "" }), {
    name: "crackio.director.video-film",
    storage: createJSONStorage(() => localStorage),
    partialize: (s) => ({ quality: s.quality }),
  }),
);

/** The longest stretch filmed (server/director-video RESHOOT_CAP: 8k+1 frames at 24 fps). */
const LONGEST: Record<Quality, number> = { draft: 10, final: 5 };

/** How many seconds of the video Film it films now (the timeline's video lane dims the rest). */
export const useFilmedSeconds = () => useVideoFilm((s) => LONGEST[s.quality]);

/** The moves offered in video mode: the ready-made ones that keep the video's subject in view. */
const MOVES: { id: CameraMoveKind; icon: typeof RotateCw }[] = [
  { id: "orbit-left", icon: RotateCcw },
  { id: "orbit-right", icon: RotateCw },
  { id: "push-in", icon: ZoomIn },
  { id: "pull-out", icon: ZoomOut },
  { id: "crane-up", icon: ArrowUpFromLine },
  { id: "crane-down", icon: ArrowDownToLine },
  { id: "truck-left", icon: MoveHorizontal },
  { id: "truck-right", icon: ArrowLeftRight },
];

/** Whether a take is the video mode's (a re-shoot of a video). */
const isReshoot = (g: { params?: Record<string, unknown> }) => Boolean((g.params?.reshoot as { version?: number } | undefined)?.version);

/** Film the video again along the Camera path: one take on your GPU (or RunPod), with the video's own sound. */
async function filmVideo(submit: ReturnType<typeof useGenerationsStore.getState>["submit"], project: string | null) {
  const scene = useDirector.getState().scene;
  const video = scene.place.video;
  const photo = scene.place.image;
  if (!video || !photo) return;
  if (!photo.view) return void notice("The video's 3D set is still being built: a moment", "warn", 4000);
  const { quality, words } = useVideoFilm.getState();
  const moved = hasKeys(scene.timeline) && (scene.timeline?.camera.length ?? 0) > 0;
  await submit({
    tool: "director",
    prompt: words.trim() || "The video, filmed again from a new camera",
    compiledPrompt: words.trim(),
    aspect: scene.aspect,
    count: 1,
    model: VIDEO_MODEL,
    refine: false,
    references: [],
    params: {
      kind: "video",
      reshoot: { version: 1, videoUrl: video.url, meters: photoMeters.get(photo.url), quality },
      scene,
      moved,
      ...(project ? { project } : {}),
    },
  });
  notice(quality === "draft" ? "Filming a draft · it lands in Takes" : "Filming it · it lands in Takes", "busy", 4500);
}

/** Film it in video mode: the words (optional), draft or final, and the button. `phone`: the words bar of a phone. */
export function VideoBar({ phone = false }: { phone?: boolean }) {
  const words = useVideoFilm((s) => s.words);
  const quality = useVideoFilm((s) => s.quality);
  const submit = useGenerations((s) => s.submit);
  const project = useTakesFrom((s) => s.project);
  const ready = useModelsStore((s) => s.models.find((m) => m.id === VIDEO_MODEL)?.available ?? false);
  const takes = useToolTakes("director");
  const filming = takes.some((g) => isClip(g) && isReshoot(g) && (g.status === "queued" || g.status === "running"));
  const [busy, setBusy] = useState(false);
  const film = async () => {
    if (!ready) return void notice("Set up “Videos filmed from a new camera” in Settings → Director: an NVIDIA GPU with 24 GB, or RunPod", "warn", 8000);
    setBusy(true);
    try {
      await filmVideo(submit, project);
    } catch (err) {
      notice((err as Error).message, "stop", 6000);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={cn("surface flex min-w-0 items-center gap-2 rounded-panel p-2", phone && "pointer-events-auto rounded-[18px] bg-black/60 p-1.5 backdrop-blur-md")}>
      <input
        value={words}
        onChange={(e) => useVideoFilm.setState({ words: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void film();
          }
        }}
        placeholder={phone ? "What happens (optional)" : "What happens in the video, in your words (optional: the video is read for you)"}
        aria-label="What happens in the video"
        className="min-w-0 flex-1 bg-transparent px-2 text-[14px] text-paper outline-none placeholder:text-haze"
      />
      <div className="flex shrink-0 rounded-[10px] bg-white/[0.05] p-0.5" role="radiogroup" aria-label="Quality">
        {(["draft", "final"] as const).map((q) => (
          <button
            key={q}
            type="button"
            role="radio"
            aria-checked={quality === q}
            title={q === "draft" ? `A quick look at your path: about 0.5 MP, up to ${LONGEST.draft} s` : `The finished shot: about 2 MP, up to ${LONGEST.final} s`}
            onClick={() => useVideoFilm.setState({ quality: q })}
            className={cn("press h-8 rounded-[8px] px-2.5 text-[12px] font-semibold", quality === q ? "bg-white/[0.16] text-paper" : "text-fog hover:text-paper")}
          >
            {q === "draft" ? "Draft" : "Final"}
          </button>
        ))}
      </div>
      <button
        type="button"
        onClick={() => void film()}
        disabled={busy}
        title="Film the video again along your Camera path"
        className={cn("press squircle flex h-10 shrink-0 items-center gap-2 rounded-[12px] bg-spike px-3.5 text-[14px] font-semibold text-spike-ink disabled:opacity-60", phone && "h-9 px-3")}
      >
        {busy || filming ? <LoaderCircle size={16} className="animate-spin" /> : <Clapperboard size={16} />}
        {phone ? "Film" : "Film it"}
      </button>
    </div>
  );
}

/** Video mode's side panel: the video, ready-made camera paths, and how it's filmed. */
export function VideoPanel() {
  const video = useDirector((s) => s.scene.place.video);
  const poster = useDirector((s) => s.scene.place.image?.url);
  const length = useDirector((s) => s.scene.timeline?.length ?? 0);
  const fps = useDirector((s) => s.scene.timeline?.fps ?? 24);
  const keyed = useDirector((s) => hasKeys(s.scene.timeline));
  const quality = useVideoFilm((s) => s.quality);
  const input = useRef<HTMLInputElement>(null);
  const [replacing, setReplacing] = useState(false);
  if (!video) return null;
  const seconds = Math.min(length / Math.max(1, fps), LONGEST[quality]);
  return (
    <div className="scroll-thin h-full overflow-y-auto p-4">
      <div className="overflow-hidden rounded-[14px] bg-black shadow-[inset_0_0_0_1px_var(--color-line)]">
        <video
          src={video.url}
          poster={poster}
          muted
          loop
          playsInline
          preload="metadata"
          onPointerEnter={(e) => void e.currentTarget.play().catch(() => undefined)}
          onPointerLeave={(e) => e.currentTarget.pause()}
          className="aspect-video w-full object-contain"
        />
      </div>
      <div className="mt-2 flex items-center gap-2 text-[12.5px] text-haze">
        <Video size={13} className="shrink-0 text-spike" />
        <span className="tabular min-w-0 flex-1 truncate">
          {video.duration.toFixed(1)} s · {video.width}×{video.height}
          {video.audio ? " · sound kept" : ""}
        </span>
        <button
          type="button"
          disabled={replacing}
          onClick={() => input.current?.click()}
          className="press rounded-[8px] px-2 py-1 font-semibold text-fog hover:bg-white/[0.06] hover:text-paper disabled:opacity-60"
        >
          {replacing ? "Reading…" : "Replace"}
        </button>
        <input
          ref={input}
          type="file"
          accept="video/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (!f) return;
            setReplacing(true);
            void setPlaceVideoFile(f)
              .catch((err: Error) => notice(err.message, "stop", 6000))
              .finally(() => setReplacing(false));
          }}
        />
      </div>

      <p className="mt-5 text-[11px] font-semibold uppercase tracking-[0.08em] text-haze">The camera</p>
      <p className="mt-1 text-[12.5px] leading-snug text-fog">
        Move the Camera on the stage and key it on the timeline, or start from a move. Film it films the video again from there.
      </p>
      <div className="mt-2 grid grid-cols-2 gap-1.5">
        {MOVES.map(({ id, icon: Icon }) => {
          const m = CAMERA_MOVES.find((x) => x.id === id)!;
          return (
            <button
              key={id}
              type="button"
              title={`${m.plain}, over the whole video (it replaces the camera's keys)`}
              onClick={() => useDirector.getState().applyCameraMove(id)}
              className="press flex h-9 items-center gap-2 rounded-[10px] bg-white/[0.04] px-2.5 text-[12.5px] font-semibold text-fog hover:bg-white/[0.08] hover:text-paper"
            >
              <Icon size={14} className="shrink-0" />
              {m.label}
            </button>
          );
        })}
      </div>
      <button
        type="button"
        onClick={() => {
          const s = useDirector.getState();
          if (keyed) s.clearTimeline();
          s.toPhotoView();
        }}
        title="The camera back where the video's was, with no move"
        className="press mt-1.5 flex h-9 w-full items-center justify-center gap-2 rounded-[10px] text-[12.5px] font-semibold text-haze hover:bg-white/[0.05] hover:text-paper"
      >
        <Undo2 size={14} />
        The video&apos;s own camera
      </button>

      <p className="mt-5 text-[11px] font-semibold uppercase tracking-[0.08em] text-haze">Filming</p>
      <p className="mt-1 text-[12.5px] leading-snug text-fog">
        Films the first {seconds.toFixed(seconds % 1 ? 1 : 0)} s{quality === "draft" ? " as a draft (about 0.5 MP)" : " (about 2 MP)"}, with the video&apos;s own sound.
      </p>
      <p className="mt-2 text-[12px] leading-snug text-haze">
        Every frame is measured in 3D (MoGe-3) and seen from your path (the challenge winner&apos;s Panorama Studio); LTX-2.5 with Lightricks&apos; Layout to Render
        draws the shot over it, starting from the first frame from the new angle.
      </p>
    </div>
  );
}
