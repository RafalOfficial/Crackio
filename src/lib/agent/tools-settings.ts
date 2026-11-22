import "server-only";
import { createHmac } from "node:crypto";
import { z } from "zod";
import { formatMoney } from "@/lib/models/pricing";
import { listModels } from "@/lib/models/resolve";
import { getSettings, updateSettings } from "@/lib/server/settings";
import { SetupError, startSetup } from "@/lib/server/setup/jobs";
import { setupSnapshot } from "@/lib/server/setup/status";
import type { KitId, SetupMachine } from "@/lib/setup/types";
import { fail } from "./errors";
import { machineView, whyOffline } from "./machines";
import { nearest } from "./plan";
import { agentSecret } from "./prefs";
import { confirm, tool } from "./shared";

/**
 * Settings for agents: read how Crackio is set up (never a key's value: only whether it's set), change the two
 * defaults that are safe to change, and set a tool up on a machine after the user agreed to its size and time.
 */

const KITS = ["image", "video", "director", "angles", "relight", "cast", "retouch", "product", "recast", "upscale", "voice"] as const satisfies readonly KitId[];
const KIT_NAME: Record<(typeof KITS)[number], string> = { image: "Image", video: "Video", director: "Director", angles: "Angles", relight: "Relight", cast: "Cast", retouch: "Retouch", product: "Product Studio", recast: "Swap", upscale: "Upscale", voice: "Voice" };

const gb = (bytes: number) => Math.round((bytes / 1e9) * 10) / 10;

/** A tool on a machine in a few words: "ready", "missing (12.3 GB to install)", "can't run here: …". */
function toolWords(m: SetupMachine, kit: KitId): string {
  const t = m.tools[kit];
  if (!t) return "unknown";
  if (t.state === "ready") return "ready";
  if (t.state === "missing" || t.state === "no-comfy") return `not installed (${gb(t.bytes)} GB to install)`;
  if (t.state === "installing") return "installing now";
  if (t.state === "offline") return "machine offline";
  return `${t.state.replace(/-/g, " ")}: ${t.why}`;
}

const changeToken = (...what: string[]) => createHmac("sha256", agentSecret()).update(`change:${what.join(":")}`).digest("hex").slice(0, 10);
const installToken = (machine: string, kit: string, bytes: number) => createHmac("sha256", agentSecret()).update(`install:${machine}:${kit}:${bytes}`).digest("hex").slice(0, 10);

