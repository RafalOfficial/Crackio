# Hardware: your GPU, rented GPUs, two computers

[← Back to Crackio](../README.md)

## Run models on your own GPU

Open **Settings** at the bottom of the sidebar. Crackio reads your machine (GPU and its free memory, RAM, disk), says honestly what runs well on it, installs the version that fits, and runs it in every tool: free, private, no account.

1. **Install ComfyUI** once, from **Settings → Machines**. It gets one folder of its own: Python, ComfyUI, the PyTorch build your GPU needs and Crackio's bridge node. Nothing else on your system changes, and deleting the folder removes all of it. From then on it starts with Crackio (stop it in Settings → Machines and it stays stopped).
   - NVIDIA: GTX 900 series and newer. RTX 20 series and newer get CUDA 13 with driver 580+, everything else CUDA 12.6.
   - AMD: ROCm on Linux; on Windows 11, AMD's ROCm build for RX 6000 and newer.
   - Intel Arc (XPU) and Apple Silicon (Metal).
2. **Pick a model.** Every open model ComfyUI runs is listed with what it needs and how long it should take on this machine (see **How long a job takes** below). Install fetches the version that fits (GGUF on small cards and Macs) and checks it byte for byte.
3. **Use it.** Installed models are in every tool's model picker as "(your GPU)", and the time a job will take on your machine shows above the Generate button.

Measured through Crackio on real machines (Oct 2026): seconds per job with the model loaded, ComfyUI's own time (a rented box adds a few seconds of network). † the first run, loading included. ‡ PyTorch's CUDA 12 build, which leaves ComfyUI's INT8 kernels off: about 3× slower (Crackio now puts in CUDA 13 where the driver runs it). The time Crackio shows for any other card scales from these, and from the model's first run on yours.

| GPU | FLUX.2 klein 4B picture | FLUX.2 klein 4B edit | FLUX 3 Klein picture | Z-Image Turbo picture | Qwen-Image 2.1 picture | Wan 2.2 5B, 5 s 720p | Real-ESRGAN, 640×424 ×2 | Nomos2 HQ, 640×424 ×2 | SeedVR2 7B, 640×424 ×2 |
|---|---|---|---|---|---|---|---|---|---|
| RTX 5090 |  |  |  |  | 7.5 s INT8 |  | 0.9 s | 3.5 s | 1.8 s INT8 |
| RTX 5070 Ti | 2.4 s BF16 | 4.6 s BF16 | 12.6 s INT8‡ | 9.5 s INT8‡ |  | 24.1 s FP16 | 1.4 s | 3.5 s | 2.2 s INT8‡ |
| RTX 4070 | 3.2 s BF16 | 7.6 s BF16 | 4.8 s INT8 | 15 s† INT8 | 13.9 s Q6 | 60.6 s† Q8 | 2.4 s† | 4.9 s† | 6.8 s† INT8 |
| RTX 5060 Ti |  |  |  |  |  |  | 3 s† | 13.2 s† |  |
| RTX 4060 Ti | 10.7 s† BF16 | 9.8 s BF16 | 10.5 s† INT8 | 11.5 s† INT8 | 24.7 s† Q8 | 48 s† FP16 | 2.2 s | 7 s† |  |
| RTX 2080 Ti | 23.7 s† BF16 | 11.7 s BF16 |  | 22.6 s† INT8 |  | 84.8 s† Q6 | 2.4 s† | 8.1 s† |  |
| RTX 3060 Ti | 5.2 s FP8 | 11.7 s FP8 | 8 s INT8 |  |  |  | 2.2 s | 7 s | 2.2 s INT8 |
| GTX 1080 Ti |  |  |  | 132 s† Q5 |  |  | 3.5 s† | 31.9 s† |  |
| GTX 1060 6 GB | 67.5 s Q5 | 150 s Q5 |  |  | 224 s† Q8 | 536 s Q4 540p |  |  |  |

A MacBook Air M2 16 GB: a FLUX.2 klein 4B picture in ~1.6 min (97 s; 2.4 min before the Mac tuning below), an upscale 2× in ~21 s. An RTX 5090: a 5 s 720p LTX-2.5 clip with sound in ~55 s.

**On a Mac**, Crackio tunes ComfyUI for Apple's GPU (measured on a MacBook Air M2 16 GB with PyTorch 2.14, Oct 2026):

