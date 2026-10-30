// Benchmarks Local models on the connected ComfyUI (the 5090 box) through Crackio's own API:
// install the variant → generate (twice for images: cold, then warm) → record → remove (unless kept).
// Usage: node bench.mjs plan.json   (writes results.json + bench.log next to this file)
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.CRACKIO ?? "http://localhost:3210";
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1"));
const plan = JSON.parse(fs.readFileSync(process.argv[2] ?? path.join(HERE, "plan.json"), "utf8"));
const RESULTS = path.join(HERE, "results.json");
const LOG = path.join(HERE, "bench.log");
const results = fs.existsSync(RESULTS) ? JSON.parse(fs.readFileSync(RESULTS, "utf8")) : {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => {
  const line = `[${new Date().toLocaleTimeString()}] ${a.join(" ")}`;
  console.log(line);
  fs.appendFileSync(LOG, line + "\n");
};
const save = () => fs.writeFileSync(RESULTS, JSON.stringify(results, null, 2));

async function api(route, body) {
  for (let i = 0; i < 5; i++) {
    try {
      const res = await fetch(BASE + route, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : { cache: "no-store" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) return { error: json.error ?? `HTTP ${res.status}`, status: res.status };
      return json;
    } catch (err) {
      await sleep(3000);
      if (i === 4) return { error: String(err) };
    }
  }
}

const catalog = (await api("/api/local/catalog")).models;
const gb = (b) => (b / 1024 ** 3).toFixed(1);

async function status() {
  return api("/api/local");
}

function variantOf(model, id) {
  return (id && model.variants.find((v) => v.id === id)) || model.variants[0];
}

async function waitInstalled(model, variant) {
  const start = Date.now();
  let last = "";
  for (;;) {
    const s = await status();
    const have = new Set(s.installed ?? []);
    const missing = variant.files.filter((f) => !have.has(`${f.folder}/${f.name}`));
    if (!missing.length) return { ok: true, seconds: (Date.now() - start) / 1000 };
    if (!s.installed) { await sleep(4000); continue; }
    const mine = (s.downloads ?? []).filter((d) => variant.files.some((f) => f.folder === d.folder && f.name === d.filename));
    const failed = mine.find((d) => d.state === "error");
    if (failed) return { ok: false, error: `${failed.filename}: ${failed.error}` };
    const active = mine.filter((d) => ["queued", "downloading", "checking"].includes(d.state));
    const got = mine.reduce((n, d) => n + d.received, 0);
    const line = `${active.length} downloading, ${gb(got)} GB`;
    if (line !== last && Date.now() % 4 === 0) log("   ", model.id, line);
    last = line;
    if (!active.length && Date.now() - start > 60_000) {
      // Finished but the installed list (cached 20 s) hasn't caught up, or nothing started.
      if (Date.now() - start > 180_000) return { ok: false, error: `never finished: missing ${missing.map((f) => f.name).join(", ")}` };
    }
    if (Date.now() - start > 90 * 60_000) return { ok: false, error: "install timed out" };
    await sleep(4000);
  }
}

async function runJob(model, job) {
  const body = {
    tool: job.tool,
    prompt: job.prompt ?? "",
    compiledPrompt: job.compiledPrompt,
    aspect: job.aspect ?? "16:9",
    count: 1,
    model: model.crackio,
    refine: job.refine ?? false,
    references: job.references ?? [],
    params: job.params ?? {},
  };
  const started = Date.now();
  const res = await api("/api/generations", body);
  if (res.error) return { ok: false, error: res.error };
  const id = res.item?.id ?? res.id ?? res.generation?.id;
  if (!id) return { ok: false, error: `no id in ${JSON.stringify(res).slice(0, 200)}` };
  for (;;) {
    await sleep(3000);
    const g = (await api(`/api/generations?ids=${id}`)).items?.[0];
    if (!g) continue;
    if (g.status === "done") return { ok: true, id, wall: (Date.now() - started) / 1000, outputs: g.outputs.map((o) => o.url), modelName: g.modelName };
    if (g.status === "error") return { ok: false, id, wall: (Date.now() - started) / 1000, error: g.error };
    if (Date.now() - started > (job.timeoutMin ?? 40) * 60_000) {
      await api(`/api/generations/${id}/cancel`, {});
      return { ok: false, id, error: "timed out" };
    }
  }
}

async function freeUp(needGb, keep, current) {
  // Remove earlier bench installs (never the kept ones) until there's room.
  const s = await status();
  const box = (s.machines ?? []).find((m) => m.where === "comfyui" && (m.target ?? "main") === "main");
  let free = box?.diskFreeGb ?? 0;
  if (free > needGb + 3) return free;
  for (const [id, r] of Object.entries(results)) {
    if (id.startsWith("__")) continue;
    if (free > needGb + 3) break;
    if (id === current || keep.includes(id) || !r.installedByBench || r.removed || !r.done) continue;
    const res = await api("/api/local", { action: "remove", model: id, variant: r.variant });
    log("  freed", id, res.error ? `(failed: ${res.error})` : "");
    r.removed = !res.error;
    save();
    await sleep(25_000);
    free = (await status()).machines.find((m) => m.where === "comfyui")?.diskFreeGb ?? free;
  }
  // Still short: set big kept models aside until the end, when they're installed again.
  for (const id of plan.evictable ?? []) {
    if (free > needGb + 3) break;
    if (results.__evicted?.[id]) continue;
    const m = catalog.find((x) => x.id === id);
    const have = new Set((await status()).installed ?? []);
    const v = m?.variants.find((x) => x.files.every((f) => have.has(`${f.folder}/${f.name}`)));
    if (!v) continue;
    const res = await api("/api/local", { action: "remove", model: id, variant: v.id });
    log("  set aside", id, res.error ? `(failed: ${res.error})` : "");
    if (res.error) continue;
    (results.__evicted ??= {})[id] = v.id;
    save();
    await sleep(25_000);
    free = (await status()).machines.find((m) => m.where === "comfyui")?.diskFreeGb ?? free;
  }
  return free;
}

for (const step of plan.models) {
  const model = catalog.find((m) => m.id === step.model);
  if (!model) {
    log("skip, unknown", step.model);
    continue;
  }
  if (results[model.id]?.done && !step.again) {
    log("skip, done", model.id);
    continue;
  }
  const variant = variantOf(model, step.variant);
  const s = await status();
  const have = new Set(s.installed);
  const missing = variant.files.filter((f) => !have.has(`${f.folder}/${f.name}`));
  // Files already on their way take their room as they come.
  const busy = (s.downloads ?? []).filter((d) => ["queued", "downloading", "checking"].includes(d.state));
  const toFetch = missing.filter((f) => !busy.some((d) => d.folder === f.folder && d.filename === f.name));
  const needGb = toFetch.reduce((n, f) => n + f.bytes, 0) / 1024 ** 3;
  const before = results[model.id];
  const r = (results[model.id] = { name: model.name, variant: variant.id, needGb: Number(needGb.toFixed(1)), runs: [], installedByBench: missing.length > 0 || Boolean(before?.installedByBench && !before?.removed), ...(before?.runs?.length ? { earlier: before.runs } : {}) });
  save();
  log(`== ${model.name} (${variant.id}) · ${gb(missing.reduce((n, f) => n + f.bytes, 0))} GB to fetch`);
  if (missing.length) {
    const free = toFetch.length ? await freeUp(needGb, plan.keep ?? [], model.id) : Infinity;
    if (free < needGb + 2) {
      r.error = `no room: needs ${needGb.toFixed(1)} GB, ${free} GB free`;
      log("  ", r.error);
      save();
      continue;
    }
    const inst = await api("/api/local", { action: "install", model: model.id, variant: variant.id });
    if (inst.error) {
      r.error = `install: ${inst.error}`;
      log("  ", r.error);
      save();
      continue;
    }
    const done = await waitInstalled(model, variant);
    r.installSeconds = done.seconds;
    if (!done.ok) {
      r.error = `install: ${done.error}`;
      log("  ", r.error);
      save();
      continue;
    }
    log(`   installed in ${Math.round(done.seconds)} s (${(needGb / Math.max(1, done.seconds)).toFixed(2)} GB/s)`);
    // The model pickers see installs on their next look.
    await sleep(22_000);
  }
  const jobs = plan.jobs[step.kind] ?? [];
  for (const job of jobs) {
    for (let i = 0; i < (job.repeat ?? 1); i++) {
      const run = await runJob(model, job);
      r.runs.push({ job: job.name, ...run });
      log(`   ${job.name}#${i + 1}:`, run.ok ? `ok in ${Math.round(run.wall)} s → ${run.outputs?.[0]}` : `FAILED ${run.error}`);
      save();
      if (!run.ok) break;
    }
  }
  const after = await status();
  r.measured = after.measured?.[model.crackio.replace(/^local:/, "")] ?? null;
  r.done = true;
  save();
  if (step.remove && r.installedByBench) {
    const res = await api("/api/local", { action: "remove", model: model.id, variant: variant.id });
    r.removed = !res.error;
    log("   removed", res.error ?? "");
    save();
  }
}
// Put back what was set aside.
for (const [id, variantId] of Object.entries(results.__evicted ?? {})) {
  const model = catalog.find((m) => m.id === id);
  if (!model) continue;
  await freeUp(model.variants.find((v) => v.id === variantId).files.reduce((n, f) => n + f.bytes, 0) / 1024 ** 3, [...(plan.keep ?? []), ...Object.keys(results.__evicted)], id);
  const res = await api("/api/local", { action: "install", model: id, variant: variantId });
  log("reinstalling", id, res.error ?? "");
  if (!res.error) {
    const done = await waitInstalled(model, model.variants.find((v) => v.id === variantId));
    log("  back:", id, done.ok ? `in ${Math.round(done.seconds)} s` : done.error);
    if (done.ok) delete results.__evicted[id];
    save();
  }
}
log("bench finished");
