import { AudioLines } from "lucide-react";
import type { VoiceModel } from "@/lib/voice/models";

/**
 * A voice model's mark: the same plain sound mark for every one, its maker named in text beside it (no makers' logos:
 * Drama 3's licence allows Fish Audio's name but forbids its logo, and Crackio carries no other brands either).
 * In a file of its own so the chips that show it don't load the whole model library (VoiceModelLibrary) with them.
 */
export function VoiceModelMark({ model, size = 20, variant = "tile" }: { model: VoiceModel; size?: number; variant?: "tile" | "bare" }) {
  const radius = Math.round(size * 0.28);
  if (model.card.logo) {
    return (
      // A small logo; a plain img keeps it crisp and cheap.
      // eslint-disable-next-line @next/next/no-img-element
      <img src={model.card.logo} alt="" aria-hidden="true" draggable={false} className="squircle shrink-0 object-cover shadow-[0_0_0_1px_rgb(255_255_255/0.1)]" style={{ width: size, height: size, borderRadius: radius }} />
    );
  }
  const glyph = <AudioLines size={Math.round(size * (variant === "bare" ? 0.9 : 0.52))} strokeWidth={2.3} />;
  return variant === "bare" ? (
    <span className="inline-grid shrink-0 place-items-center text-paper" style={{ width: size, height: size }} aria-hidden="true">
      {glyph}
    </span>
  ) : (
    <span className="squircle inline-grid shrink-0 place-items-center bg-paper text-[#16131b] shadow-[0_0_0_1px_rgb(255_255_255/0.1)]" style={{ width: size, height: size, borderRadius: radius }} aria-hidden="true">
      {glyph}
    </span>
  );
}
