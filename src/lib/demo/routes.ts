import { demoFull, demoTools, type DemoTool } from "./config";

/**
 * The API a demo answers, method by method. Everything else is a 404: settings, keys, logins and connections, the Local
 * page's installs and machines, the ComfyUI relay, Motion's agent, URL downloads, the lab, and every tool left out.
 * "open" works without a code (reading the model list, your own work); "code" spends the GPU or stores a file, so it
 * needs a signed-in access code.
 */
type Access = "open" | "code";
type Rule = [method: string, pattern: RegExp, access: Access];

const ID = "[A-Za-z0-9_-]{1,64}";
const rx = (path: string) => new RegExp(`^${path.replaceAll(":id", ID)}$`);

/** What every demo page leans on: the model list, your generations and Library, uploads and media. */
const COMMON: Rule[] = [
  ["GET", rx("/api/demo/session"), "open"],
  ["POST", rx("/api/demo/session"), "open"],
  ["DELETE", rx("/api/demo/session"), "open"],
  ["GET", rx("/api/generations"), "open"],
  ["POST", rx("/api/generations"), "code"],
  ["GET", rx("/api/generations/:id"), "open"],
  ["GET", rx("/api/generations/:id/recipe"), "open"],
  ["DELETE", rx("/api/generations/:id"), "code"],
  ["POST", rx("/api/generations/:id/cancel"), "code"],
  ["POST", rx("/api/uploads"), "code"],
  ["GET", rx("/api/models"), "open"],
  ["GET", rx("/api/models/caps"), "open"],
  ["GET", rx("/api/models/custom"), "open"],
  ["GET", rx("/api/models/preview/[A-Za-z0-9._-]{1,200}"), "open"],
  ["GET", rx("/api/models/price"), "open"],
  ["POST", rx("/api/models/quote"), "open"],
  ["GET", rx("/api/connections"), "open"],
  ["GET", rx("/api/local"), "open"],
  ["POST", rx("/api/local/eta"), "open"],
  // Library projects aren't kept per code, so the demo's Library is one list of your own takes.
  ["GET", rx("/api/library"), "open"],
  ["GET", rx("/api/media/(out|uploads)/.+"), "open"],
];

/** Picking things in a clip: a frame, its outlines and what each one is. */
const CLIP_PICKING: Rule[] = [
  ["POST", rx("/api/recast/frame"), "code"],
  ["POST", rx("/api/recast/detect"), "code"],
  ["POST", rx("/api/recast/describe"), "code"],
  ["POST", rx("/api/detect"), "code"],
  ["POST", rx("/api/swap/outline"), "code"],
];

/** Every route under a path: reading is open, changing needs the code. */
const area = (path: string): Rule[] => {
  const pattern = new RegExp(`^${path}(/.*)?$`);
  return [["GET", pattern, "open"], ...(["POST", "PUT", "PATCH", "DELETE"] as const).map((m): Rule => [m, pattern, "code"])];
};

const BY_TOOL: Partial<Record<DemoTool, Rule[]>> = {
  recast: [...CLIP_PICKING, ["POST", rx("/api/swap/run"), "code"]],
  templates: [...CLIP_PICKING, ["POST", rx("/api/templates/run"), "code"], ["POST", rx("/api/templates/describe"), "code"]],
  // The full demo's tools (one process per code, so these stores are the code's own).
  // Vision (on the server's CPU): cut-outs, masks, depth and reading a subject; its status is read while the 3D tools load.
  director: [...area("/api/director"), ["GET", rx("/api/vision"), "open"], ["POST", rx("/api/vision"), "code"], ["POST", rx("/api/detect"), "code"]],
  cast: [...area("/api/cast"), ["GET", rx("/api/vision"), "open"], ["POST", rx("/api/vision"), "code"], ["POST", rx("/api/detect"), "code"]],
  product: [...area("/api/product")],
  // The editor's routes (singular); the old autopilot under /api/storyboards stays out. Its Director mode leans on Director's.
  storyboard: [...area("/api/storyboard")],
};

/**
 * The full demo also has Connections for the visitor's own Comfy, RunPod and vast keys (api/settings takes only those
 * there), serverless endpoints and the GPUs they rent, and the Library's projects. Not Local's installs or LoRAs, the
 * ComfyUI relay, Motion or the lab.
 */
const FULL: Rule[] = [
  ["GET", rx("/api/settings"), "open"],
  ["PATCH", rx("/api/settings"), "code"],
  ...area("/api/serverless"),
  ...area("/api/local/cloud"),
  ...area("/api/library/projects"),
  ["POST", rx("/api/library/move"), "code"],
  // Read only: what the Local store lists (model cards and the Director's picker read it); its installs stay shut.
  ["GET", rx("/api/local/catalog"), "open"],
];

/** How a demo answers `method pathname` under /api: open, code-only, or not at all (null). */
export function demoApi(method: string, pathname: string, tools = demoTools()): Access | null {
  const m = method === "HEAD" ? "GET" : method;
  const rules = [...COMMON, ...(demoFull() ? FULL : []), ...[...tools].flatMap((t) => BY_TOOL[t] ?? [])];
  for (const [rm, pattern, access] of rules) if (rm === m && pattern.test(pathname)) return access;
  return null;
}
