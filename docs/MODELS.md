# Models and tools used

[← Back to Crackio](../README.md)

- **Open models, installed from Settings** (each shows its licence there):
  - **Pictures and edits:** FLUX 3 Klein, FLUX.2 klein 4B (for 6 GB cards and Macs), Qwen-Image 2.1, Qwen-Image-Edit 2511, Z-Image Turbo, plus about 50 more.
  - **Director shots:** Z-Image Director (Z-Image Turbo + Fun ControlNet Union 2.1) and Qwen Director (Qwen-Image 2.1 + its Fun ControlNet Union; Qwen Research licence, non-commercial).
  - **Clips:** LTX-2.5 with WepeNerd's Ripple IC-LoRA and the in/outpainting IC-LoRA, Wan 2.2 5B (small cards), and SCAIL-2 (character swaps).
  - **Tracking:** SAM 3.1. **Upscaling:** SeedVR2, FlashVSR+, Nomos2 and Real-ESRGAN. **In-between frames:** FILM.
  - **Text and vision on your GPU:** Qwen 3.5 9B, Qwen3-VL 8B and 4B, through Generate Text. Talk, the prompt enhancer and Crackio's vision checks use **LFM3-VL 2B** by Liquid AI under the LFM Open License v1.0 (free, commercial use only below $10M in yearly revenue; not an OSI licence). The bridge's copy of its code, `comfyui/crackio_bridge/lfm3_vl`, keeps that licence.
  - **Angles:** Qwen-Image 2.1 Turbo with the AnyAngle LoRA, under the Qwen Research licence (non-commercial), like Qwen Director.
  - **Lip sync:** LatentSync 1.6 by ByteDance (Apache-2.0 code; CreativeML OpenRAIL++-M weights, with use restrictions) with its StableSyncNet for the sync scores, and MediaPipe's face and hand landmarkers (Apache-2.0), run by the Crackio bridge's Lip Sync node in a Python process of its own. **Best quality** adds HuMo 17B (Comfy-Org's repack of ByteDance's HuMo, Apache-2.0) with Whisper large v3 (MIT), umt5-xxl and the Wan 2.1 VAE (Apache-2.0). Lip Sync needs an NVIDIA card with 11 GB or more (best quality: 32 GB, such as an RTX 5090); background music under changed words isn't separated, only the speech is crossfaded.
  - **Voice:** Fish Audio Drama 3 (Fish Audio Community License: free for personal use and businesses under $500k a year, not for hosted services; built with Fish Audio), VoxCPM2 (Apache-2.0), Supertonic 3 (OpenRAIL-M), and Qwen3-ASR with its forced aligner (Apache-2.0) for transcripts and word timings, all run by [audio.cpp](https://github.com/0xShug0/audio.cpp) (Apache-2.0) inside the Crackio bridge's Voice node.
- **Optional, on your own Comfy key:** Comfy Router's hosted models (FLUX 3, GPT Image 2.5, Kling, Veo, Seedance, Wan, MiniMax H3, Grok Imagine, and hosted text models) and Comfy Cloud.
- **Inside the app:** Depth Anything V2 and BiRefNet (onnxruntime) for sets and cut-outs, ffmpeg for clips, yt-dlp as Motion's download tool for clips you have the rights to. Built with Next.js 16, React 19, React Three Fiber (three.js), Tailwind 4 and GSAP.
- **Crackio's own page art:** the pictures and showcase clips on Crackio's pages were made with Grok Imagine 1.5 and GPT Image 2 ([`scripts/assets`](../scripts/assets)). The templates' clips are all open models: FLUX 3 Klein and LTX-2.5.
