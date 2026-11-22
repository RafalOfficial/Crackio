import "server-only";
import { createHmac } from "node:crypto";
import fs from "node:fs/promises";
import { z } from "zod";
import { VOICE_MODELS, type VoiceModelId } from "@/lib/voice/models";
import { READY_VOICES } from "@/lib/voice/ready";
import type { VoiceAsk, VoiceCard } from "@/lib/voice/types";
import { AudioError } from "@/lib/server/voice/audio";
import { machineFor, voiceMachines } from "@/lib/server/voice/machines";
import { machineWith, readSample, VoiceSetupError } from "@/lib/server/voice/setup";
import { addVoice, allVoices, removeVoice, scratchPath } from "@/lib/server/voice/store";
import { fail } from "./errors";
import { startJob } from "./jobs";
import { noMachineOnline, paidMachineIds } from "./machines";
import { allMade, forgetMade, madeBy, noteMade } from "./made";
import { formatMoney } from "@/lib/models/pricing";
import { setupSnapshot } from "@/lib/server/setup/status";
import { nearest, requireConfirm, type Plan } from "./plan";
import { agentSecret } from "./prefs";
import { answerJob, confirm, existing, fileArg, tool, waitArg, type ToolContext } from "./shared";

/**
 * Voice: speech from a script, on the user's own GPU. One voice says a line, or several voices hold a conversation. An
 * agent can't hear the result: it gets the length and what speech to text heard back, to check against the script.
 */

const modelIds = VOICE_MODELS.map((m) => m.id) as [VoiceModelId, ...VoiceModelId[]];

async function voiceOf(id: string, all: VoiceCard[], field: string): Promise<VoiceCard> {
  const v = all.find((x) => x.id === id) ?? all.find((x) => x.name.toLowerCase() === id.toLowerCase());
  if (!v) throw fail("invalid_input", { field, what: `There's no voice "${id.slice(0, 40)}".`, did_you_mean: nearest(id, all.filter((x) => x.source === "ready").map((x) => ({ id: x.id, name: x.name }))), do: "Call voice with action list for the voices." });
  return v;
}

/** The voice model to speak with, and the machine that has it: the one asked for, else the first that's set up, among machines the agent may use. */
async function speaker(asked: VoiceModelId | undefined, ctx: ToolContext) {
  const paid = await paidMachineIds();
  let billed: string | null = null;
  for (const id of asked ? [asked] : modelIds) {
    const hit = await machineFor(id);
    if (!hit) continue;
    if (paid.has(hit.target.id) && ctx.prefs.spend === "free") {
      if (asked) throw fail("paid_not_allowed", { what: `${VOICE_MODELS.find((m) => m.id === id)!.name} is on ${hit.machine.label}, which costs money, and the user lets agents use free machines only.` });
      billed ??= hit.machine.label;
      continue;
    }
    return { model: VOICE_MODELS.find((m) => m.id === id)!, machine: hit.machine, paid: paid.has(hit.target.id) };
  }
  // Voice is there and online, only on a machine that bills: that's the reason to give, not "nothing is online".
  if (billed) throw fail("paid_not_allowed", { what: `Voice is on ${billed}, which costs money, and the user lets agents use free machines only.` });
  if (asked) throw fail("model_not_installed", { what: `${VOICE_MODELS.find((m) => m.id === asked)!.name} isn't set up on a machine that's online.`, do: "Call voice with action list to see what is, or ask the user to set Voice up in Crackio → Settings → Tools." });
  const machines = await voiceMachines().catch(() => []);
  const installing = machines.filter((m) => m.online && m.installing);
  if (installing.length) throw fail("model_not_installed", { what: `Voice is still being installed on ${installing.map((m) => m.label).join(", ")}.`, do: "Wait a few minutes (settings read shows its progress), then try again.", retry: true, ask_user: false });
  if (machines.some((m) => m.models.length || m.away?.models.length)) throw await noMachineOnline("Voice is set up, but no machine with it is online.", ctx.prefs);
  throw fail("model_not_installed", { what: "Voice isn't set up on any machine yet.", do: "Ask the user to set Voice up in Crackio → Settings → Tools (one click)." });
}

