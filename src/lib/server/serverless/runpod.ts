import "server-only";

/**
 * RunPod Serverless: GPUs that start when a job comes in and stop when there's none (scale to zero). One endpoint runs
 * Crackio's ComfyUI worker (serverless/worker); this calls its queue API. RUNPOD_API_KEY and RUNPOD_ENDPOINT_ID name it.
 */
/** `fromEnv`: set up by the server (a hosted Crackio), not under Connections. */
export type ServerlessEndpoint = { endpointId: string; apiKey: string; label: string; fromEnv?: boolean };

export type JobStatus = {
  id: string;
  status: "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED" | "FAILED" | "CANCELLED" | "TIMED_OUT";
  /** Milliseconds in the queue and starting a worker, and running: what RunPod bills. */
  delayTime?: number;
  executionTime?: number;
  output?: unknown;
  error?: string;
  workerId?: string;
};

export function endpointsFromEnv(): ServerlessEndpoint[] {
  const endpointId = process.env.RUNPOD_ENDPOINT_ID?.trim();
  const apiKey = process.env.RUNPOD_API_KEY?.trim();
  return endpointId && apiKey ? [{ endpointId, apiKey, label: process.env.RUNPOD_LABEL?.trim() || "RunPod Serverless", fromEnv: true }] : [];
}

const API = "https://api.runpod.ai/v2";

/** RUNPOD_API_BASE: a worker's own test server (`handler.py --rp_serve_api`), which serves one endpoint's routes at its root. */
const base = (ep: ServerlessEndpoint) => process.env.RUNPOD_API_BASE?.trim().replace(/\/+$/, "") || `${API}/${encodeURIComponent(ep.endpointId)}`;

async function call<T>(ep: ServerlessEndpoint, route: string, init: RequestInit = {}, timeoutMs = 30_000): Promise<T> {
  const res = await fetch(`${base(ep)}${route}`, {
    ...init,
    headers: { Authorization: `Bearer ${ep.apiKey}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(timeoutMs),
    cache: "no-store",
  });
  const text = await res.text();
  // Never the endpoint's id in an error a job keeps: it can reach pages (a live demo shows its visitors their errors).
  if (!res.ok) throw new Error(res.status === 401 ? "RunPod refused the API key." : `RunPod answered ${res.status}: ${text.split(ep.endpointId).join("(endpoint)").slice(0, 300)}`);
  return JSON.parse(text) as T;
}

/** Queues a job; `executionMs` raises the endpoint's own limit for a long one (a clip, a fetch of models). */
export const submit = (ep: ServerlessEndpoint, input: unknown, executionMs = 30 * 60_000) =>
  call<{ id: string; status: string }>(ep, "/run", { method: "POST", body: JSON.stringify({ input, policy: { executionTimeout: executionMs, ttl: Math.max(executionMs * 2, 3_600_000) } }) });

// A test server takes its status asks as POSTs.
export const status = (ep: ServerlessEndpoint, id: string) => call<JobStatus>(ep, `/status/${encodeURIComponent(id)}`, process.env.RUNPOD_API_BASE ? { method: "POST" } : {});

export const cancel = (ep: ServerlessEndpoint, id: string) => call(ep, `/cancel/${encodeURIComponent(id)}`, { method: "POST" }).catch(() => undefined);

/** Workers and jobs right now; free (no worker starts for it). A test server has no /health: it's up when it answers. */
export const health = (ep: ServerlessEndpoint) =>
  process.env.RUNPOD_API_BASE ? Promise.resolve({}) : call<{ jobs?: Record<string, number>; workers?: Record<string, number> }>(ep, "/health", {}, 10_000);

/** What RunPod charges a second for the GPU a job ran on (its serverless prices, Oct 2026), by the name the worker reports. */
export function pricePerSecond(gpu: string | null | undefined) {
  const n = (gpu ?? "").toUpperCase();
  const hourly = /H200/.test(n) ? 6.99 : /H100/.test(n) ? 5.39 : /B200/.test(n) ? 10.79 : /A100/.test(n) ? 2.72 : /6000 PRO|PRO 6000|BLACKWELL.*96/.test(n) ? 3.49 : /5090/.test(n) ? 1.79 : /L40|6000 ADA/.test(n) ? 1.75 : /4090/.test(n) ? 1.34 : /A6000|A40\b/.test(n) ? 1.22 : /PRO 4500/.test(n) ? 1.15 : /L4\b|A5000|3090/.test(n) ? 0.75 : /A4000|A4500|4000|2000/.test(n) ? 0.58 : 1.79;
  return hourly / 3600;
}
