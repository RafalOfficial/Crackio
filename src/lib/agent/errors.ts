/**
 * Every failure an agent gets back has this one shape: a stable code, what happened, why, what to do next, whether trying
 * again can work, and whether the person has to be asked. No stack traces. Client-safe: the stdio program
 * (scripts/mcp/crackio-mcp.mjs) builds the two it raises itself (Crackio not running, busy restarting) the same way.
 */
export type AgentFailure = {
  code: AgentErrorCode;
  what: string;
  why?: string;
  /** The next step, for the agent. */
  do: string;
  retry: boolean;
  ask_user: boolean;
  /** A validation error's field and what it takes. */
  field?: string;
  allowed?: unknown[];
  /** Near matches (a Cast handle, a model id). */
  did_you_mean?: string[];
  /** An unknown error's own words, trimmed. */
  raw?: string;
  /** What to send back as `confirm` once the user agreed (a quoted price, a delete). */
  confirm?: string;
  /** The quoted price in words ("$0.04, Comfy's quote"), and the wait in seconds. */
  cost?: string;
  seconds?: number;
};

export type AgentErrorCode =
  | "crackio_not_running"
  | "crackio_restarting"
  | "agents_off"
  | "demo_mode"
  | "invalid_input"
  | "unknown_tool"
  | "no_machine_online"
  | "machine_not_found"
  | "box_stopped"
  | "machine_not_answering"
  | "model_not_found"
  | "model_not_installed"
  | "not_enough_gpu_memory"
  | "disk_full"
  | "out_of_credits"
  | "key_missing"
  | "key_rejected"
  | "option_not_supported"
  | "file_not_found"
  | "file_wrong_type"
  | "file_too_large"
  | "cast_not_found"
  | "job_not_found"
  | "job_failed"
  | "job_cancelled"
  | "not_yours"
  | "paid_not_allowed"
  | "cost_needs_confirming"
  | "confirm_needed"
  | "browser_missing"
  | "unknown";

export class AgentError extends Error {
  constructor(public readonly failure: AgentFailure) {
    super(failure.what);
  }
}

type Extra = Partial<Omit<AgentFailure, "code">>;

