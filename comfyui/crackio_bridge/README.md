# Crackio bridge (ComfyUI custom node)

Lets Crackio see what the machine running ComfyUI can handle, and install models into it, wherever that
ComfyUI runs: your own computer, another PC on your network, or a rented GPU.

It adds these routes, and one node (pooling, below):

| Route | What it does |
|---|---|
| `GET /crackio/info` | This machine: CPU, RAM, GPUs (memory and compute capability), free disk space by the model folders |
| `POST /crackio/download` | `{url, folder, filename, sha256?, token?}`: fetches a model file into one of ComfyUI's model folders |
| `GET /crackio/downloads` | Every download since ComfyUI started, with its progress |
| `POST /crackio/downloads/{id}/stop` | Stops one |
| `POST /crackio/delete` | `{folder, filename}`: removes a model file |
| `GET /crackio/files`, `/crackio/nodes`, `POST /crackio/nodes/install`, `POST /crackio/restart` | Model files in every folder, the custom nodes Crackio uses, installing one, restarting ComfyUI so it loads |
| `GET /crackio/pool`, `POST /crackio/pool/{tensors,build,run,free}` | Pooling: hold and run the last blocks of another computer's model |

How downloads work:

- **Fast:** each file comes in 16 parallel byte ranges, because a single connection to Hugging Face's CDN often tops out at a few MB/s.
- **Safe:** the file is saved as `<name>.part` and only gets its real name once every byte has arrived and its SHA-256 matches.
- **Restricted:** only https links from Hugging Face, GitHub, ModelScope or Civitai are accepted. Files can only go into ComfyUI's own model folders, and only with model file extensions.
- **Gated models** such as LTX-2.5 and FLUX 3 Klein use the Hugging Face token Crackio sends, or else `HF_TOKEN`, or else `~/.cache/huggingface/token` on that machine.

## Pooling: one model on two computers

`pool.py` splits a GGUF diffusion model across the GPUs of two computers, for models that fit neither alone (LTX-2.5's
22B model on a 6 GB card and a 16 GB Mac). The node **Crackio Pool Loader (GGUF)** takes the place of Unet Loader
(GGUF) on the computer that runs the workflow: it keeps the model's first transformer blocks there, sends another
ComfyUI with this bridge (the helper) the rest of the weights once, and from then on sends it only the activations
between the two halves at every step (tens of MB). The helper needs no copy of the model file.

- `helper`: the other ComfyUI's address, listening on the network (`--listen`).
- `helper_blocks`: how many of the last blocks it runs; 0 picks as many as fit its free GPU memory.

Messages are a JSON header and raw tensor bytes, never pickled. A helper holds one pooled model at a time, and frees
ComfyUI's own models when one arrives. Only use it between your own computers on a network you trust: anyone who can
reach the helper's ComfyUI can use its GPU, as with ComfyUI itself.

## Small GPUs: SCAIL-2 swaps on a 6 GB card

`small.py` holds three nodes that Crackio's SCAIL-2 swap uses, and that work in any workflow:

- **Crackio Window Attention** (`window`, `dense_steps`): after the first steps, each frame of a SCAIL-2 clip (and its
  pose) attends only to the reference pictures and the frames within `window` latent frames of it, instead of the whole
  clip. On a GTX 1060 the attention of a 512p, 81-frame step takes 7.7 s a layer instead of 28 s, and a whole step of
  a 5 s clip 12 minutes instead of 19. Clips without SCAIL's layout are left alone.
- **Crackio FP16 On Old GPUs**: GTX 10 series and older cards have no bf16, so ComfyUI computes there in fp32; this
  computes in fp16 instead, at the same speed with half the memory for every activation. Only on those cards, and
  only for Wan models (some image models overflow in fp16).
- **Crackio Resample Frames** (`frames` or `like`): a batch at another frame count, each the nearest in time. SAM 3.1
  looks at every frame at 1008 px (3.3 s a frame on a GTX 1060), so Crackio tracks every 2nd frame and brings the
  masks back to every frame.

## Macs: precision, cooling, memory

`mac.py` holds **Crackio Mac Tuning** (`cooling`: auto, cool, balanced, off), which Crackio puts after every diffusion
model it loads on a Mac, and does nothing anywhere else:

- **Precision.** ComfyUI computes in bf16 on every Mac, but M1 and M2 GPUs have no bf16 math (an M2: fp16 2.6 TFLOPS,
  bf16 1.4). The node times fp16, bf16 and fp32 on the chip once and computes the model in the fastest precision
  ComfyUI lists for it (FLUX.2, Krea 2, Chroma, Wan and SDXL take fp16; Z-Image, Qwen-Image, FLUX 3 and LTX don't). It
  keeps ComfyUI's choice unless another is 15% faster, so M5 chips are left alone. FLUX.2 klein 4B on a MacBook Air M2:
  28 to 17 s a step, the same picture.
- **Cooling.** Before each step it reads macOS's thermal state and the battery's temperature (no admin rights). When
  the Mac is hot (serious or critical, or the battery at 40 °C) it waits until it cools. In `cool`, the default on a
  MacBook Air (no fan), it also rests a third of each step while the Mac is warm, once it has worked 3 minutes without
  a break. Unplugged with 10% battery left, it stops the job. Crackio's progress line says when it waits.
- **Awake.** While jobs run (and 30 s after), the bridge holds `caffeinate -i`, so macOS doesn't idle-sleep halfway through
  a clip (the display still may). It ends with ComfyUI's process.
- **Memory.** On Macs with 24 GB or less, ComfyUI lets its models go after `CRACKIO_IDLE_UNLOAD` seconds without a job
  (300; 0 turns it off), so other apps get the memory back.

`/crackio/live` reports a Mac's thermal state and battery under `mac`.

## Install

Copy this folder into ComfyUI's `custom_nodes` folder and restart ComfyUI:

```
ComfyUI/custom_nodes/crackio_bridge/__init__.py
ComfyUI/custom_nodes/crackio_bridge/mac.py
ComfyUI/custom_nodes/crackio_bridge/pool.py
ComfyUI/custom_nodes/crackio_bridge/small.py
```

You can skip it when ComfyUI runs on the same computer as Crackio. In that case Crackio writes the files straight
into ComfyUI's model folders, which ComfyUI reports at `/internal/folder_paths`.

Licence: MIT, like Crackio.
