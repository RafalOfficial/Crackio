import "server-only";
import { getGeneration, saveGeneration } from "./db";
import { saveOutputs, urlToPath } from "./media";
import { engineFor } from "@/lib/engines";
import { resolveModel } from "@/lib/models/resolve";
import type { ModelKind } from "@/lib/models/catalog";
import { EngineError, type EngineJob } from "@/lib/engines/types";
import type { Generation } from "@/lib/generations/types";
import { sizeFor } from "@/lib/shot";
import { runMotion } from "@/lib/motion/job";
import { keepOutside } from "./protect";
import { finishAtSize, withSourceSound } from "./clip";
import { dropPasteMask, takePasteMask } from "./paste-masks";
import { runRetouch } from "./retouch";
import { runProductShoot, type ProductShootResult } from "./product";
import { runProductFilm, type FilmResult } from "./product-film";
import type { RetouchSpec } from "@/lib/retouch/plan";
import type { StudioSpec } from "@/lib/product/vocab";
import type { FilmSpec } from "@/lib/product/film";
import { imageSlots } from "@/lib/models/caps";
import { briefInputs, canCompose, directorInputs, pictureSlots, runDirectorComp, runDirectorPlate } from "./director";
import { castClipJob, castImageJob, castOfJob, runCastImage, runCastView } from "./cast-refs";
import { outside, recording } from "./recipes";
import { inJob } from "./job-scope";

/**
 * In-process job queue. Crackio runs on your machine, so a small queue inside the server
 * is enough: jobs survive page reloads, not server restarts.
 *
 * Only the queue state lives on globalThis (so it survives hot reloads in dev); the logic
 * below is plain module code, so edits to engines apply to the next job immediately.
 */
type RunnerState = { queue: string[]; active: Map<string, AbortController>; run?: (id: string) => Promise<void> };
const g = globalThis as unknown as { __crackioRunnerState?: RunnerState };
const state: RunnerState = (g.__crackioRunnerState ??= { queue: [], active: new Map() });
// The newest code runs every job: a job that started before a hot reload still hands the next one on when it ends,
// and without this it would hand it to its own, older copy of this module.
state.run = run;
const CONCURRENCY = Number(process.env.CRACKIO_CONCURRENCY || 3);

/**
 * Jobs on your own GPUs and jobs on cloud models queue apart: three long local clips had every slot, and a Grok picture
 * waited behind them for minutes though it needs nothing from the GPU.
 */
function lane(id: string) {
  const gen = getGeneration(id);
  return gen?.engine === "comfy-local" || /^local:/.test(gen?.model ?? "") ? "local" : "cloud";
}

function pump() {
  const busy = { local: 0, cloud: 0 };
  for (const id of state.active.keys()) busy[lane(id)]++;
  for (let i = 0; i < state.queue.length; ) {
    const id = state.queue[i];
    const l = lane(id);
    if (busy[l] >= CONCURRENCY) {
      i++;
      continue;
    }
    busy[l]++;
    state.queue.splice(i, 1);
    // Every graph and request the job sends is kept with its take (server/recipes).
    // In the job's own scope too, so work deep inside it knows whose it is (server/job-scope).
    void recording(id, () => inJob(id, () => (state.run ?? run)(id)));
  }
}

