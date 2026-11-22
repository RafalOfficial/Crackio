# Crackio on RunPod Serverless

Run every Crackio tool on GPUs that start when a job comes in and stop when there's none (scale to zero), billed by the second. It's the same ComfyUI graphs Crackio runs on your own GPU, the ones in `workflows/runs/`, on Crackio's ComfyUI worker on RunPod.

## How it works

```
Crackio ──ComfyUI API──▶ shim (127.0.0.2, this computer) ──/run, /status──▶ RunPod endpoint ──▶ worker: ComfyUI v0.44.0
           (unchanged)          │   inputs and results by signed links         ▲   models on a network volume
                                └──────────────▶ Cloudflare R2 ◀────────────────┘
```

- **The shim** (`src/lib/server/serverless/shim.ts`) makes an endpoint look like one more ComfyUI. It speaks the part of ComfyUI's HTTP API Crackio already uses (`/prompt`, `/queue`, `/history`, `/upload/image`, `/view`, `/object_info`, `/models`, `/system_stats`, `/ws` for progress), and each graph Crackio queues becomes one RunPod job. Every tool works unchanged, including multi-step ones (a Swap is five jobs: SAM 3.1, three redraws, the clip), and so do recipes and the Library. Crackio's own ComfyUI paths aren't touched.
- **The worker** (`serverless/worker`) is ComfyUI v0.44.0 on PyTorch 2.10 with CUDA 13.0, the same as Crackio's RTX 5090 test box. It uses CUDA 13 because ComfyUI's int8 kernels (comfy-kitchen) link cuBLASLt 13, and the int8 LTX-2.5 and Gemma models need them for their fast path. It also has nomadoor's ComfyUI-Panorama-Stickers node, pinned, for the Director's 3D World workflow (moved-camera shots). Its handler has four actions: `run` (one graph), `list` (what it holds: model files, node classes, GPU), `fetch` (model files into the volume, once) and `delete` (model files off the volume).
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

Create a **Network Volume** (Storage → New Network Volume) of about 125 GB, in a data center that has the GPUs you want. Crackio's set is about 91 GB: LTX-2.5 int8 with its encoder, upscaler and LoRAs, Qwen-Image 2.1 (full and Turbo) with the Director's AnyAngle, camera-angle and 360 panorama LoRAs and MoGe-3, FLUX 3 Klein, SeedVR2 7B, SAM 3.1, Nomos2 and Real-ESRGAN. That leaves about 10 GB for more LTX LoRAs and 24 GB spare. It costs $0.07 per GB per month (125 GB: $8.75). A volume can grow but never shrink.

RunPod's cached models would avoid the volume, but they hold one Hugging Face repo per endpoint, and every file in it. These models come from about eight repos.

### 4. The endpoint

Serverless → **New Endpoint** → your GitHub repo:

| Setting | Value |
| --- | --- |
| GPUs (in order) | 32 GB PRO (RTX 5090), then 24 GB PRO (RTX 4090). The 5090 is the fastest per dollar. LTX-2.5 int8 with Gemma runs in its 32 GB because ComfyUI moves weights between the GPU and RAM. Always keep a second GPU type: in November 2026, EU-RO-1 had no serverless 5090 free for hours, and with the 5090 alone a job waited with no worker at all. |
| CUDA version | 13.0 and newer (driver 580+) |
| Active workers | 0 |
| Max workers | 1 (2 for a public demo) |
| Idle timeout | 60 s, so Director shots a minute apart and a Swap's steps stay warm (a cold start costs about as much as a minute of waiting) |
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

In November 2026, RunPod billed the endpoint's RTX 4090 workers at $0.89/h (each worker's `costPerHr`).

A warm Draft picture takes seconds of GPU time. A cold start adds loading the model from the volume: about 10–30 s for an image model and about a minute for LTX-2.5. The idle timeout is billed too. The volume costs about $0.29 a day (125 GB).

Measured on a 4090 (2026-11-13), for a Director shot from a moved camera (the 3D World workflow: MoGe-3, Panorama Studio, Qwen-Image 2.1 with AnyAngle at 25 steps, 2208×960):

| | GPU time | The whole shot | Cost |
| --- | --- | --- | --- |
| Warm worker | 29 s | 36–40 s | about $0.01 |
| Cold worker (models loaded from the volume) | 87–92 s | 110–120 s | about $0.03 |
| A40 pod, for comparison | 75 s | 123 s | – |

With FlashBoot, a worker that stopped a little earlier often comes back with its models still loaded: such a shot took 40 s.

A worker that has stopped gives its GPU back. RTX 4090s in EU-RO-1 run short ("Low" stock), so the next job can wait for a free one: 94 s and 129 s before a shot began on 2026-11-13 (RunPod's health then says `throttled`).

### Kept ready while you work

While you work in the Director (a click, a drag, a key or the wheel in the last 30 s, the page in view) and Run on is the endpoint, Crackio keeps its worker from stopping (`POST /api/serverless/warm`, server/serverless/shim `keepWarm`): in the worker's idle minute it sends a `list` job, which runs no ComfyUI prompt, so the models stay loaded. Those pings expire after 30 s in line, so they never start a GPU later on. A new place also loads the moved-camera shot's models while you frame it (`studioWarmGraph`: the same loaders, one step at 256²). That job waits at most 5 minutes for a GPU.

It bills the worker's time while you work, and stops about 1.5 minutes after your last action: the last ping goes 30 s after it, then the worker's idle minute runs out (until 2026-11-14 the pings went on for 3 minutes, and it stopped 3–4 minutes after). Measured on 2026-11-13:

| | The whole shot |
| --- | --- |
| Your shots before (worker stopped between shots) | 102–242 s |
| Kept ready (models loaded) | 45 s |
| Loading the models on a stopped worker, ahead of the shot | 66–80 s, while you frame |

Cancelling a job that's running (Stop on the 360 world) restarts the worker, so the next job starts cold.

## Training LoRAs on the endpoint

The Train page can use the endpoint like any other machine once its worker carries Crackio's helper 1.11.0 or later (`comfyui/crackio_bridge/train.py`): pictures go up through R2, the training state and the LoRA live on the network volume, and each stretch of training is one job of at most 20 minutes. Until the worker is rebuilt from this version, Train says the endpoint's worker needs an update. This path is written but hasn't been run on RunPod yet; rented pods and your own GPUs have.

## Testing without RunPod

The worker runs under RunPod's own test server against any ComfyUI:

```sh
python -m venv rp && rp/Scripts/pip install runpod websocket-client requests
python local_worker.py --rp_serve_api --rp_api_port 8765   # imports serverless/worker/handler.py, HOST = your ComfyUI
RUNPOD_ENDPOINT_ID=localtest RUNPOD_API_KEY=local RUNPOD_API_BASE=http://127.0.0.1:8765 pnpm dev -p 3212
```

`RUNPOD_API_BASE` points Crackio's RunPod client at that server: its routes sit at the root, `/status` is a POST, and it has no `/health`.
