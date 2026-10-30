/** Crackio runs on ComfyUI only: your Comfy key (Comfy Router, Comfy Cloud) and your own ComfyUIs. */
export type ProviderId = "comfy-cloud" | "comfy-local";

export type Capability = "image" | "edit" | "video" | "llm" | "vision";

export type ConnectionState =
  /** Ready to generate. */
  | "connected"
  /** Credentials exist but need attention (expired session, unreachable server). */
  | "attention"
  /** Not set up on this machine. */
  | "missing";

export type ConnectionStatus = {
  id: ProviderId;
  name: string;
  /** How Crackio authenticates: an API key, a subscription sign-in, or a local server. */
  auth: "api-key" | "subscription" | "local-server";
  state: ConnectionState;
  /** One plain sentence explaining the current state. */
  detail: string;
  capabilities: readonly Capability[];
  setup: { label: string; command?: string; url?: string; envVar?: string };
  /** For subscriptions: who is signed in and how. */
  account?: {
    plan?: string;
    email?: string;
    via: string;
    /** Signed in through OpenAI's official Sign in with ChatGPT. */
    official?: boolean;
    /** Whether this sign-in can make images (ChatGPT's official route can't). */
    images?: boolean;
  };
  /** Whether Crackio has an engine adapter for this provider yet (set by the API). */
  ready?: boolean;
};
