import "server-only";
import { listModels } from "@/lib/models/resolve";

/**
 * Which image and video models Motion may use, decided once per turn and never by the agent:
 * the open models on the user's own GPU first (free: FLUX 3 Klein for pictures and edits, LTX-2.5 for clips). Comfy
 * Router only when none is installed, and then a fixed, capped set billed to the user's Comfy credits: FLUX 3,
 * GPT Image 2.5 Sunburst for faithful edits, Ideogram 4.5 for edits heavy on text, MiniMax H3 clips.
 */
export type MotionMedia = {
  mode: "local" | "api" | "none";
  image: string | null;
  /** For edits of a reference (keep the product or person exact). */
  edit: string | null;
  /** The other edit model on the API route (text and layout heavy edits). */
  editAlt: string | null;
  /** Image to video, and text to video. */
  video: string | null;
  videoFromText: string | null;
  /** Per-turn caps for this route. */
  limits: { images: number; videos: number };
  /** One line for the brief. */
  summary: string;
};

const LOCAL_IMAGES = ["local:flux3-klein", "local:z-image-turbo", "local:flux2-klein-4b"];
const LOCAL_EDITS = ["local:flux3-klein", "local:flux2-klein-4b"];
const LOCAL_VIDEOS = ["local:ltx-2.5", "local:wan2.2-5b"];

export const API_MODELS = {
  image: "comfy:bfl/flux-3-image",
  edit: "comfy:openai/gpt-image-2.5-sunburst",
  editAlt: "comfy:ideogram/ideogram-4-5",
  video: "comfy:minimax/minimax-h3",
  videoFromText: "comfy:minimax/minimax-h3",
};

export async function motionMedia(): Promise<MotionMedia> {
  const models = await listModels().catch(() => []);
  const has = (id: string) => models.some((m) => m.id === id && m.available);
  const image = LOCAL_IMAGES.find(has) ?? null;
  if (image) {
    const video = LOCAL_VIDEOS.find(has) ?? null;
    const name = (id: string) => models.find((m) => m.id === id)?.name ?? id;
    return {
      mode: "local",
      image,
      edit: LOCAL_EDITS.find(has) ?? image,
      editAlt: null,
      video,
      videoFromText: video,
      limits: { images: 12, videos: video ? 6 : 0 },
      summary: `Images and clips run free on the user's own GPU (${name(image)}${video ? `, ${name(video)} for clips` : ", no video model installed: animate stills yourself"}); each takes a while, so make only what the piece needs.`,
    };
  }
  if (has(API_MODELS.image)) {
    return {
      mode: "api",
      ...API_MODELS,
      video: has(API_MODELS.video) ? API_MODELS.video : null,
      videoFromText: has(API_MODELS.videoFromText) ? API_MODELS.videoFromText : null,
      limits: { images: 6, videos: 3 },
      summary:
        "No model is installed on the user's GPU, so images and clips are billed to their Comfy credits (FLUX 3, GPT Image 2.5 Sunburst for edits, MiniMax H3 clips). Generate only what the piece truly needs and make everything else in code.",
    };
  }
  return {
    mode: "none",
    image: null,
    edit: null,
    editAlt: null,
    video: null,
    videoFromText: null,
    limits: { images: 0, videos: 0 },
    summary: "No image or video model is connected. Make the whole piece in code (render_html), or use the user's attachments.",
  };
}
