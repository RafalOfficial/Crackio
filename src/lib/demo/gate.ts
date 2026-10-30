import "server-only";
import { listGenerations } from "@/lib/server/db";
import { charge } from "./codes";
import { demoFull, demoOn } from "./config";
import { sessionOf } from "./session";

type Priced = { credits: number } | { error: string };

/**
 * Before a live-demo job is queued: a signed-in code, none of its jobs still running, and enough credits, which are taken
 * now (lib/demo/codes gives them back if the job fails). Returns the owner to stamp on the generation, or the response to
 * send instead. Outside the demo there's nothing to check.
 */
export async function demoJob(request: Request, job: string, price: () => Priced | Promise<Priced>): Promise<{ owner?: string; response?: Response }> {
  if (!demoOn()) return {};
  const owner = await sessionOf(request);
  if (!owner) return { response: Response.json({ error: "Enter your access code first (top of the page)." }, { status: 401 }) };
  const busy = listGenerations({ limit: 20, owner }).some((g) => g.status === "queued" || g.status === "running");
  if (busy) return { response: Response.json({ error: "Your last job is still running. Wait for it, then go again." }, { status: 429 }) };
  const priced = await price();
  if ("error" in priced) return { response: Response.json({ error: priced.error }, { status: 400 }) };
  const paid = await charge(owner, priced.credits, job);
  if (!paid.ok) {
    return {
      response: Response.json({ error: `This takes ${priced.credits} credits and your code has ${paid.left} left.` }, { status: 402 }),
    };
  }
  return { owner };
}

/**
 * The full demo: whether a job may run on the demo's own GPU, so its credits are held. Not when it asks for a cloud model
 * (the visitor's own Comfy key) or one of the visitor's own machines, by the job's own pick or Run on; Auto may, and then
 * what really ran there is charged when it ends (lib/demo/codes `settle`). Always yes outside the full demo.
 */
export async function demoGpuMayRun(model: string, params?: Record<string, unknown>): Promise<boolean> {
  if (!demoFull()) return true;
  if (model !== "auto" && !model.startsWith("local:")) return false;
  const [{ demoGpuId }, { getSettings }] = await Promise.all([import("@/lib/server/comfy-targets"), import("@/lib/server/settings")]);
  const own = demoGpuId();
  const picked = (params?.options as { machine?: unknown } | undefined)?.machine;
  const machine = typeof picked === "string" && picked !== "auto" ? picked : (await getSettings()).runOn;
  return !machine || machine === "auto" || machine === own;
}
