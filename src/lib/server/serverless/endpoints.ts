import "server-only";
import { getSettings } from "../settings";
import { endpointsFromEnv, type ServerlessEndpoint } from "./runpod";
import { demoOn } from "@/lib/demo/config";

/**
 * The RunPod Serverless endpoints Crackio runs jobs on: RUNPOD_ENDPOINT_ID with RUNPOD_API_KEY (a hosted Crackio), and the
 * ones added under Connections with your own RunPod key (settings `serverless`, `keys.runpod`). None unless set up.
 */
export async function serverlessEndpoints(): Promise<ServerlessEndpoint[]> {
  const settings = await getSettings();
  // On a live demo, the endpoints a visitor adds run on their own key only, never on the server's.
  const key = settings.keys.runpod?.trim() || (demoOn() ? "" : process.env.RUNPOD_API_KEY?.trim()) || "";
  const added = key ? (settings.serverless ?? []).map((e) => ({ endpointId: e.endpointId.trim(), apiKey: key, label: e.label?.trim() || "RunPod Serverless" })) : [];
  const all = [...endpointsFromEnv(), ...added].filter((e) => /^[\w-]{4,64}$/.test(e.endpointId));
  return all.filter((e, i) => all.findIndex((x) => x.endpointId === e.endpointId) === i);
}