- **The fastest number format.** M1 and M2 GPUs have no bf16 math, so ComfyUI's default runs at half speed there. Crackio's bridge times fp16, bf16 and fp32 on your chip and computes each model in the fastest one it's made for: FLUX.2 klein went from 28 to 17 s a step, the same picture.
- **Apple's attention kernel.** PyTorch's fused Metal attention instead of ComfyUI's Mac default: twice as fast, without the 4–5 GB of scratch memory per attention that pushed a 16 GB Mac into swap. ComfyUI's default also turns LTX clips black on Macs.
- **Mac-safe samplers.** uni_pc becomes euler: on Apple GPUs it blows out Wan clips.
- **Memory back.** On Macs with 24 GB or less, ComfyUI lets its models go after 5 idle minutes, so your other apps get the memory back.
- **Heat and battery.** A job keeps the GPU at full power for minutes, and a MacBook Air has no fan. Crackio reads macOS's thermal state and the battery's temperature. When the Mac is hot, it waits between steps until it cools. On a MacBook Air, work that runs past 3 minutes rests between steps while the Mac is warm. Unplugged at 10% battery, it stops rather than drain it. Expect an Air to get warm: plug it in for clips and keep it on a hard surface.

**How long a job takes.** The time above the Generate button, and every model's time in Settings, is Crackio's best estimate for that job on the machine it will run on, with a likely range and where it comes from (`src/lib/local/estimate.ts`):

- **The card and its series.** Crackio reads the GPU ComfyUI runs on and its series: the first two digits of a GeForce card's number (RTX 4070 → RTX 40, GTX 1080 → GTX 10), or its architecture for workstation, Apple, AMD and Intel GPUs.
- **Benchmarks first.** The starting point is the runs measured on real cards, shipped in `src/lib/local/benchmarks.ts`. Next to Crackio's own runs on 9 cards are 232 published timings of 25 more models on over 50 cards (`scripts/local/reported-times.json`). Each published timing keeps its source, is converted to the job Crackio's template runs (steps, size, frames), and counts for less than Crackio's own runs. The estimate uses the same card's numbers if there are any, else its series', else every card's. Each is carried over by the cards' speed, the model's precision (INT8 on PyTorch's CUDA 12 build, FP8 on cards without FP8 math) and, on GTX 10 cards, what that model loses without tensor cores. A model with no timings at all starts from its size and steps, or from the model it's built on.
- **The machine now.** Crackio's bridge in ComfyUI reports the GPU's state. Memory other apps hold leaves less for the model. What doesn't fit streams from RAM every step, timed by the GPU's PCIe link; Windows lends the GPU system memory instead, which is far slower. Other apps keeping the GPU busy count too, and so does loading the model when the last job ran another one, at the speed this machine's disk showed.
- **Every run teaches it.** Each job's real time is kept, with what was estimated before it. After a run or two of a model its own runs take over, and after one when they disagree with the benchmarks (a GTX 1060's Nomos2 HQ estimate went from 250 s to 75 s after its first 64 s run); the recent ones and those of a similar size count most. How the machine compares with its benchmarks across every model it ran (a laptop's power limit, a slower bus, a busier desktop) carries over to the models it hasn't run yet. Settings shows, per machine, how many runs it learned from and how many of its recent runs took within 25% of the time shown before.

Each time in Settings is for one job: a ~1 MP picture, an edit with one reference picture, 5 s of 720p clip, or a 1 MP picture upscaled 2×. Its quality score is the model's standing among open models for its task: from public arenas (Artificial Analysis's open-model boards, Oct 2026) and, for upscalers, Crackio's own tests.

Disk: Crackio takes about 2.5 GB with its packages and ComfyUI about 2 GB; each model 0.1–40 GB, shown before you install. Got a second computer? In its **Settings → Machines** tick **Let my other computers use it**, then add its address under **Use another computer** in Settings → Machines here: each job runs on a machine that has its model (experimental).

**Pick the machine.** With more than one machine connected (this computer, another one, a rented GPU), jobs go to **Auto**: the free machine with the fastest GPU that has the model. To choose one, click the GPU's name in the time above Generate, open **Advanced → Run on**, or press **Send jobs here first** on that machine in **Settings → Machines**. Each lists every machine with the job's time there, or why it can't take it (offline, without the model, jobs ahead). The choice holds for every tool until you set Auto again; when that machine is offline or lacks the model, the job runs on Auto's pick and the time line says so.

**Resolution and Advanced.**
- **Resolution:** pictures from open models come at Draft, 720p, 1K, 2K or 4K. Each model draws natively up to the size it handles well (FLUX 3 Klein up to 4K on a fast GPU, Qwen-Image 2.1 up to about 4 megapixels). Past that the picture is drawn at that size and then redrawn by the same model at the size you picked (on a GPU with 16 GB and up) or enlarged with Real-ESRGAN, which Crackio installs itself the first time it's needed. Whenever a picture isn't drawn natively, a line above Generate says so ("4K here: drawn at about 2528×1680, then enlarged to 3840×2560"), and **Never enlarge** in Advanced keeps it at the largest size the model draws by itself.
- **Advanced:** sets the negative prompt, steps, guidance and seed. It offers only what the model's own workflow uses, with the model's values as defaults.
- **Measured on a rented RTX 5090:** a 4K Qwen-Image 2.1 picture took 33 s, and a 1080p LTX-2.5 clip took 118 s.

