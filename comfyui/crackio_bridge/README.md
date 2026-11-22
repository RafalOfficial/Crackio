# Crackio bridge (ComfyUI custom node)

Lets Crackio see what the machine running ComfyUI can handle, and install models into it, wherever that
ComfyUI runs: your own computer, another PC on your network, or a rented GPU.

It adds these routes, and one node (pooling, below):

| Route | What it does |
|---|---|
| `GET /crackio/info` | This machine: CPU, RAM, GPUs (memory and compute capability), free disk space where downloads go, its id (`machine_id`) and the download folder (`download_root`) |
| `POST /crackio/download` | `{url, folder, filename, sha256?, token?}`: fetches a model file into one of ComfyUI's model folders |
| `GET /crackio/downloads` | Every download since ComfyUI started, with its progress |
| `POST /crackio/downloads/{id}/stop` | Stops one |
| `POST /crackio/delete` | `{folder, filename}`: removes a model file |
| `GET /crackio/files`, `/crackio/nodes`, `POST /crackio/nodes/install`, `POST /crackio/restart` | Model files in every folder, the custom nodes Crackio uses, installing one, restarting ComfyUI so it loads |
| `GET /crackio/pool`, `POST /crackio/pool/{tensors,build,run,free}` | Pooling: hold and run the last blocks of another computer's model |
| `GET /crackio/lfm3/setup`, `POST /crackio/lfm3/packages` | LFM3-VL here: its files and fine-tunes, transformers installed and in use; bringing transformers to 5.21+ (a restart runs it) |
| `GET /crackio/storage` | Storage (1.10): every model folder with its paths and sizes, where a download into it goes, the drives they're on, unfinished downloads, ComfyUI's input/output/temp sizes, the voice and lip-sync engines (`?fresh=1` measures again, `?walk=0` skips measuring) |
| `POST /crackio/storage/root` | `{path}`: downloads go to `<path>/<model folder>` and ComfyUI looks there first; `{path: null}`: back to ComfyUI's own folders |
| `POST /crackio/storage/clean` | `{what: "parts"}`: unfinished downloads nobody is fetching; `{what: "comfy", older_than_hours?}`: Crackio's own copies in ComfyUI's `input/crackio` and `output/crackio` |

## Storage: where downloads go

`storage.py` (1.10). Until you choose a folder nothing changes: a download goes to the model folder named like its type
in ComfyUI's `models` folder, else to the folder's first path (from `extra_model_paths.yaml`, say).

- **A download folder.** Chosen in Crackio's Settings → Storage and kept in `<ComfyUI user folder>/crackio/storage.json`.
  Every download then goes to `<folder>/<model folder>` (`D:\Models\diffusion_models`), Voice's and Lip Sync's files and
  engines too, and ComfyUI looks there first for every model folder, from the moment it's chosen (no restart). Files
  from before stay where they are and still load. A folder chosen earlier stays one ComfyUI looks in, after its own
  folders, so nothing downloaded there goes missing when you pick another. Refused while downloads or installs run.
- **This machine's id.** Made once and kept in `<ComfyUI user folder>/crackio/machine.json`: a rented box that reconnects
  at another address is still the same machine to Crackio (its storage limit stays with it).
- **Cleaning up.** Unfinished downloads (`.part`) nobody is fetching and untouched for 10 minutes; Crackio's own copies in
  ComfyUI's `input/crackio` and `output/crackio` older than a day (every result is in Crackio's Library; your own files
  in those folders are never touched), never while ComfyUI is working.
- **Sizes** are measured at most every 5 minutes, without following links or junctions, a hard-linked file once.

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

## LFM3-VL: a small vision-language model as a node

`lfm3.py` adds **LFM3-VL (Liquid AI)**, Liquid AI's LFM3-VL-2B (1.9B). It reads up to six pictures, each at its own
size, plus words, and answers in text. On an RTX 5090 a four-picture check takes about 0.2 s. Crackio uses it to write
prompts and to check Swap's drawings.

- **Files**, in `models/lfm3`: `lfm3-vl-2b.safetensors` (LiquidAI/LFM3-VL-2B `model.safetensors`) and
  `lfm3-vl-2b-tokenizer.json` (its `tokenizer.json`). Fine-tunes go in as `lfm3-vl-2b-lora-<name>.safetensors` and show
  up in the node's `lora` list.
- **Judge.** `judge` is Crackio's swap judge, trained on Crackio's own clips. It says whether a redrawn frame fully swapped
  the character in and kept the pose, as Swap's JSON.
- **Code and licence.** The model's config, processor settings and code ship in `lfm3_vl/`, under the LFM Open License
  v1.0 (`lfm3_vl/LICENSE`): free, with commercial use for companies under $10M a year in revenue. It needs
  transformers 5.21 or newer (under 6).
- **Setup** (`lfm3_setup.py`, 1.9.2). `GET /crackio/lfm3/setup` says what's here: both files, the fine-tunes,
  transformers installed and the one ComfyUI runs, free space where the files go. `POST /crackio/lfm3/packages`
  brings ComfyUI's transformers into range with its own pip (uv's where it has none), moving nothing else it doesn't
  need; ComfyUI runs the new one after a restart. Crackio's Talk sets LFM3-VL up this way: the files, transformers,
  a restart once ComfyUI's queue is empty, then a hello it must answer. Fine-tunes a tool asks for (Swap's judge) come
  with the files through `/crackio/download`, each from its own Hugging Face repo, and each answers once with `lora`.
- **Memory.** The model stays on the GPU between answers and leaves it after 2 minutes idle (`CRACKIO_LFM3_IDLE`) or as
  soon as another job is queued, so a big video model next has the whole card.
