// One generation through Crackio, waited for. node one.mjs <model> <machine|-> <aspect> <repeat> "<prompt>" [referenceUrl]
const [model, machine, aspect, repeat, prompt, ref] = process.argv.slice(2);
const BASE = "http://localhost:3210";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < Number(repeat || 1); i++) {
  const started = Date.now();
  const body = {
    tool: "image",
    prompt,
    aspect,
    count: 1,
    model,
    refine: false,
    references: ref ? [{ url: ref, label: "the picture to change", role: "edit-target" }] : [],
    params: { kind: "image", options: machine && machine !== "-" ? { machine } : {} },
  };
  const res = await (await fetch(`${BASE}/api/generations`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
  const id = res.item?.id;
  if (!id) {
    console.log("no id", JSON.stringify(res).slice(0, 300));
    process.exit(1);
  }
  for (;;) {
    await sleep(3000);
    const g = (await (await fetch(`${BASE}/api/generations?ids=${id}`)).json()).items?.[0];
    if (g?.status === "done" || g?.status === "error") {
      console.log(`${model} #${i + 1}: ${g.status} in ${Math.round((Date.now() - started) / 1000)} s ${g.error ?? ""} ${g.outputs.map((o) => o.url).join(" ")}`);
      break;
    }
  }
}