**Upscale on your own GPU.** The Upscale tool enlarges pictures 2× or 4× and clips to 1080p, 2K or 4K through ComfyUI, with any of these (Settings installs them):

| Upscaler | Pictures | Clips | Licence | What it's like |
| --- | --- | --- | --- | --- |
| **SeedVR2 7B** | ✅ | ✅ | Apache-2.0 | One-step diffusion restoration: the closest to real footage, and the one for soft, old or compressed photos |
| **FlashVSR+** (Turbo) | | ✅ | Apache-2.0 | Built for clips at 4×: next closest on real footage, in about half SeedVR2 7B's time (NVIDIA RTX 30 or newer; Crackio sets up its custom node, pinned) |
| **Nomos2 HQ** | ✅ | | CC-BY-4.0 (Phips) | The best for AI renders: by far the closest to the original, crisp edges and text, nothing invented |
| **Nomos WebPhoto** | ✅ | | CC-BY-4.0 (Phips) | Real photos: cleans JPEG and web compression while it sharpens |
| **Real-ESRGAN** | ✅ | ✅ | BSD-3-Clause | Fastest, on any machine: invents nothing, the steadiest from frame to frame |
| **SeedVR2 3B** | ✅ | ✅ | Apache-2.0 | SeedVR2 for 12–16 GB cards: less faithful than 7B, and for clips not faster |

How they compare, measured on the rented RTX 5090 (Oct 2026): each original was shrunk, upscaled back and compared with itself, frame by frame (LPIPS: how different it looks, lower is closer; times are ComfyUI's own on the box).

| | Live-action clip, 5 s, 864×360 → 1920×800 | Crackio's LTX clip, 5 s, 832×488 → 1842×1080 | Three Qwen-Image pictures, 2× from 640×424 |
| --- | --- | --- | --- |
| SeedVR2 7B | **0.106**, 166 s | 0.118, 223 s | 0.093 |
| FlashVSR+ Turbo | 0.121, 105 s | 0.161 | |
| Nomos2 HQ | | | **0.022**, ~5 s |
| Nomos WebPhoto | | | 0.055 |
| Real-ESRGAN | 0.131, 73 s | **0.109**, 73 s | 0.099 |
| SeedVR2 3B | 0.172 | 0.190 | 0.130 |
| Plain bicubic resize | 0.097 | 0.062 | 0.084 |

A plain resize stays closest on clean, mildly shrunk material: the upscalers add sharpness the original didn't have. Where they earn their keep is soft, compressed or very small sources, and there SeedVR2 7B brings back the most.

**ComfyUI page.** Every ComfyUI that's online (this computer's, others on your network, rented GPUs) opens inside Crackio as ComfyUI itself. A small relay adds a rented box's token. A job Crackio runs opens in its own tab of nodes, the running node lights up, and the result lands in its save node.

## No GPU: rented GPUs and RunPod Serverless

Rent a GPU on vast.ai, RunPod or any box with SSH (any template: ComfyUI, PyTorch, CUDA or plain Ubuntu; where no ComfyUI runs, Crackio installs it), then paste its SSH command, or its ComfyUI link, into **Settings → Machines → Connect a rented GPU**. Crackio logs in and reads the box's address and token. It then copies its bridge into ComfyUI and restarts it, so the box joins your machines. From then on, models install there from Settings and every tool's jobs can run there.

