import type { AspectId } from "@/lib/shot";
import type { ProviderId } from "@/lib/providers/types";

export type GenerationStatus = "queued" | "running" | "done" | "error";

export type MediaRef = {
  url: string;
  kind: "image" | "video";
  width?: number;
  height?: number;
  /** A clip's length in seconds. */
  duration?: number;
  /** A clip's frames per second. */
  fps?: number;
  /** The file's size on disk. */
  bytes?: number;
};

export type ReferenceRef = {
  url: string;
  /** What the reference is for: who/what it shows, or which role it plays in a scene. */
  label?: string;
  role?: "subject" | "product" | "place" | "style" | "edit-target";
};

export type Generation = {
  id: string;
  tool: string;
  engine: ProviderId | "auto";
  /** Catalog model id ("comfy:bfl/flux-3-image") or "auto"; resolved when the job starts. */
  model?: string;
  /** Display name of the model that actually ran. */
  modelName?: string;
  status: GenerationStatus;
  /** The person's own words. */
  prompt: string;
  /** What was actually sent to the model, after Crackio refined it. */
  compiledPrompt?: string;
  aspect: AspectId;
  count: number;
  references: ReferenceRef[];
  outputs: MediaRef[];
  /** Tool-specific settings (Director scene, camera orbit, light position…). */
  params?: Record<string, unknown>;
  progress?: number;
  stage?: string;
  error?: string;
  createdAt: number;
  finishedAt?: number;
  /** The live demo's access code that made it (lib/demo); only that code sees it. */
  owner?: string;
};

export type GenerateRequest = {
  tool: string;
  prompt: string;
  aspect: AspectId;
  count: number;
  /** Catalog model id or "auto". */
  model: string;
  references: ReferenceRef[];
  refine: boolean;
  params?: Record<string, unknown>;
};
