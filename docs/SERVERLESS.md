# Crackio on RunPod Serverless

Run every Crackio tool on GPUs that start when a job comes in and stop when there's none (scale to zero), billed by the second. It's the same ComfyUI graphs Crackio runs on your own GPU, the ones in `workflows/runs/`, on Crackio's ComfyUI worker on RunPod.

## How it works

```
Crackio ──ComfyUI API──▶ shim (127.0.0.2, this computer) ──/run, /status──▶ RunPod endpoint ──▶ worker: ComfyUI v0.42.1
           (unchanged)          │   inputs and results by signed links         ▲   models on a network volume
                                └──────────────▶ Cloudflare R2 ◀────────────────┘
```

- **The shim** (`src/lib/server/serverless/shim.ts`) makes an endpoint look like one more ComfyUI. It speaks the part of ComfyUI's HTTP API Crackio already uses (`/prompt`, `/queue`, `/history`, `/upload/image`, `/view`, `/object_info`, `/models`, `/system_stats`, `/ws` for progress), and each graph Crackio queues becomes one RunPod job. Every tool works unchanged, including multi-step ones (a Swap is five jobs: SAM 3.1, three redraws, the clip), and so do recipes and the Library. Crackio's own ComfyUI paths aren't touched.
- **The worker** (`serverless/worker`) is ComfyUI v0.42.1 on PyTorch 2.10 with CUDA 13.0, the same as Crackio's RTX 5090 test box. It uses CUDA 13 because ComfyUI's int8 kernels (comfy-kitchen) link cuBLASLt 13, and the int8 LTX-2.5 and Gemma models need them for their fast path. Its handler has three actions: `run` (one graph), `list` (what it holds: model files, node classes, GPU) and `fetch` (model files into the volume, once).
- **Files** move through Cloudflare R2 by presigned links that Crackio signs, so the worker never holds a key. Without R2, small pictures travel inside the job (RunPod's limit is 10 MB), which is enough for pictures but not for clips.
- **Billing**: each step of a take's recipe keeps RunPod's `executionTime` and `delayTime` in milliseconds, as `/status` reports them.
- **Never by accident**: Auto never picks an endpoint. A job runs there only when you pick it under Run on (or set it as the default machine). The shim listens on loopback only, and the ComfyUI page never relays it.

## Set it up

### 1. Cloudflare R2 (for clips and swaps)

1. R2 → **Create bucket**, e.g. `my-crackio-jobs`.
2. The bucket → Settings → **Object lifecycle rules** → delete objects 1 day after upload.
3. R2 → **Manage API tokens** → Create a token with **Object Read & Write**, scoped to that bucket.
4. Add these to Crackio's `.env.local`:

```sh
R2_ENDPOINT=https://<account id>.r2.cloudflarestorage.com
R2_BUCKET=my-crackio-jobs
R2_ACCESS_KEY_ID=…
R2_SECRET_ACCESS_KEY=…
```

### 2. The worker image

RunPod builds it from a GitHub repo holding `serverless/worker` (Dockerfile, handler.py, extra_model_paths.yaml). Connect GitHub in RunPod (Settings → Connections), then publish a **release** of the repo: RunPod builds on releases, not pushes. You don't need Docker on your computer.

### 3. Storage for models

Create a **Network Volume** (Storage → New Network Volume) of about 120 GB, in a data center that has the GPUs you want. Crackio's set (LTX-2.5 with its encoder and IC-LoRAs, Qwen-Image 2.1, FLUX 3 Klein, SAM 3.1, Nomos2, Real-ESRGAN) is about 85 GB. It costs $0.07 per GB per month.

RunPod's cached models would avoid the volume, but they hold one Hugging Face repo per endpoint, and every file in it. These models come from about eight repos.

### 4. The endpoint

Serverless → **New Endpoint** → your GitHub repo:

| Setting | Value |
| --- | --- |
| GPUs (in order) | 32 GB PRO (RTX 5090), 48 GB PRO, 48 GB. The 5090 is about 2–2.5× faster, so it's also cheaper per job. LTX-2.5 int8 with Gemma runs in its 32 GB because ComfyUI moves weights between the GPU and RAM. |
| CUDA version | 13.0 and newer (driver 580+) |
| Active workers | 0 |
| Max workers | 1 (2 for a public demo) |
| Idle timeout | 30 s, so a Swap's steps and back-to-back jobs stay warm |
| Execution timeout | 1200 s (Crackio raises it per job for clips) |
| FlashBoot | on |
| Network volume | the one above |
| Environment | `HF_TOKEN` (a Hugging Face read token that has accepted the FLUX 3 Klein and LTX-2.5 licences), as a secret |

### 5. Crackio

- **Your own Crackio:** Connections → GPUs and open models → add your **RunPod** key. Then Connections → **RunPod Serverless** → paste the endpoint id.
- **A hosted Crackio:** set `RUNPOD_API_KEY` and `RUNPOD_ENDPOINT_ID` (and optionally `RUNPOD_LABEL`) in its environment.

The endpoint then appears among your machines. To fill its volume, use **Local** → pick the endpoint → **Install** on each model. One `fetch` job downloads the files, and its model list updates when it's done. You can also do it from this computer with:

```sh
curl -X POST http://127.0.0.1:3210/api/serverless -H "Content-Type: application/json" \
  -d '{"endpointId":"<id>","action":"fetch","names":["flux3-image-klein-int8-convrot.safetensors","qwen3vl_4b_int8_convrot.safetensors","flux2-vae.safetensors"]}'
```

Then pick it under **Run on** for a job, or as the default machine.

## Costs

RunPod's serverless prices, October 2026, per second while a worker runs:

| GPU | $/s | $/h |
| --- | --- | --- |
| 48 GB (A6000, A40) | 0.000339 | 1.22 |
| 48 GB PRO (L40S, 6000 Ada) | 0.000486 | 1.75 |
| 32 GB PRO (RTX 5090) | 0.000497 | 1.79 |

A warm Draft picture takes seconds of GPU time. A cold start adds loading the model from the volume: about 10–30 s for an image model and about a minute for LTX-2.5. The idle timeout is billed too. The volume costs about $0.28 a day.

## Testing without RunPod

The worker runs under RunPod's own test server against any ComfyUI:

```sh
python -m venv rp && rp/Scripts/pip install runpod websocket-client requests
python local_worker.py --rp_serve_api --rp_api_port 8765   # imports serverless/worker/handler.py, HOST = your ComfyUI
RUNPOD_ENDPOINT_ID=localtest RUNPOD_API_KEY=local RUNPOD_API_BASE=http://127.0.0.1:8765 pnpm dev -p 3212
```

`RUNPOD_API_BASE` points Crackio's RunPod client at that server: its routes sit at the root, `/status` is a POST, and it has no `/health`.