- **One-time setup:** your SSH key on the cloud account. Crackio uses the one in `~/.ssh`, or makes one; with your vast.ai or RunPod key saved, Crackio adds it to the account for you. Your Hugging Face token goes under **Settings → Accounts**. Crackio sends it with each download, so a box you rent needs no setup of its own.
- **With your vast.ai or RunPod key in Settings → Accounts**, no pasting: a GPU you rent there shows up in Settings → Machines within half a minute and connects by itself. Its first step waits while the cloud places the box and pulls its image (shown in the cloud's own words, "loading · Pull complete"), until the cloud says it runs and its SSH answers; on vast.ai Crackio then puts its SSH key on the box through the API (a RunPod pod needs the key on the account before it starts). A box you give back leaves your machines, and one restarted at new ports connects again. Turn **Connect GPUs I rent by themselves** off to press Connect on each instead.
- **Measured on 2026-10-24** with a vast.ai RTX 5090 (Malaysia, $0.54/h), on the official ComfyUI template:
  - Running 3 minutes after renting.
  - Connected 91 seconds after pasting its SSH command, 70 of them waiting for the template's first boot; a box that's already set up reconnects in 6 seconds.
  - 57 GB of models downloaded at about 120 MB/s.
  - A 1 MP Qwen-Image 2.1 picture in 12 s and a 5 s LTX-2.5 clip with sound in 64 s, warm, with results back on this computer.
- **The PyTorch build the card needs.** Cloud images often ship PyTorch's CUDA 12 build, and ComfyUI keeps its fast int8 and fp8 kernels off on it. When the box's driver runs CUDA 13, Crackio puts in the CUDA 13 build as it connects. On a rented RTX 4060 Ti that took 39 s, and then a FLUX 3 Klein picture took 11 s instead of 34 s and a Z-Image Turbo picture 12 s instead of 26 s. GTX 10 cards get the CUDA 12.6 build, the newest one with kernels for them.
- **Checked on rented RTX 5070 Ti, 5060 Ti, 4070, 4060 Ti, 3060 Ti, 2080 Ti and GTX 1080 Ti cards** (2026-10-24): the popular picture, edit, video and upscale models, 2–3 runs each, through Crackio (times in the table under **Run models on your own GPU**). Crackio's time estimates were corrected against these runs:
  - Picture upscalers barely slow down on smaller cards, and their time now follows the picture's size.
  - Spilling a few GB into RAM costs little on Linux.
  - INT8 models on a CUDA 12 build run about 3× slower.
  - A model's first run counts its loading.
  - On GTX 10 cards (no tensor cores), transformer models such as Z-Image Turbo, Nomos2 HQ and Wan 2.2 lose 2–2.5× more than their speed ratio says.
- **Clip upscales need RAM.** SeedVR2 and FlashVSR+ hold the frames in memory: a 5 s clip at 1080p needs about 25 GB. On a machine with less, Crackio says so before it starts.

**RunPod Serverless.** Deploy Crackio's worker as a RunPod Serverless endpoint (see [docs/SERVERLESS.md](SERVERLESS.md)), add its ID under **Settings → Accounts → RunPod Serverless**, install models on it from Settings, and pick it under Run on. GPUs start for a job and stop after it, billed by the second: on an RTX 4090 about $0.02 for a picture from cold, $0.001 warm, and $0.06 for a 2 s 720p clip.

**Comfy Cloud.** With a Comfy key and a Comfy plan with API access (Standard or higher), Crackio's graphs can run on Comfy's own servers, paid with your Comfy credits.

## Pool two computers for a model neither can hold

A model too big for one GPU can run split across two computers on your network. The computer with the files keeps the first blocks of the model's transformer; the other one's ComfyUI (with Crackio's bridge) keeps the rest in its own GPU memory and computes them. The weights cross the network once, when the model loads; after that only the activations between the two halves travel, 15–60 MB a step. The second computer needs no copy of the model and no disk space for it.

Measured (Oct 2026) between a **GTX 1060 6 GB** and a **MacBook Air M2 16 GB** on Wi-Fi:

| Model | Split | Result |
| --- | --- | --- |
| **Qwen-Image 2.1 Turbo** (GGUF Q8, 7.6 GB) | 12 blocks on the PC, 20 on the Mac | a 1024×1024 picture in about 7 min (8 steps of 44 s); the first load sends the Mac its 4.3 GB in a minute |
| **LTX-2.5**, the 22B audio-video model (GGUF Q3, 12 GB) | 27 and 21 of its 48 blocks | a 2 s clip at 960×512 with its soundtrack in 27 min, first load included |

For one picture it is slower than one GPU that held the model, because the two take turns at every step: the same Qwen-Image picture takes 3.7 min on this PC alone (it streams what its GPU can't hold from its RAM) and about 5.5 min split. With **two or more pictures**, Crackio samples them in two lanes side by side (the `Crackio Lanes Sampler` node): while one lane waits on the Mac, the other runs its first blocks on the PC, so both computers work all the time. Two Qwen-Image pictures took **6.1 min split against 8.3 min on the PC alone**, the same pictures (37–41 dB apart), and the split balances itself by each computer's measured speed. A laptop that is also in use makes a slower helper: under a long run with its own apps open, the MacBook Air started swapping and its share slowed from 1.3 to 3 s a block.

Pooling is for the machines that can't run a model by themselves, a Mac or a laptop with little RAM, or two cards that hold half each, and for batches, where two computers beat one.

To use it: install ComfyUI on both from Settings → Machines, tick **Let my other computers use it** on the second one, and add it under **Use another computer** on the first. **Split models too big for one GPU** sets when Crackio splits a job: **Auto** only when the computer with the files can't run it alone, **Always** whenever its GPU can't hold it, **Off** never. Models that will split show **Runs pooled**. GGUF models only, for now; the node is `Crackio Pool Loader (GGUF)` in `comfyui/crackio_bridge/pool.py`, so it works in any ComfyUI workflow too.