const removeToken = (id: string) => createHmac("sha256", agentSecret()).update(`delete-voice:${id}`).digest("hex").slice(0, 10);

/** What a machine that bills costs for this many seconds, in the words every paid job uses. */
async function shareOfHour(machine: { id: string; label: string }, seconds: number, what: string): Promise<Plan["cost"]> {
  const perHour = (await setupSnapshot().catch(() => null))?.machines.find((m) => m.id === machine.id)?.pricePerHour ?? null;
  const amount = perHour != null ? Math.round(((perHour * seconds) / 3600) * 10000) / 10000 : null;
  return { free: false, amount, text: perHour != null ? `${machine.label} costs ${formatMoney(perHour)} an hour while it's on; ${what} is about ${formatMoney(amount ?? 0)} of that` : `${machine.label} is billed; Crackio doesn't know its price` };
}

/**
 * A new voice from a recording: the sample is cleaned (mono, up to 30 s, silence cut), its words are taken from `says`
 * or typed out by speech to text, and it's kept as one of the voices. It needs the user's word that the voice is theirs
 * or that its owner agreed; an agent may later remove only the voices agents added.
 */
async function addFromSample(args: { sample?: string; name?: string; says?: string; consent?: boolean; language?: string; confirm?: string; dry_run?: boolean }, all: VoiceCard[], ctx: ToolContext) {
  if (!args.sample || !args.name?.trim()) throw fail("invalid_input", { field: args.sample ? "name" : "sample", what: 'add needs "sample" (a recording of the voice) and "name".' });
  const name = args.name.trim();
  if (all.some((v) => v.name.toLowerCase() === name.toLowerCase() || v.id === name)) throw fail("invalid_input", { field: "name", what: `There's a voice called "${name}" already.`, do: "Pick another name." });
  const src = await existing(args.sample, "sample", ctx.viaProgram);
  if (src.info.kind !== "audio" && src.info.kind !== "video") throw fail("file_wrong_type", { field: "sample", what: '"sample" has to be a sound file or a clip with someone talking.', do: "Pass a recording of 10 to 30 seconds of one person talking." });
  if (!args.consent) {
    throw fail("confirm_needed", { field: "consent", what: "Copying a voice needs the user's word that the voice is theirs, or that its owner agreed.", do: "Ask the user exactly that. If they say yes, call again with consent: true." });
  }
  // Its words: the agent's own, else typed out by a machine that can hear, if the agent may use one.
  const says = args.says?.trim() ?? "";
  let hear = false;
  if (!says) {
    const place = await machineWith((m) => m.files.some((f) => /qwen3-asr/i.test(f))).catch(() => null);
    const billed = place ? (await paidMachineIds()).has(place.machine.id) : false;
    const pass = 'Pass "says" with the sample\'s exact words.';
    if (!place) throw fail("invalid_input", { field: "says", what: "No machine that can type the sample out is online.", do: pass });
    if (billed && ctx.prefs.spend === "free") throw fail("paid_not_allowed", { field: "says", what: `Typing the sample out would run on ${place.machine.label}, which costs money, and the user lets agents use free machines only.`, do: pass });
    const plan: Plan = {
      model: { id: "voice:hearing", name: "Speech to text" },
      machine: { id: place.machine.id, name: place.machine.label, gpu: place.machine.gpu },
      seconds: 15,
      basis: "Voice's usual pace",
      ahead: 0,
      cost: billed ? await shareOfHour(place.machine, 15, "typing the sample out") : { free: true },
    };
    if (args.dry_run) return { data: { dry_run: true, does: "types the sample out, then keeps the voice", machine: place.machine.id, machine_name: place.machine.label, cost: plan.cost.free ? "free" : plan.cost.text, about_seconds: 15 } };
    requireConfirm("voice", args, plan);
    hear = true;
  } else if (args.dry_run) {
    return { data: { dry_run: true, does: "keeps the voice with the words you gave; no machine is used", cost: "free", about_seconds: 3 } };
  }

  let read: Awaited<ReturnType<typeof readSample>>;
  try {
    read = await readSample(src.path, ctx.signal, { hear });
  } catch (err) {
    if (err instanceof VoiceSetupError || err instanceof AudioError) throw fail("file_wrong_type", { field: "sample", what: err.message, do: "Pass a recording of 10 to 30 seconds of one person talking, without music." });
    throw err;
  }
  const scratch = await scratchPath(read.file);
  const text = says || read.text;
  if (!text) {
    await fs.rm(/*turbopackIgnore: true*/ scratch, { force: true });
    throw fail("invalid_input", { field: "says", what: "Speech to text heard no words in the sample.", do: 'Check it has someone talking, or pass "says" with its exact words.' });
  }
  const made = await addVoice({ name, desc: "Copied from a recording", text, sampleFile: scratch, source: "clone", consent: true, language: args.language });
  await fs.rm(/*turbopackIgnore: true*/ scratch, { force: true });
  await noteMade("voice", made.id, ctx.caller.client);
  const weak = [
    ...(read.checks.long ? [] : [`The sample is ${Math.round(read.seconds)} s: 10 to 30 s copies a voice better.`]),
    ...(read.checks.clean ? [] : ["The sample has noise or music under the voice: a clean one copies better."]),
    ...(read.checks.loud ? [] : ["The sample is too loud in places (clipped)."]),
  ];
  return {
    data: {
      added: { voice: made.id, name: made.name },
      sample_seconds: Math.round(read.seconds * 10) / 10,
      says: text,
      words_from: says ? "you" : "speech to text: check them against the recording's real words",
      ...(weak.length ? { weak_points: weak } : {}),
      next: `speak with voice "${made.id}" and give the user the file: only they can say whether it sounds like the voice.`,
    },
  };
}

