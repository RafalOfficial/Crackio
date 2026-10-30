# Crackio ComfyUI worker for RunPod Serverless

ComfyUI v0.42.1 on CUDA 12.8 PyTorch, plus a handler that runs one ComfyUI API-format graph per job. Crackio sends the same graphs it runs on your own ComfyUI (see `workflows/runs/` in the Crackio repo). Setup, costs and how Crackio drives it are in Crackio's `docs/SERVERLESS.md`.

## Job input

```jsonc
// run (the default action): one graph
{ "graph": { "1": { "class_type": "UNETLoader", "inputs": { … } }, … },
  "prompt_id": "…",                                                  // optional
  "inputs":  [ { "name": "crackio/in-abc.png", "url": "https://…" },  // or "b64": "…"
               … ],
  "outputs": [ "https://…presigned PUT…", … ] }                       // one per output file, in order

// list: what this worker holds
{ "action": "list" }

// fetch: model files into the network volume (HF_TOKEN for gated Hugging Face repos)
{ "action": "fetch", "files": [ { "url": "https://huggingface.co/…/resolve/main/…", "folder": "diffusion_models", "name": "….safetensors", "bytes": 123 } ] }
```

A `run` answers with ComfyUI's own history for the job (`status.messages`, `outputs`), plus:

- `files_out`: each output file, with the upload slot it went to, or base64 when there was no slot left.
- `gpu`, `comfyui`, `warm` (whether ComfyUI was already up), and `files` (what the volume holds).

Step progress goes out with `progress_update` as JSON (`{node, value, max}`).

## Models

Models live on the endpoint's network volume, under `/runpod-volume/models/<folder>` (see `extra_model_paths.yaml`). They're filled once by `fetch` jobs, so they aren't in the image: the image stays around 10 GB, and every endpoint built from it can hold its own model set.

## Environment

| Variable | What |
| --- | --- |
| `HF_TOKEN` | Hugging Face read token, used only by `fetch`, for gated repos (FLUX 3 Klein, LTX-2.5) |
| `MODELS_DIR` | Defaults to `/runpod-volume/models` |