async function run(id: string) {
  const ctrl = new AbortController();
  state.active.set(id, ctrl);
  let gen = getGeneration(id);
  if (!gen) {
    state.active.delete(id);
    return pump();
  }
  const update = (patch: Partial<Generation>) => {
    gen = { ...gen!, ...patch };
    saveGeneration(gen);
  };
  let lastWrite = 0;

  const progress = (value: number, stage?: string) => {
    const now = Date.now();
    if (now - lastWrite < 400) return;
    lastWrite = now;
    update({ progress: value, stage });
  };

  try {
    update({ status: "running", startedAt: Date.now(), progress: 0.01, stage: "Starting" });

    // Motion turns: the agent writes a composition, then it renders on this computer.
    if (gen.params?.kind === "motion") {
      const brain = await resolveModel("text", gen.model);
      update({ engine: brain.via!, model: brain.id, modelName: `Motion · ${brain.name}` });
      const result = await runMotion(gen, brain, { signal: ctrl.signal, progress });
      update({ stage: "Saving" });
      const outputs = await saveOutputs(id, result.outputs);
      update({ status: "done", outputs, compiledPrompt: result.usedPrompt, progress: 1, stage: undefined, finishedAt: Date.now() });
      return;
    }

    // Voice takes: speech from your script on your own GPU (server/voice).
    if (gen.params?.kind === "voice") {
      const { runVoice } = await import("./voice/run");
      const result = await runVoice(gen, { signal: ctrl.signal, progress });
      update({ engine: "comfy-local", model: result.model, modelName: result.modelName, params: { ...gen.params, heard: result.heard }, stage: "Saving" });
      const outputs = await saveOutputs(id, result.outputs);
      update({ status: "done", outputs, compiledPrompt: result.usedPrompt, progress: 1, stage: undefined, finishedAt: Date.now() });
      return;
    }

    // Lip Sync: a clip's words changed, and its mouth redrawn to say them only there (server/lipsync).
    if (gen.params?.kind === "lipsync") {
      const { runLipsync } = await import("./lipsync/run");
      const result = await runLipsync(gen, { signal: ctrl.signal, progress });
      update({ engine: "comfy-local", model: "local:lipsync:latentsync", modelName: result.modelName, params: { ...gen.params, lipsyncReport: result.report }, stage: "Saving" });
      const outputs = await saveOutputs(id, result.outputs);
      update({ status: "done", outputs, compiledPrompt: result.usedPrompt, progress: 1, stage: undefined, finishedAt: Date.now() });
      return;
    }

    const kind = (gen.params?.kind as ModelKind | undefined) ?? "image";
    const mode = kind === "video" ? "video" : "image";
    const def = await resolveModel(kind, gen.model);
    const engine = def.via ? engineFor(def.via) : null;
    if (!engine) throw new EngineError(`${def.name} has no engine connected.`, "Open Connections.");
    update({ engine: def.via!, model: def.id, modelName: def.name });

    // A shape of the tool's own, where its control picture has one the aspects don't (Angles: the photo's): the picture
    // takes it at the aspect's size, so the control isn't stretched and the take frames what the camera saw.
    const shape = typeof gen.params?.ratio === "number" && gen.params.ratio > 0 ? Math.min(3, Math.max(1 / 3, gen.params.ratio)) : null;
    const asked = sizeFor(gen.aspect);
    const long = Math.max(asked.width, asked.height);
    const snap = (n: number) => Math.max(256, Math.round(n / 16) * 16);
    const { width, height } = shape ? (shape >= 1 ? { width: snap(long), height: snap(long / shape) } : { width: snap(long * shape), height: snap(long) }) : asked;
    // A picture Crackio can't find would otherwise be skipped quietly, and an edit would come back as a new picture.
    const lost = gen.references.filter((r) => !urlToPath(r.url));
    if (lost.length) throw new EngineError(lost.length === 1 ? "Crackio can't find a picture you gave it." : `Crackio can't find ${lost.length} of the pictures you gave it.`, "Add it again.");
    const references = gen.references.map((r) => ({ path: urlToPath(r.url)!, label: r.label, role: r.role }));
    const pathParam = (key: string) => {
      const url = gen?.params?.[key];
      return typeof url === "string" ? urlToPath(url) : null;
    };
    const guidePath = pathParam("guideUrl");
    const depthPath = pathParam("depthUrl");
    const sourcePath = pathParam("videoUrl");
    const startPath = pathParam("startUrl");
    const endPath = pathParam("endUrl") ?? references.find((r) => /end frame/i.test(r.label ?? ""))?.path ?? null;
    const layout = Array.isArray(gen.params?.layout) ? (gen.params.layout as EngineJob["layout"]) : undefined;
    // Keyframes between the start and end frames: a picture and when the clip passes through it.
    const keyframes = Array.isArray(gen.params?.keyframes)
      ? (gen.params.keyframes as { url?: unknown; t?: unknown }[]).flatMap((k) => {
          const p = typeof k.url === "string" ? urlToPath(k.url) : null;
          return p && typeof k.t === "number" && Number.isFinite(k.t) ? [{ path: p, t: k.t, label: `the keyframe at ${k.t.toFixed(1)} s` }] : [];
        })
      : undefined;
    // Pictures of who and what a clip shows, sent next to its start frame (Storyboard's cast and props).
    const refImages = Array.isArray(gen.params?.refs)
      ? (gen.params.refs as { url?: unknown; label?: unknown }[]).flatMap((r) => {
          const p = typeof r.url === "string" ? urlToPath(r.url) : null;
          return p ? [{ path: p, label: typeof r.label === "string" ? r.label : undefined }] : [];
        })
      : undefined;

    // Director: the blocking frame, each subject's own picture and a prompt written for exactly those, fitted to this model.
    const slots = pictureSlots(def);
    const director = kind === "image" ? ((await briefInputs(gen, slots)) ?? (await directorInputs(gen, slots))) : null;
    // A composed shot: each subject drawn from the camera's angle, set where it stands, then blended (server/director).
    const composing = kind === "image" && Boolean(director) && canCompose(gen, slots);
    // A plate shot: the real place from this camera, the stand-ins on it swapped for the cast in one edit (server/director).
    // The ControlNet shot (Z-Image Director) takes no pictures: the depth and the words are its whole brief.
    const plating = kind === "image" && gen.params?.director === 4 && (slots >= 1 || gen.params?.cast === "control");

    const job: EngineJob = {
      kind,
      model: def.model,
      via: def.via ?? undefined,
      family: def.family,
      caps: def.caps ?? undefined,
      options: (gen.params?.options as EngineJob["options"]) ?? undefined,
      prompt: director?.prompt ?? gen.compiledPrompt ?? gen.prompt,
      userPrompt: gen.prompt,
      refine: Boolean(gen.params?.refine ?? true) && !gen.compiledPrompt,
      aspect: gen.aspect,
      width,
      height,
      count: gen.count,
      references: director?.references ?? references,
      guide: guidePath && !director ? { path: guidePath, role: "guide" } : undefined,
      depth: depthPath ? { path: depthPath, role: "depth" } : undefined,
      source: sourcePath ? { path: sourcePath, role: "source" } : undefined,
      start: kind === "video" && startPath ? { path: startPath, label: "the start frame" } : undefined,
      end: kind === "video" && endPath ? { path: endPath, label: "the end frame" } : undefined,
      keyframes: kind === "video" && keyframes?.length ? keyframes : undefined,
      refImages: kind === "video" && refImages?.length ? refImages : undefined,
      layout,
      mode,
    };

    // Cast: "@mia" in a plain picture or clip brings Mia's sheet and face the way this model takes pictures, or draws the
    // clip's first frame with her (server/cast-refs). Tools with their own way of using the cast keep it.
    const cast = !director && !gen.params?.director && !gen.params?.retouch && !gen.params?.studio && !gen.params?.film && !job.source ? castOfJob(gen) : [];
    let castJob = job;
    if (cast.length && kind === "image") castJob = await castImageJob(job, gen, def, cast, { signal: ctrl.signal, progress });
    if (cast.length && kind === "video") {
      const withCast = await castClipJob(job, gen, def, cast, { signal: ctrl.signal, progress });
      castJob = withCast.job;
      if (withCast.startUrl) update({ params: { ...gen.params, startUrl: withCast.startUrl, castFrame: withCast.frameModel, ...(withCast.frameNote ? { castFrameNote: withCast.frameNote } : {}) } });
    }
    // What the cast went in as, for the take's details.
    if (castJob !== job) {
      const sent = kind === "video" ? (castJob.refImages ?? []).slice(job.refImages?.length ?? 0) : castJob.references.slice(job.references.length);
      update({ params: { ...gen.params, castSent: sent.map((r) => r.label ?? "a picture") } });
    }

    // Retouch makes its changes up close, one crop at a time, and blends them back itself.
    const retouch = gen.params?.retouch as RetouchSpec | undefined;
    const original = pathParam("sourceUrl");
    // Product Studio reads the product, gives every take its own idea, then shoots them all.
    const studio = gen.params?.studio as StudioSpec | undefined;
    // Product Studio's Video mode directs, films, checks and cuts a take from a picture.
    const film = gen.params?.film as FilmSpec | undefined;
    let shoot: ProductShootResult | null = null;
    let filmed: FilmResult | null = null;
    let composed: Awaited<ReturnType<typeof runDirectorComp>> | null = null;
    let plated: Awaited<ReturnType<typeof runDirectorPlate>> | null = null;
    // The Director's video mode: the video you dropped, filmed again along your Camera path (server/director-video).
    let reshot: { layoutUrl?: string; lookUrl?: string } | null = null;
    const result =
      kind === "image" && retouch?.version === 2 && original
        ? await runRetouch(job, retouch, original, engine, { signal: ctrl.signal, progress })
        : kind === "image" && studio?.version === 2
          ? (shoot = await runProductShoot(job, studio, engine, { signal: ctrl.signal, progress }, { notes: studio.noted ? gen.prompt : "", seesImages: def.caps ? imageSlots(def.caps) > 0 : def.maxRefs > 0 }))
          : kind === "video" && film?.version === 1
            ? (filmed = await runProductFilm(job, film, engine, def, { signal: ctrl.signal, progress }, { notes: film.noted ? gen.prompt : "" }))
            : kind === "video" && (gen.params?.reshoot as { version?: number } | undefined)?.version === 1
              ? (reshot = await (await import("./director-video")).runDirectorVideo(job, gen, engine, { signal: ctrl.signal, progress }))
            : plating
              ? (plated =
                  gen.params?.cast === "control"
                    ? await (await import("./director-fresh")).runDirectorControl(job, gen, engine, { signal: ctrl.signal, progress })
                    : gen.params?.cast === "fresh"
                    ? await (await import("./director-fresh")).runDirectorFresh(job, gen, engine, { signal: ctrl.signal, progress })
                    : gen.params?.cast === "real" && (gen.params?.comp as { lookUrl?: string } | undefined)?.lookUrl
                      ? await (await import("./director-real")).runDirectorReal(job, gen, engine, { signal: ctrl.signal, progress })
                      : await runDirectorPlate(job, gen, engine, { signal: ctrl.signal, progress }, slots))
              : composing
              ? (composed = await runDirectorComp(job, gen, engine, { signal: ctrl.signal, progress }))
              : cast.length && kind === "image"
                ? await runCastImage(castJob, gen, cast, engine, { signal: ctrl.signal, progress })
                : gen.tool === "cast" && (gen.params?.cast as { part?: string }[] | undefined)?.[0]?.part === "view"
                  ? await runCastView(castJob, gen, engine, { signal: ctrl.signal, progress })
                  : await engine.run(castJob, { signal: ctrl.signal, progress });
    // Each take's idea (and the reading, when the page didn't have it yet) go with the take.
    if (composed) update({ params: { ...gen.params, compUrl: composed.compUrl, views: composed.views } });
    if (plated) update({ params: { ...gen.params, filledPlateUrl: plated.plateUrl, compUrl: plated.swapUrl } });
    if (shoot) update({ params: { ...gen.params, shots: shoot.shots, ...(shoot.read && !studio?.read ? { studio: { ...studio, read: shoot.read } } : {}) } });
    if (reshot) update({ params: { ...gen.params, ...(reshot.layoutUrl ? { layoutUrl: reshot.layoutUrl } : {}), ...(reshot.lookUrl ? { lookUrl: reshot.lookUrl } : {}) } });
    if (filmed) update({ params: { ...gen.params, clips: filmed.plans, idea: filmed.idea, ...(filmed.startUrl ? { startUrl: filmed.startUrl, staged: true } : {}), ...(filmed.read && !film?.read ? { film: { ...film, read: filmed.read } } : {}) } });

    // Takes from before Retouch made changes up close: the original's pixels outside the changes.
    const protect = gen.params?.protect as { boxes?: [number, number, number, number][] } | undefined;
    if (kind === "image" && retouch?.version !== 2 && protect?.boxes?.length && original) {
      update({ stage: "Keeping the rest as it was" });
      result.outputs = await outside("The picture outside your changes put back as it was", "sharp", () => keepOutside(original, result.outputs, protect.boxes!));
    }

    // Ripple made the swapped people inside a 720p copy of a bigger clip: they're laid onto the clip at its own size, so
    // everything around them keeps the clip's own sharpness (clip.finishAtSize).
    const pasted = kind === "video" && sourcePath ? takePasteMask(sourcePath) : null;
    if (pasted) {
      const big = pathParam("finishUrl");
      try {
        if (big) {
          update({ stage: "Laying the swap onto the clip at its own size" });
          result.outputs = await outside("The swap laid onto the clip at its own size", "ffmpeg", () => Promise.all(result.outputs.map((o) => (o.mime.startsWith("video/") ? finishAtSize(o, big, pasted) : o))));
        }
      } finally {
        await dropPasteMask(pasted);
      }
    }

    // Template swaps keep the clip's own sound exactly, cut back to the clip's length when it was padded for the model.
    if ((gen.tool === "templates" || gen.params?.keepSound === true) && kind === "video" && sourcePath) {
      update({ stage: "Laying the original sound back" });
      const padded = typeof gen.params?.padded === "number" && gen.params.padded > 0;
      const length = padded && typeof gen.params?.length === "number" ? gen.params.length : undefined;
      result.outputs = await outside("The clip's own sound laid back", "ffmpeg", () => Promise.all(result.outputs.map((o) => withSourceSound(o, sourcePath, length))));
    }

    update({ stage: "Saving" });
    const outputs = await saveOutputs(id, result.outputs);
    update({
      status: "done",
      outputs,
      compiledPrompt: result.usedPrompt || job.prompt,
      progress: 1,
      stage: undefined,
      finishedAt: Date.now(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    update({
      status: "error",
      error: ctrl.signal.aborted ? "Cancelled." : message,
      stage: err instanceof EngineError ? err.hint : undefined,
      finishedAt: Date.now(),
    });
  } finally {
    state.active.delete(id);
    pump();
  }
}

export function runner() {
  return {
    enqueue(id: string) {
      state.queue.push(id);
      pump();
    },
    cancel(id: string) {
      const active = state.active.get(id);
      if (active) return active.abort();
      state.queue = state.queue.filter((q) => q !== id);
      const gen = getGeneration(id);
      if (gen && (gen.status === "queued" || gen.status === "running")) {
        saveGeneration({ ...gen, status: "error", error: "Cancelled.", stage: undefined, finishedAt: Date.now() });
      }
    },
  };
}