export const settings = tool({
  name: "settings",
  title: "Settings",
  description: "How Crackio is set up: defaults, Run on, the tools on each machine, keys (set or missing). Can change a default or install a tool, each after the user's yes.",
  input: z.object({
    action: z.enum(["read", "set_default_model", "set_run_on", "install"]).describe("What to do."),
    kind: z.enum(["image", "video", "upscale"]).optional().describe("set_default_model: which default."),
    model: z.string().max(300).optional().describe('set_default_model: a model id from models, or "auto".'),
    machine: z.string().max(80).optional().describe('set_run_on: a machine id from status, or "auto". install: the machine to install on.'),
    tool: z.enum(KITS).optional().describe("install: the tool to set up there."),
    extras: z.boolean().optional().describe("install: also the tool's optional parts (Upscale: a clip upscaler)."),
    confirm,
  }),
  destructive: false,
  async run(args, ctx) {
    const snap = await setupSnapshot(args.action !== "read");
    const machines = snap.machines.filter((m) => m.id !== "this-computer" || m.comfy.installed || m.kind === "this-computer");

    if (args.action === "read") {
      const s = await getSettings();
      return {
        data: {
          default_models: { image: s.models.image ?? "auto", video: s.models.video ?? "auto", upscale: s.models.upscale ?? "auto" },
          run_on: s.runOn ?? "auto",
          agents: { spend: ctx.prefs.spend === "free" ? "free machines and models only" : ctx.prefs.spend === "all" ? "paid allowed without asking: the user switched confirmations off" : "paid allowed after the user agrees to each price", see_pictures: ctx.prefs.seePictures },
          keys: Object.fromEntries(Object.entries(snap.keys).map(([k, v]) => [k, v ? "set" : "missing"])),
          machines: machines.map((m) => ({
            id: m.id,
            name: m.label,
            online: m.online,
            ...(m.online ? {} : { why_offline: whyOffline(m) }),
            ...(m.diskFreeGb != null ? { free_disk_gb: Math.round(m.diskFreeGb * 10) / 10 } : {}),
            // What's on a machine that's off isn't known until it answers.
            ...(m.online || (m.kind === "this-computer" && !m.comfy.installed) ? { tools: Object.fromEntries(KITS.map((k) => [k, toolWords(m, k)])) } : {}),
          })),
          setups_running: snap.jobs.filter((j) => j.state === "running" || j.state === "queued").map((j) => ({ machine: j.machineLabel, tools: j.kits, steps: j.steps.map((st) => `${st.label}: ${st.state}${st.progress?.total ? ` ${Math.round((st.progress.received / st.progress.total) * 100)}%` : ""}`) })),
        },
      };
    }

    if (args.action === "set_default_model") {
      if (!args.kind || !args.model) throw fail("invalid_input", { field: args.kind ? "model" : "kind", what: 'set_default_model needs "kind" and "model".' });
      const kind = args.kind;
      const wanted = args.model;
      if (wanted !== "auto") {
        const list = (await listModels()).filter((m) => m.kind === kind);
        if (!list.some((m) => m.id === wanted)) {
          const other = (await listModels()).find((m) => m.id === wanted);
          if (other) throw fail("option_not_supported", { field: "model", what: `${other.name} is a ${other.kind} model, not ${kind === "image" ? "an image" : `a ${kind}`} model.`, do: `Pass kind: "${other.kind}" for it, or a model id from models (kind ${kind}).` });
          throw fail("model_not_found", { field: "model", did_you_mean: nearest(wanted, list) });
        }
      }
      const defaultToken = changeToken("default", kind, wanted);
      if (args.confirm !== defaultToken) {
        throw fail("confirm_needed", { what: `This changes the user's own default ${kind} model to ${wanted}, for their screens too.`, do: "Do it only if the user asked. Then call again with this confirm.", confirm: defaultToken });
      }
      const next = await updateSettings((s) => {
        const models = { ...s.models };
        if (wanted === "auto") delete models[kind];
        else models[kind] = wanted;
        return { ...s, models };
      });
      return { data: { default_models: { image: next.models.image ?? "auto", video: next.models.video ?? "auto", upscale: next.models.upscale ?? "auto" }, note: "This is the user's own default too: tell them you changed it." } };
    }

    if (args.action === "set_run_on") {
      const wanted = args.machine;
      if (!wanted) throw fail("invalid_input", { field: "machine", what: 'set_run_on needs "machine": an id from status, or "auto".' });
      if (wanted !== "auto") {
        const m = machines.find((x) => x.id === wanted);
        if (!m) throw fail("machine_not_found", { field: "machine", allowed: ["auto", ...machines.map((x) => x.id)] });
        if (machineView(m, snap).paid && ctx.prefs.spend === "free") throw fail("paid_not_allowed", { what: `${m.label} costs money: sending the user's jobs there is theirs to decide.` });
      }
      const runToken = changeToken("run_on", wanted);
      if (args.confirm !== runToken) throw fail("confirm_needed", { what: wanted === "auto" ? "This puts the user's own Run on back to Auto." : `This sends the user's own jobs to ${wanted} too.`, do: "Do it only if the user asked. Then call again with this confirm.", confirm: runToken });
      await updateSettings((s) => ({ ...s, runOn: wanted === "auto" ? undefined : wanted }));
      return { data: { run_on: wanted, note: "This is where the user's own jobs go too: tell them you changed it." } };
    }

    // install
    if (!args.machine || !args.tool) throw fail("invalid_input", { field: args.machine ? "tool" : "machine", what: 'install needs "machine" and "tool".' });
    const m = machines.find((x) => x.id === args.machine);
    if (!m) throw fail("machine_not_found", { field: "machine", allowed: machines.map((x) => x.id) });
    const view = machineView(m, snap);
    if (!m.online && !(m.kind === "this-computer" && !m.comfy.installed)) throw fail(view.paid ? "box_stopped" : "no_machine_online", { what: `${m.label} isn't online: ${whyOffline(m)}.` });
    if (view.paid && ctx.prefs.spend === "free") throw fail("paid_not_allowed", { what: `${m.label} costs money while it downloads, and the user lets agents use free machines only.`, do: "Install on one of the user's own computers, or ask the user to allow paid jobs in Crackio → Settings → Agents." });
    const t = m.tools[args.tool];
    const name = KIT_NAME[args.tool];
    if (!t) throw fail("invalid_input", { field: "tool", what: `${name} can't be set up on ${m.label}.` });
    // What a tool can also have beyond what it needs (Upscale's clip upscaler): asked for with extras.
    const optional = t.reqs.filter((r) => r.optional && r.state === "missing" && r.plan);
    const extras = args.extras ? optional : [];
    const partBytes = (r: (typeof optional)[number]) => (r.plan && "bytes" in r.plan && typeof r.plan.bytes === "number" ? r.plan.bytes : 0);
    if (t.state === "ready" && !extras.length) {
      return { data: { already: `${name} is ready on ${m.label}.`, ...(optional.length ? { optional: optional.map((r) => `${r.label} (${r.why}, ${gb(partBytes(r))} GB)`), add_them: "install again with extras: true" } : {}) } };
    }
    const own = snap.jobs.some((j) => j.machine === m.id && (j.state === "running" || j.state === "queued") && j.kits.includes(args.tool!));
    if (t.state === "installing" && own) return { data: { already: `${name} is being installed on ${m.label} now. settings read shows its progress.` } };
    if (t.state === "installing") {
      // Files it shares with another tool are downloading; what only it needs isn't asked for yet.
      throw fail("option_not_supported", { what: `Part of ${name} is downloading on ${m.label} with another tool's set-up. Its own parts can be asked for when that finishes.`, do: "Call settings read until that download is done, then install again.", retry: true, ask_user: false });
    }
    if (t.state !== "missing" && t.state !== "no-comfy" && !(t.state === "ready" && extras.length)) throw fail(t.state === "needs-key" ? "key_missing" : "option_not_supported", { what: `${name} can't be set up on ${m.label} now: ${t.why}` });
    const bytes = (t.state === "ready" ? 0 : t.bytes) + extras.reduce((n, r) => n + partBytes(r), 0);
    const size = gb(bytes);
    if (m.diskFreeGb != null && size + m.spareGb > m.diskFreeGb) throw fail("disk_full", { what: `${name} needs ${size} GB on ${m.label}, which has ${Math.round(m.diskFreeGb * 10) / 10} GB free (Crackio keeps ${m.spareGb} GB spare).` });
    // A download's time depends on the line: said for a fast one and a slow one.
    const minutes = (mbps: number) => Math.max(1, Math.round(bytes / 1e6 / mbps / 60));
    const time = `about ${minutes(60)} min on a fast line, ${minutes(10)} min on a slow one`;
    const cost = view.paid && m.pricePerHour != null ? `${m.label} costs ${formatMoney(m.pricePerHour)} an hour while it downloads` : "free";
    const token = installToken(m.id, args.tool, bytes);
    if (args.confirm !== token) {
      throw fail("confirm_needed", {
        what: `Setting ${name} up on ${m.label} downloads ${size} GB (${time}). ${cost === "free" ? "It costs nothing." : `${cost}.`}`,
        do: "Tell the user the size and the time. When they agree, call again with this confirm.",
        confirm: token,
      });
    }
    try {
      const job = await startSetup(snap, { machine: m.id, kits: [args.tool], ...(extras.length ? { include: extras.map((r) => r.id) } : {}) });
      return { data: { installing: name, on: m.label, size_gb: size, steps: job.steps.map((st) => st.label), note: "It runs by itself. settings read shows its progress; the tool is usable when it says ready." } };
    } catch (err) {
      if (err instanceof SetupError) throw fail(/hugging face|token/i.test(err.message) ? "key_missing" : /room|space|disk/i.test(err.message) ? "disk_full" : "option_not_supported", { what: err.message });
      throw err;
    }
  },
});
