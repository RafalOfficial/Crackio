import "server-only";
import { getSettings } from "./settings";
import { getPod, jupyterAnswers, jupyterExec, podJupyter, type Jupyter } from "./runpod-pods";

/**
 * A RunPod pod with no public IP (Community Cloud machines without one) has no SSH straight in, and RunPod's
 * ssh.runpod.io proxy is an interactive shell only: Crackio runs its scripts there through the pod's JupyterLab instead.
 * ssh.ts sends a login that names the pod's JupyterLab here; its address and token come from your RunPod key.
 */

const looked = new Map<string, { at: number; value: Promise<Jupyter | null> }>();

/** The pod's JupyterLab (address and JUPYTER_PASSWORD from RunPod), read again after ten minutes or when it failed. */
function jupyterOf(podId: string): Promise<Jupyter | null> {
  const hit = looked.get(podId);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.value;
  const value = (async () => {
    const key = (await getSettings()).keys.runpod;
    if (!key) return null;
    const pod = await getPod(key, podId);
    return pod ? podJupyter(pod) : null;
  })();
  looked.set(podId, { at: Date.now(), value });
  value.then(
    (j) => !j && looked.delete(podId),
    () => looked.delete(podId),
  );
  return value;
}

/** Whether the pod's JupyterLab answers (what "its SSH answers" means for such a pod). */
export async function podShellAnswers(podId: string): Promise<boolean> {
  const j = await jupyterOf(podId).catch(() => null);
  return j ? jupyterAnswers(j) : false;
}

/** Runs a bash script on the pod through its JupyterLab: its exit code and what it printed. */
export async function podShellRun(podId: string, script: string, opts: { timeoutMs?: number; signal?: AbortSignal }): Promise<{ code: number; out: string }> {
  const j = await jupyterOf(podId);
  if (!j) throw new Error("Crackio can't reach this pod: it has no SSH straight in and RunPod shows no JupyterLab on it.");
  return jupyterExec(j, script, opts);
}
