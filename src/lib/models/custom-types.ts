import type { Caps, ModelTask } from "@/lib/models/caps";
import type { ProviderId } from "@/lib/providers/types";

/** One model in the Custom tab: any model a connected provider offers, with what it accepts. */
export type CustomRow = {
  /** What's stored and sent as the model: "comfy:kling/kling-v3-omni", "local:ltx-2.5". */
  id: string;
  provider: ProviderId;
  name: string;
  vendor: string;
  description: string;
  thumbnail?: string;
  /** When the provider added it (ISO). */
  date?: string;
  isNew: boolean;
  /** "Image → video", "Start + end frame", "Sound"… */
  badges: string[];
  /** "$0.14/s", when the provider publishes a clear price. */
  price?: string | null;
  /** Null until Crackio has read the model's schema. */
  caps: Caps | null;
  /** One of Crackio's built-in models (also in the Default tab). */
  builtin: boolean;
  available: boolean;
  reason?: string;
};

export type CustomSearch = {
  items: CustomRow[];
  total: number;
  page: number;
  pages: number;
  /** Models per connected provider for this task, for the filter chips. */
  providers: { id: ProviderId; name: string; count: number }[];
  /** Providers with catalogs Crackio could search once they're connected. */
  unconnected: { id: ProviderId; name: string }[];
  /** While Crackio reads every model's schema the first time. */
  warming: { done: number; total: number } | null;
  task: ModelTask;
};