export const voice = tool({
  name: "voice",
  title: "Voice",
  description: "Speech from a script on the user's GPU: list the voices, have one say a line, make a conversation between several, or add a voice from a recording. You can't hear it: you get its length and what speech to text heard.",
  input: z.object({
    action: z.enum(["list", "speak", "conversation", "add", "remove"]).describe("What to do."),
    voice: z.string().max(60).optional().describe("speak, remove: a voice id or name from list."),
    sample: fileArg("add: a recording of the voice, 10–30 s of one person talking (sound or a clip).").optional(),
    name: z.string().max(40).optional().describe("add: the new voice's name."),
    says: z.string().max(2000).optional().describe("add: the sample's exact words. Left out, speech to text types them."),
    consent: z.boolean().optional().describe("add: true only after the user said the voice is theirs or its owner agreed."),
    text: z.string().max(4000).optional().describe("speak: what to say."),
    lines: z.array(z.object({ voice: z.string().max(60).describe("A voice id or name."), text: z.string().min(1).max(1500) })).min(2).max(40).optional().describe("conversation: who says what, in order."),
    direction: z.string().max(200).optional().describe('How it\'s said ("warm, unhurried", "an excited whisper").'),
    lively: z.number().int().min(0).max(2).optional().describe("0 steady, 1 natural (default), 2 lively."),
    speed: z.number().min(0.7).max(1.5).optional().describe("Default 1 (models with a speed setting)."),
    language: z.string().max(10).optional().describe('Language code ("en", "it"); default en.'),
    model: z.enum(modelIds).optional().describe("The voice model. Default: the first that's set up."),
    dry_run: z.boolean().optional(),
    confirm,
    wait: waitArg,
  }),
  files: ["sample"],
  async run(args, ctx) {
    const all = await allVoices().catch(() => [...READY_VOICES]);
    if (args.action === "add") return addFromSample(args, all, ctx);
    if (args.action === "remove") {
      if (!args.voice) throw fail("invalid_input", { field: "voice", what: 'remove needs "voice": its id or name.' });
      const v = await voiceOf(args.voice, all, "voice");
      if (!(await madeBy("voice", v.id))) throw fail("not_yours", { what: `${v.name} ${v.source === "ready" ? "is one of Crackio's voices" : "was added by the user, not by an agent"}: agents don't remove those.` });
      const token = removeToken(v.id);
      if (args.confirm !== token) throw fail("confirm_needed", { what: `Removing the voice ${v.name} can't be undone. Takes made with it stay in the Library.`, confirm: token });
      await removeVoice(v.id);
      await forgetMade("voice", v.id);
      return { data: { removed: v.name } };
    }
    if (args.action === "list") {
      const byAgents = await allMade("voice");
      const machines = await voiceMachines().catch(() => []);
      const models = VOICE_MODELS.map((m) => {
        const on = machines.filter((x) => x.online && x.models.includes(m.id)).map((x) => x.label);
        return { id: m.id, name: m.name, ...(on.length ? { on } : { ready: false }) };
      });
      return {
        data: {
          voices: all.map((v) => `${v.id} · ${v.name} · ${v.desc}${v.source === "ready" ? "" : byAgents[v.id] ? " · added by an agent" : ` · the user's (${v.source})`}`),
          models,
          ...(models.some((m) => "on" in m) ? {} : { note: "No voice model is on a machine that's online. The user sets Voice up in Crackio → Settings → Tools." }),
        },
      };
    }

    const said = args.action === "speak" ? [{ voice: args.voice ?? "", text: args.text ?? "" }] : (args.lines ?? []);
    if (args.action === "speak" && (!args.voice || !args.text?.trim())) throw fail("invalid_input", { field: args.voice ? "text" : "voice", what: 'speak needs "voice" and "text".' });
    if (args.action === "conversation" && said.length < 2) throw fail("invalid_input", { field: "lines", what: "A conversation needs at least two lines." });
    const cards = await Promise.all(said.map((l, i) => voiceOf(l.voice, all, args.action === "speak" ? "voice" : `lines.${i}.voice`)));
    const { model, machine, paid } = await speaker(args.model, ctx);
    const cast = [...new Set(cards.map((c) => c.id))];
    const ask: VoiceAsk = {
      model: model.id,
      direction: args.direction?.trim() ?? "",
      speed: args.speed ?? 1,
      lively: args.lively ?? 1,
      language: args.language ?? "en",
      ...(args.action === "speak" ? { voice: cards[0].id } : { cast, lines: said.map((l, i) => ({ speaker: cast.indexOf(cards[i].id), text: l.text.trim() })) }),
      who: cast.map((id) => {
        const c = cards.find((x) => x.id === id)!;
        return { name: c.name, hues: c.hues };
      }),
    };
    const words = args.action === "speak" ? said[0].text.trim() : said.map((l, i) => `${cards[i].name}: ${l.text.trim()}`).join("\n");
    const seconds = Math.max(10, Math.round(words.length / 6));
    // On a rented machine the take costs its share of the hour, said and agreed to like any paid job.
    const plan: Plan = {
      model: { id: model.id, name: model.name },
      machine: { id: machine.id, name: machine.label, gpu: machine.gpu },
      seconds,
      basis: "Voice's usual pace",
      ahead: 0,
      cost: paid ? await shareOfHour(machine, seconds, "this take") : { free: true },
    };
    const costWords = plan.cost.free ? "free" : plan.cost.text;
    if (args.dry_run) return { data: { dry_run: true, model: model.id, model_name: model.name, machine: machine.id, machine_name: machine.label, cost: costWords, about_seconds: seconds, voices: cast.map((id) => cards.find((c) => c.id === id)!.name) } };
    requireConfirm("voice", args, plan);
    const gen = await startJob({ tool: "voice", prompt: words, aspect: "1:1", count: 1, model: model.id, params: { kind: "voice", voice: ask } }, ctx.caller);
    return answerJob([gen.id], args.wait ?? 30, false, ctx, { started: { job: gen.id, model: model.id, machine: machine.label, cost: costWords }, notes: ["You can't hear it. Compare \"heard\" in the result with the script, and give the user the file to listen to."] });
  },
});
