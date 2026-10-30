# Local model bench

Runs Local models through Crackio's own API (dev server on :3210) on the connected ComfyUIs and records real times
(Crackio files them in `data/local-speeds.json`, warm and cold apart; the Local page shows them as "Measured here").

- `node bench.mjs plan.json`: for each model in the plan, install its variant on the main ComfyUI, generate (pictures
  twice: cold, then warm), record, remove. Kept models are never removed; `evictable` ones are set aside when a big
  model needs the room and installed again at the end. Writes `results.json` and `bench.log` next to the script.
- `node one.mjs <model> <machine|-> <aspect> <repeat> "<prompt>" [refUrl]`: one job, optionally pinned to a machine
  (`this-computer`, `main`, or an added machine's id).
- `python sheet.py out.jpg [model ...]`: contact sheet of the bench's pictures.