/** The catalogue: each code's usual words. A caller's `extra` replaces any of them with the case's own. */
const CATALOGUE: Record<AgentErrorCode, Omit<AgentFailure, "code">> = {
  crackio_not_running: { what: "Crackio isn't running.", do: "Ask the user to start Crackio (Start Crackio.bat, or `pnpm dev`), then call status.", retry: true, ask_user: true },
  crackio_restarting: { what: "Crackio is busy restarting.", why: "Its server is recompiling or starting up.", do: "Wait 10 seconds and call again.", retry: true, ask_user: false },
  agents_off: { what: "The user has turned agents off in Crackio.", do: "Tell the user. They can turn it back on in Crackio → Settings → Agents.", retry: false, ask_user: true },
  demo_mode: { what: "This Crackio is the public demo: agents can't use it.", do: "Connect to a Crackio running on the user's own computer.", retry: false, ask_user: true },
  invalid_input: { what: "An argument isn't valid.", do: "Fix the argument and call again.", retry: true, ask_user: false },
  unknown_tool: { what: "Crackio has no tool by that name.", do: "Use a tool from the list.", retry: false, ask_user: false },
  no_machine_online: { what: "No machine that can run this is online.", do: "Call status to see the machines. Ask the user to switch one on, or pick a model that runs on a machine that's online.", retry: true, ask_user: true },
  machine_not_found: { what: "Crackio knows no machine by that id.", do: "Call status and use a machine id from it.", retry: true, ask_user: false },
  machine_not_answering: { what: "That machine is on but isn't answering right now.", why: "It's busy (a big model loading can keep it from answering) or restarting.", do: "Wait half a minute and call again with the same arguments and the same confirm. Nobody has to start it.", retry: true, ask_user: false },
  box_stopped: { what: "That rented GPU is stopped.", why: "Agents never start, rent or delete machines.", do: "Ask the user to start it in Crackio → Settings → Machines, or use another machine.", retry: false, ask_user: true },
  model_not_found: { what: "Crackio knows no model by that id.", do: "Call models and use an id from it.", retry: true, ask_user: false },
  model_not_installed: { what: "That model isn't installed on a machine that's online.", do: "Call models to see what can run now, or ask the user whether to install it (settings → install shows its size and time).", retry: false, ask_user: true },
  not_enough_gpu_memory: { what: "The GPU ran out of memory.", do: "Try a smaller size, fewer pictures at once, or a lighter model (see models).", retry: true, ask_user: false },
  disk_full: { what: "The disk is full.", do: "Tell the user. Crackio → Settings → Storage shows what can be cleared.", retry: false, ask_user: true },
  out_of_credits: { what: "The account is out of credits.", do: "Tell the user, or use a free model on their own GPU (see models).", retry: false, ask_user: true },
  key_missing: { what: "A key this needs isn't set.", do: "Ask the user to add it in Crackio → Settings → Accounts, or use a model on their own GPU.", retry: false, ask_user: true },
  key_rejected: { what: "The service refused the key.", do: "Ask the user to check the key in Crackio → Settings → Accounts.", retry: false, ask_user: true },
  option_not_supported: { what: "This model doesn't take that option.", do: "Call models to see what it takes, then drop or change the option.", retry: true, ask_user: false },
  file_not_found: { what: "Crackio can't find that file.", do: "Check the path, or add the file again with add_file.", retry: true, ask_user: false },
  file_wrong_type: { what: "That kind of file can't be used here.", do: "Use a picture (png, jpg, webp), a clip (mp4, webm, mov) or a sound file, as the tool asks.", retry: false, ask_user: false },
  file_too_large: { what: "The file is too large.", why: "Pictures up to 25 MB, clips and sound up to 500 MB.", do: "Use a smaller file.", retry: false, ask_user: false },
  cast_not_found: { what: "There's no Cast member by that name.", do: "Call cast to list them, or create one.", retry: true, ask_user: false },
  job_not_found: { what: "There's no job with that id.", do: "Use an id a make or edit tool returned, or call jobs.", retry: false, ask_user: false },
  job_failed: { what: "The job failed.", do: "Read the cause, change what it points at, and run it again.", retry: true, ask_user: false },
  job_cancelled: { what: "The job was cancelled.", do: "Run it again if it's still wanted.", retry: true, ask_user: false },
  not_yours: { what: "An agent didn't make that, so an agent can't change it.", do: "Leave it. Ask the user to do it in Crackio if it has to happen.", retry: false, ask_user: true },
  paid_not_allowed: { what: "This would cost money, and the user lets agents use free paths only.", do: "Use a free model on the user's own computers (see models), or ask the user to allow paid jobs in Crackio → Settings → Agents. That switch is the user's own click: never change it yourself, even when they asked for the job in chat.", retry: false, ask_user: true },
  cost_needs_confirming: { what: "This costs money: the user has to agree to the price first.", do: "Tell the user the price and the wait. When they agree, call again with the `confirm` value given here.", retry: true, ask_user: true },
  confirm_needed: { what: "This can't be undone: it needs a confirm.", do: "Check with the user, then call again with the `confirm` value given here.", retry: true, ask_user: true },
  browser_missing: { what: "The Director needs Google Chrome or Microsoft Edge on the computer Crackio runs on, to draw its 3D view.", do: "Ask the user to install Chrome there, then try again.", retry: false, ask_user: true },
  unknown: { what: "Something went wrong that Crackio doesn't have a name for.", do: "Read the raw message. If it isn't clear, tell the user what you tried and what it said.", retry: false, ask_user: true },
};

