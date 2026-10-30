# Workflows

Everything Crackio makes on your own GPUs is a ComfyUI graph. Crackio builds one per model and job (`src/lib/engines/comfy-local-recipes.ts`, plus Comfy's own templates for the models in the Local store), queues it on your ComfyUI through ComfyUI's HTTP API, and keeps the exact graph that ran with the take: after its post-passes (detail pass, upscale, advanced settings), with its seed and file names, and with the machine, GPU and time it took. Comfy Router jobs keep their request instead.

In the Library, every take has **How it was made**: its models, LoRAs, seed, steps and guidance, each step's graph in order with its nodes, **Open in ComfyUI** (loads the graph into that machine's ComfyUI on Crackio's ComfyUI page) and **Workflow (.json)**. The recipes live in `data/recipes/<take id>.json`; `GET /api/generations/<id>/recipe?step=N&download=1` sends one graph.

## Graphs from real runs

`runs/` holds graphs exactly as real Crackio jobs queued them: Draft-size test takes made through Crackio's API on an RTX 5090 (vast.ai) and this repo's GTX 1060 PC. Drop one on ComfyUI to run it. Your own input pictures go in `input/crackio/`, under the names the `LoadImage`/`LoadVideo` nodes use. A job with several steps (a swap: outline, redraw, then the clip) has one file per step, numbered in the order they ran.

Regenerate them, or add a take of your own (its id is in the Library's `?view=` link):

```sh
node scripts/comfy/export-workflows.mjs                 # the takes listed in runs.json
node scripts/comfy/export-workflows.mjs --add <take id>  # add one
node scripts/comfy/export-workflows.mjs --redact        # prompts replaced by what they are
```

<!-- runs:start (written by scripts/comfy/export-workflows.mjs) -->
| Tool | Step | File | Models and LoRAs | Text encoders, VAE | Custom node packs | Ran on |
| --- | --- | --- | --- | --- | --- | --- |
| Image | FLUX 3 Klein, Draft | [image-flux3-klein.api.json](runs/image-flux3-klein.api.json) (9 nodes) | `flux3-image-klein-int8-convrot.safetensors` | `qwen3vl_4b_int8_convrot.safetensors`<br>`flux2-vae.safetensors` | core only | NVIDIA GeForce RTX 5090, 8.8 s |
| Image | Qwen-Image 2.1 Turbo, Draft | [image-qwen-image-2.1.api.json](runs/image-qwen-image-2.1.api.json) (16 nodes) | `qwen_image_2.1_turbo_int8_convrot.safetensors` | `qwen3vl_8b_int8_convrot.safetensors`<br>`qwen_image_2.1_vae_bf16.safetensors` | core only | NVIDIA GeForce RTX 5090, 14.9 s |
| Video | LTX-2.5, words to clip (2 s, 720p, distilled + 2× latent upscale) | [video-ltx-2.5-t2v.api.json](runs/video-ltx-2.5-t2v.api.json) (28 nodes) | `ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors`<br>`ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors` | `gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors`<br>`ltx-2.5-video-vae-bf16.safetensors`<br>`ltx-2.5-audio-vae-bf16.safetensors` | core only | NVIDIA GeForce RTX 5090, 1 min 3 s |
| Video | LTX-2.5, picture to clip (2 s, 720p) | [video-ltx-2.5-i2v.api.json](runs/video-ltx-2.5-i2v.api.json) (32 nodes) | `ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors`<br>`ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors` | `gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors`<br>`ltx-2.5-video-vae-bf16.safetensors`<br>`ltx-2.5-audio-vae-bf16.safetensors` | core only | NVIDIA GeForce RTX 5090, 1 min 0 s |
| Swap | 1. SAM 3.1 finds and tracks who's swapped, forward and back | [swap-ltx-2.5-inpaint--1-ltx-2-5-ripple-swap-preparing.api.json](runs/swap-ltx-2.5-inpaint--1-ltx-2-5-ripple-swap-preparing.api.json) (34 nodes) | `sam3.1_multiplex_fp16.safetensors` | – | core only | NVIDIA GeForce RTX 5090, 31.4 s |
| Swap | 2. FLUX 3 Klein redraws the frame with the new person (try 1) | [swap-ltx-2.5-inpaint--2-flux-3-klein.api.json](runs/swap-ltx-2.5-inpaint--2-flux-3-klein.api.json) (12 nodes) | `flux3-image-klein-int8-convrot.safetensors` | `qwen3vl_4b_int8_convrot.safetensors`<br>`flux2-vae.safetensors` | core only | NVIDIA GeForce RTX 5090, 15.7 s |
| Swap | 3. FLUX 3 Klein redraws the frame (try 2) | [swap-ltx-2.5-inpaint--3-flux-3-klein.api.json](runs/swap-ltx-2.5-inpaint--3-flux-3-klein.api.json) (12 nodes) | `flux3-image-klein-int8-convrot.safetensors` | `qwen3vl_4b_int8_convrot.safetensors`<br>`flux2-vae.safetensors` | core only | NVIDIA GeForce RTX 5090, 8.3 s |
| Swap | 4. FLUX 3 Klein redraws the frame (try 3) | [swap-ltx-2.5-inpaint--4-flux-3-klein.api.json](runs/swap-ltx-2.5-inpaint--4-flux-3-klein.api.json) (13 nodes) | `flux3-image-klein-int8-convrot.safetensors` | `qwen3vl_4b_int8_convrot.safetensors`<br>`flux2-vae.safetensors` | core only | NVIDIA GeForce RTX 5090, 21.0 s |
| Swap | 5. LTX-2.5 + Lightricks' in/outpainting IC-LoRA carry the redraw through the clip inside SAM's outline | [swap-ltx-2.5-inpaint--5-ltx-2-5-ripple-swap.api.json](runs/swap-ltx-2.5-inpaint--5-ltx-2-5-ripple-swap.api.json) (61 nodes) | `ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors`<br>`LoRA ltx-2.3-22b-ic-lora-in-outpainting-0.9.safetensors × 1` | `gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors`<br>`ltx-2.5-video-vae-bf16.safetensors`<br>`ltx-2.5-audio-vae-bf16.safetensors` | core only | NVIDIA GeForce RTX 5090, 1 min 37 s |
| Director | FLUX 3 Klein shoots the blocked scene (two cast members) | [director-flux3-klein.api.json](runs/director-flux3-klein.api.json) (13 nodes) | `flux3-image-klein-int8-convrot.safetensors` | `qwen3vl_4b_int8_convrot.safetensors`<br>`flux2-vae.safetensors` | core only | NVIDIA GeForce RTX 5090, 12.9 s |
| Angles | FLUX 3 Klein re-shoots from 30° right, 15° high | [angles-flux3-klein.api.json](runs/angles-flux3-klein.api.json) (10 nodes) | `flux3-image-klein-int8-convrot.safetensors` | `qwen3vl_4b_int8_convrot.safetensors`<br>`flux2-vae.safetensors` | core only | NVIDIA GeForce RTX 5090, 12.0 s |
| Relight | FLUX 3 Klein relights (warm key, upper right) | [relight-flux3-klein.api.json](runs/relight-flux3-klein.api.json) (10 nodes) | `flux3-image-klein-int8-convrot.safetensors` | `qwen3vl_4b_int8_convrot.safetensors`<br>`flux2-vae.safetensors` | core only | NVIDIA GeForce RTX 5090, 11.4 s |
| Retouch | FLUX 3 Klein changes one marked part | [retouch-flux3-klein.api.json](runs/retouch-flux3-klein.api.json) (10 nodes) | `flux3-image-klein-int8-convrot.safetensors` | `qwen3vl_4b_int8_convrot.safetensors`<br>`flux2-vae.safetensors` | core only | NVIDIA GeForce RTX 5090, 2.0 s |
| Upscale | Nomos2 HQ, 2× | [upscale-nomos2-hq.api.json](runs/upscale-nomos2-hq.api.json) (5 nodes) | `4xNomos2_hq_dat2.safetensors` | – | core only | NVIDIA GeForce GTX 1060 6GB, 2 min 54 s |
| Upscale | Real-ESRGAN, 4× | [upscale-real-esrgan-x4.api.json](runs/upscale-real-esrgan-x4.api.json) (4 nodes) | `RealESRGAN_x4plus.safetensors` | – | core only | NVIDIA GeForce RTX 5090, 3.8 s |
<!-- runs:end -->

Every graph above uses only nodes that ship with ComfyUI itself, SAM 3.1, LTX-2.5 and the edit-model nodes included. Each machine's `/object_info` says which module a node comes from, and a recipe names any custom node pack it needed. Templates run the same graphs as Swap, since a template is a swap on a ready-made clip. Wan 2.2 5B, FLUX.2 klein 4B (GGUF) and SeedVR2 aren't captured yet: their models weren't on the test machines. They come from the same builders, and their graphs land here the next time one runs (`--add`).

## Reference graphs

Crackio's first graphs, adapted from Comfy's official templates (linked below), with the inputs Crackio fills marked. The graphs Crackio queues today are built per job (see `runs/` above for real ones). The two swap graphs are captures from real runs.

| File | Used by | What Crackio sets | Based on |
| --- | --- | --- | --- |
| `director-depth.api.json` | Director | `6.text` = compiled prompt, `9.image` = the depth pass rendered from your 3D set (white = near) | `image_qwen_Image_2512_controlnet` |
| `director-flux3-klein.api.json` | Director (FLUX 3 bonus path) | `4.text` = prompt + layout boxes (`[{"id":"obj_1","bbox":[ymin,xmin,ymax,xmax],"desc":"…"}]` on a 0–1000 grid), `6.image` = layout guide, `7.image` = subject reference | `image_flux3_klein_image_edit` |
| `reference-edit.api.json` | Retouch, Product Studio, Cast | `7/8/9.image` = base and references (addressed as "Picture N"), `11.prompt` | `image_qwen_image_edit_2511` |
| `angles.api.json` | Angles | `7.image` = source, `20` = `CameraAngle` (`horizontal_angle` 0–360, `vertical_angle` −30…60, `zoom` 0–10) | `template_qwen_multiangle.app` |
| `ltx-2.5-ripple-swap-v2.api.json` | Swap and Templates on your own GPU since Oct 29: the Café Duo preset with both women swapped (Juno and Noor), run on an RTX 5090 | `9.image` = the frame where both show best (frame 36 here) with each drawn in up close (FLUX 3 Klein, best of two takes judged by a vision model), `11.file` = the clip at 24 fps, `83.file` = the clip played backwards. `33`/`105` = the clicked subjects' SAM 3.1 outlines (forward and backward), `35`/`107` = everyone else SAM 3.1 found. Ripple runs each way from the redrawn frame, and the made frames go back onto the clip through the outlines, never over anyone else | Same models as below, plus `sam3.1_multiplex_fp16.safetensors` for the outlines (made before this graph by Crackio's SAM 3.1 pass) |
| `ltx-2.5-ripple-swap.api.json` | Templates swap on your own GPU (run end-to-end on an RTX 5090: 15 s at 704×1280 in 190 s) | `9.file` = your clip at 24 fps, `15.image` = its first frame with your Cast member drawn in (FLUX 3 Klein edit), `6.text` = Ripple's sentence + what the finished clip shows. Three 121-frame passes, each continuing from the last one's final frame | [WepeNerd/LTX-Ripple](https://huggingface.co/WepeNerd/LTX-Ripple) (first frame, all frames IC-LoRA) on `video_ltx2_5_i2v`'s models |

## Models

| File | Folder | Source |
| --- | --- | --- |
| `qwen_image_2512_fp8_e4m3fn.safetensors` | `diffusion_models` | [Comfy-Org/Qwen-Image_ComfyUI](https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI) |
| `qwen_image_edit_2511_fp8mixed.safetensors`, `qwen_image_edit_2511_int8_convrot.safetensors` | `diffusion_models` | [Comfy-Org/Qwen-Image-Edit_ComfyUI](https://huggingface.co/Comfy-Org/Qwen-Image-Edit_ComfyUI) |
| `qwen_2.5_vl_7b_fp8_scaled.safetensors` | `text_encoders` | [Comfy-Org/Qwen-Image_ComfyUI](https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI) |
| `qwen_image_vae.safetensors` | `vae` | [Comfy-Org/Qwen-Image_ComfyUI](https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI) |
| `Qwen-Image-2512-Fun-Controlnet-Union-2602.safetensors` | `controlnet` | [alibaba-pai/Qwen-Image-2512-Fun-Controlnet-Union](https://huggingface.co/alibaba-pai/Qwen-Image-2512-Fun-Controlnet-Union) |
| `Qwen-Image-Lightning-4steps-V1.0.safetensors` | `loras` | [lightx2v/Qwen-Image-Lightning](https://huggingface.co/lightx2v/Qwen-Image-Lightning) |
| `Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors` | `loras` | [lightx2v/Qwen-Image-Edit-2511-Lightning](https://huggingface.co/lightx2v/Qwen-Image-Edit-2511-Lightning) |
| `qwen-image-edit-2511-multiple-angles-lora.safetensors` | `loras` | [fal/Qwen-Image-Edit-2511-Multiple-Angles-LoRA](https://huggingface.co/fal/Qwen-Image-Edit-2511-Multiple-Angles-LoRA) |
| `flux3-image-klein-base-int8-convrot.safetensors`, `qwen3vl_4b_int8_convrot.safetensors`, `flux2-vae.safetensors` | `diffusion_models`, `text_encoders`, `vae` | [black-forest-labs/flux-3-image-klein-comfy](https://huggingface.co/black-forest-labs/flux-3-image-klein-comfy) (gated: accept the license) |
| `ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors`, `gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors`, `ltx-2.5-video-vae-bf16.safetensors`, `ltx-2.5-audio-vae-bf16.safetensors` | `diffusion_models`, `text_encoders`, `vae` | [Lightricks/LTX-2.5](https://huggingface.co/Lightricks/LTX-2.5) (gated: accept the LTX-2 Community license) |
| `LTX25_Ripple_v11.safetensors` | `loras` | [WepeNerd/LTX-Ripple](https://huggingface.co/WepeNerd/LTX-Ripple) (LTX-2 Community license) |

Comfy Cloud ships most of these preinstalled.