- **Fine-tunes are merged** into the weights while they're in use (summed in float32 from the model file's weights, so
  switching never drifts): an answer costs what the base model's does, and a switch about a second.
- **Route.** `POST /crackio/lfm3` answers outside ComfyUI's queue, so a check doesn't wait behind a render:
  `{prompt, system?, images?: [base64], thinking?, max_tokens?, lora?, odds?: [JSON keys]}` → `{text, thinking, ms, odds}`.
  `odds` gives, for each named key the answer sets to true or false, how likely the model thought true was: a judge's
  yes and how sure it is. `POST /crackio/lfm3/stream` takes the same question and answers as it's written, in
  server-sent events (`{text}` with what's new, then `{done, text, ms}`), so Retouch draws each thing as soon as it's
  found; closing the connection ends the answer. Both take a conversation too: `history: [{role, text, images?}]` in
  place of `prompt` (the last turn yours), as Voice's Talk mode asks.
- **Templates**: `example_workflows/` shows three in ComfyUI's template browser: describe a picture, write a prompt from
  words in any language, and judge a swap.

## Lip Sync: new words, the same face

`lipsync.py` with `lipsync_worker.py`. The worker runs in its own process, with its packages in its own folder.

- **Crackio Lip Sync (LatentSync)** redraws the mouth to new speech, only in the frames that change and only round the mouth.
  - Every other pixel stays the clip's own.
  - `reference`: where the new mouth takes its looks from.
    - `same`: each frame itself.
    - `open`: the frame where the mouth is most open.
    - `pair`: that open frame where the words are loud, and the closed one where they're quiet.
  - `overlap`: frames its 16-frame windows share.
- **Crackio Mouth Refine (HuMo)** (1.10.1) is Lip Sync's best quality.
  - HuMo 17B redraws LatentSync's mouths lightly, at denoise 0.35. It hears the new speech (Whisper large v3, at the clip's own frame rate) and looks at the person's own frame where the mouth shows the most.
  - The teeth, lips and inside of the mouth come out as theirs, and the mouth keeps LatentSync's shapes. Then only the mouth area goes back onto the clip.
  - It works in windows of 97 frames that cross-fade over 16.
  - On an RTX 5090: 8 steps with ComfyUI's INT8 attention take about 5.5 minutes per window, peaking at 27 GB.
  - Finer drawing (1.10.2):
    - `scale` sets the window round the face (the face's biggest size times this).
    - `upscale` draws the window at `size` even when the face is smaller. The teeth and lips get more pixels and are shrunk back when pasted.
    - `guided_steps` keeps cfg on only the first steps, which is faster but blurs the teeth.
    - Crackio uses a window 1.5x the face drawn at 832, at denoise 0.42 with 6 steps, with Wan's own negative prompt.
  - The paste (both nodes, 1.10.2) puts the redrawn face back in one resampling. Where the drawing has more pixels than the frame gives the face, it's first softened just enough not to alias, then warped bicubically. It used to be bilinear, which blurred every frame at a moving face's sub-pixel shifts.
  - Lips only (1.10.3): `area` `lips` takes only HuMo's lips and the mouth's opening (a narrow margin round them) and lays them onto LatentSync's frames, whose skin and jaw already move with the new words. On some smooth faces HuMo draws stubble-like texture above the lip whatever its prompt or settings; LatentSync's skin there is clean. Sync came out higher too. `mouth` is the old area.
  - The colour pull (both nodes, 1.10.3) leaves out ring pixels that show different things in the drawing and the clip, and caps its shift. A head turning into her hair used to turn the whole mouth dark grey, with blue teeth.
  - Files, all in ComfyUI's own folders: `humo_17B_fp8_e4m3fn` (Comfy-Org/HuMo, Apache-2.0), `whisper_large_v3_fp16`, `umt5_xxl_fp8_e4m3fn_scaled` and `wan_2.1_vae`.
  - `humo_17B_mxfp8_crackio` is used instead where it's there. It's Crackio's MXFP8 build of Comfy-Org's fp16 HuMo: every Linear weight in MXFP8, the rest fp16. It gives the same pictures, and draws 1.7x faster on an RTX 5090, whose tensor cores do MXFP8 natively. It's on Hugging Face as [TR4F/crackio-humo-17b-mxfp8](https://huggingface.co/TR4F/crackio-humo-17b-mxfp8) (Apache-2.0, with its conversion script), and Settings offers it on RTX 50 cards.
  - `GET /crackio/lipsync` says which of them are here (`best`, and `best_fast` for the MXFP8 build).
- **Crackio Audio Edit (HuMo)** edits a clip to new speech without a mask, FlowAlign-style (experimental).

## Install

Copy this folder into ComfyUI's `custom_nodes` folder and restart ComfyUI:

```
ComfyUI/custom_nodes/crackio_bridge/__init__.py
ComfyUI/custom_nodes/crackio_bridge/lfm3.py
ComfyUI/custom_nodes/crackio_bridge/lfm3_vl/
ComfyUI/custom_nodes/crackio_bridge/mac.py
ComfyUI/custom_nodes/crackio_bridge/pool.py
ComfyUI/custom_nodes/crackio_bridge/small.py
ComfyUI/custom_nodes/crackio_bridge/storage.py
ComfyUI/custom_nodes/crackio_bridge/example_workflows/
```

You can skip it when ComfyUI runs on the same computer as Crackio. In that case Crackio writes the files straight
into ComfyUI's model folders, which ComfyUI reports at `/internal/folder_paths`.

Licence: MIT, like Crackio.