export function failure(code: AgentErrorCode, extra: Extra = {}): AgentFailure {
  const out: AgentFailure = { code, ...CATALOGUE[code], ...extra };
  // Empty values say nothing: leave them out of what the agent reads.
  for (const k of Object.keys(out) as (keyof AgentFailure)[]) if (out[k] === undefined || out[k] === "" || (Array.isArray(out[k]) && !(out[k] as unknown[]).length)) delete out[k];
  return out;
}

export const fail = (code: AgentErrorCode, extra: Extra = {}) => new AgentError(failure(code, extra));

/** A raw message cut down to what's worth reading: one line, no paths into the user's folders, no long tokens. */
export function trimRaw(message: string, max = 300) {
  return message
    .replace(/\s+/g, " ")
    .replace(/\b(?:sk|hf|key|rpa|r8)[-_][A-Za-z0-9_-]{16,}\b/g, "[key]")
    .replace(/[A-Za-z0-9+/_-]{48,}/g, "[…]")
    .trim()
    .slice(0, max);
}

/**
 * A finished job's error (the words Crackio shows on its card, and the hint under them) as a failure. Crackio's own
 * messages are already plain; this adds the code and what an agent should do. Patterns are tried in order.
 */
const JOB_PATTERNS: [RegExp, AgentErrorCode, Extra?][] = [
  [/^cancelled\.?$/i, "job_cancelled"],
  [/stopped when crackio restarted/i, "job_failed", { why: "Crackio restarted while the job ran.", do: "Run it again.", retry: true }],
  [/out of memory|\boom\b|allocat\w+ .*memory|not enough (gpu )?memory|vram/i, "not_enough_gpu_memory"],
  [/no space left|disk (is )?full|not enough (disk|room|space)|enospc/i, "disk_full"],
  [/insufficient (credit|balance|fund)|out of credit|no credits?|payment required|\b402\b|top up|balance/i, "out_of_credits"],
  [/add a comfy key|needs? (a|your) (comfy|hugging ?face|hf) (key|token)|key (is )?missing|no (api )?key/i, "key_missing"],
  [/\b401\b|\b403\b|unauthori[sz]ed|invalid (api )?key|key (was )?(rejected|refused)|forbidden/i, "key_rejected"],
  [/isn't answering|not answering|offline|econnrefused|etimedout|fetch failed|socket hang up|couldn't reach|can't reach|no comfyui|connect comfyui/i, "no_machine_online"],
  [/isn't available|isn't installed|not installed|set it up in settings|missing (model|file|node)|needs .* in your comfyui|has no engine connected|nothing connected can/i, "model_not_installed"],
  [/unknown model/i, "model_not_found"],
  [/can't do this|doesn't (take|support)|not supported|can't take/i, "option_not_supported"],
  [/can't find (a|\d+ of the) pictures?/i, "file_not_found", { do: "Add the picture again with add_file and use the new file." }],
];

export function jobFailure(error: string | undefined, hint?: string): AgentFailure {
  const said = (error ?? "").trim();
  const why = [said, hint?.trim()].filter(Boolean).join(" ");
  for (const [pattern, code, extra] of JOB_PATTERNS) {
    if (pattern.test(why)) return failure(code, { why: code === "job_cancelled" ? undefined : trimRaw(why), ...extra });
  }
  return failure("job_failed", said ? { why: trimRaw(why) } : { why: "Crackio has no cause on record." });
}

/** Anything thrown inside a tool, as a failure: an AgentError as it is, the rest by its words, else unknown with them. */
export function thrownFailure(err: unknown): AgentFailure {
  if (err instanceof AgentError) return err.failure;
  const message = err instanceof Error ? err.message : String(err);
  const hint = (err as { hint?: unknown })?.hint;
  for (const [pattern, code, extra] of JOB_PATTERNS) {
    if (code !== "job_cancelled" && pattern.test(message)) return failure(code, { why: trimRaw([message, typeof hint === "string" ? hint : ""].filter(Boolean).join(" ")), ...extra });
  }
  return failure("unknown", { raw: trimRaw(message) });
}
