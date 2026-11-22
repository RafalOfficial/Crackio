<h1 align="center">Crackio</h1>

<p align="center"><b>The AI studio people pay for, free and open source, on whatever GPU you have. Built on ComfyUI.</b></p>

<p align="center"><b>v1.1</b> · MIT · Windows, macOS and Linux · no account, no subscription</p>

<p align="center">
  <a href="https://crackio.pages.dev"><b>Try it live</b></a> ·
  <a href="#get-started"><b>Get started</b></a> ·
  <a href="#whats-new-in-v11"><b>What's new</b></a> ·
  <a href="#tools"><b>Tools</b></a> ·
  <a href="#agents-mcp"><b>Agents</b></a> ·
  <a href="#hardware"><b>Hardware</b></a> ·
  <a href="#guides"><b>Guides</b></a>
</p>

![Crackio: Home](docs/screenshots/home.webp)

Crackio is a full AI studio for pictures and video. Stage a shot on a 3D set, cut a film, swap anyone in a clip, shoot product ads, relight, retouch, upscale, train a LoRA of your own, or hand the whole studio to your coding agent. It all runs on open models through ComfyUI, on your own computer.

## Why Crackio

- **Runs on what you have.** A 2016 GTX 1060, any RTX card, a MacBook, a GPU you rent by the second. Crackio installs what fits and tells you how long a job takes *before* you press Generate.
- **A whole studio.** 18 tools in one app, not one trick.
- **Your agent can run it.** Claude Code, Codex CLI, Gemini CLI, OpenCode, Cursor and other MCP clients use Crackio the way you do.
- **ComfyUI inside.** Every job is a ComfyUI graph you can watch, open and download.
- **Free, private, yours.** No account. Your files stay on your machine. MIT.

## What's new in v1.1

- **[Train](docs/TRAIN.md):** make a LoRA of your own from a set of pictures: a person, a character, a thing, a look, or a change. Seven picture models.
- **[Agents (MCP)](docs/AGENTS.md):** connect a coding agent in one click. It gets 22 tools and can work inside Motion projects. You decide what it may spend.
- **Rent:** save the GPU you want and a price cap, and Crackio rents the first vast.ai box that fits.
- **Add-ons:** one-click extras. The first is a prompt enhancer that runs on your own GPU in about two seconds.
- **[Director](docs/DIRECTOR.md), rebuilt:** one screen with a Set view and a Camera view. **Film it** makes a shot move, **Fix this spot** changes one part of the place, and a video can be filmed again from a new camera.
- **LoRA library** (**Settings → LoRAs**): about 440 LoRAs for 26 models on one page, most popular first, each with an example and one Add button. A LoRA you switched on is downloaded to a new GPU by itself. Adult LoRAs stay out until an adult lets them in.
- **Your own LoRAs:** upload a `.safetensors` file and pick the machine it goes to. A LoRA keeps notes on how to prompt it.
- **Set-up does what it shows:** the model named on a tool's sheet is the one that gets installed.
- **Video settings that hold:** on your own GPU, every shape, size and length a video model offers is the one you get, checked clip by clip. A clip from a picture can take another shape (the picture is cropped), and Wan 2.2 14B makes 720p too.
- **RunPod pods** join your machines by themselves, like vast.ai boxes.

![Settings → LoRAs: LoRAs for a model, most popular first, each with its example](docs/screenshots/tool-loras.webp)

From v1.0, if you missed it: Voice and Talk, Lip Sync, Retouch, and one Settings for every machine and tool. The [live demo](https://crackio.pages.dev) still runs the first release.

## Get started

| You need | |
| --- | --- |
| **A computer** | Windows 10 or 11, or macOS 13+ on Apple silicon. Linux works from the terminal |
| **Node.js 22.13+** | the LTS installer from [nodejs.org](https://nodejs.org/en/download) |
| **Disk** | about 5 GB for Crackio and ComfyUI, plus 0.1 to 40 GB per model (shown before you install) |
| **A GPU (optional)** | NVIDIA GTX 10 or newer, Apple silicon, AMD or Intel Arc. No GPU? Use RunPod Serverless, a rented GPU or Comfy's cloud |

### Windows

1. Install Node.js from [nodejs.org/en/download](https://nodejs.org/en/download).
2. Get Crackio: on GitHub click **Code → Download ZIP**, then right-click the ZIP and choose **Extract All** (or `git clone` it).
3. Double-click **Start Crackio.bat**. The first time it installs and builds Crackio, which takes about 5 minutes; then your browser opens Crackio by itself.

Keep the black window open while you use Crackio: closing it stops Crackio. Next time it starts in seconds.

### macOS

1. Install Node.js from [nodejs.org/en/download](https://nodejs.org/en/download).
2. Get Crackio: **Code → Download ZIP** and double-click the ZIP to unzip it (or `git clone` it).
3. The first time, **right-click Start Crackio.command → Open → Open**. macOS asks once because the file comes from the internet; after that a double-click is enough. The first run installs and builds Crackio (about 5 minutes); then your browser opens Crackio by itself.

Keep the Terminal window open while you use Crackio: closing it stops Crackio.

### From a terminal (any system)

```bash
git clone https://github.com/RafalOfficial/Crackio.git
cd Crackio
corepack enable pnpm
pnpm install
pnpm studio          # builds, then runs on http://localhost:3211
```

### Your first picture

1. In Crackio, open **Settings → Machines** and press **Install ComfyUI**. It goes into one folder of its own with the PyTorch build your GPU needs, and nothing else on your system changes.
2. In **Settings → Tools**, set up a tool with the model Crackio picks for your machine (FLUX 3 Klein on most cards, FLUX.2 klein 4B on 6 GB cards and Macs).
3. Open **Image**, type what you want, press **Generate**. Everything you make stays in `data/` on your computer.
4. Optional: open **Settings → Tools → Add-ons** and get the **Prompt enhancer** (about 4 GB). With **Enhance** on, a few words like "sunset" then go to the model as a full prompt, written on your own GPU.

No GPU? Add a RunPod or vast.ai key under **Settings → Accounts** (or a RunPod Serverless endpoint), or a Comfy key for Comfy's cloud models.

<details>
<summary><b>Troubleshooting</b></summary>

- **The Node.js download page opens instead:** Node.js is missing or older than 22.13. Install the current LTS, then start Crackio again.
- **"Installing didn't work":** check your internet connection and start it again; it picks up where it stopped.
- **macOS says the file can't be opened, or "permission denied":** right-click it and choose Open. If that doesn't help, open Terminal in the Crackio folder and run `chmod +x "Start Crackio.command"` once.
- **Something else already uses port 3211:** close the other Crackio window, or start it on another port: `set CRACKIO_PORT=3300` before running the `.bat` from a Command Prompt, or `CRACKIO_PORT=3300 "./Start Crackio.command"` in Terminal.
- **Updating from v1.0:** `git pull` and start it the same way; it rebuilds only when the code changed. With a ZIP, unzip the new version and move your `data` folder (your pictures, clips, LoRAs and settings) from the old Crackio folder into the new one before you start it.
- **Models:** pictures and video run on your own GPU through ComfyUI, which Crackio installs for you from **Settings**, or through Comfy's cloud with a Comfy API key (**Settings → Accounts**).

</details>

## Tools

<table>
<tr><td width="50%" valign="top"><img src="docs/screenshots/tool-image.webp" alt="Image" width="420"><br><b>Image</b><br>Type what you want in any language, add reference pictures or @ someone from your Cast. Draft to 4K, on FLUX 3 Klein, Z-Image Turbo, Qwen-Image 2.1 and more.</td><td width="50%" valign="top"><img src="docs/screenshots/tool-video.webp" alt="Video" width="420"><br><b>Video</b><br>A clip from words, or from a start and end frame, with a camera move, a pace and sound. LTX-2.5 on your GPU, Wan 2.2 5B on small cards.</td></tr>
<tr><td width="50%" valign="top"><img src="docs/screenshots/director-ui.webp" alt="Director" width="420"><br><b>Director</b><br>A sentence or a photo becomes a 3D place. Put your cast on their marks, aim the camera, shoot it, then film it. <a href="docs/DIRECTOR.md">Guide</a></td><td width="50%" valign="top"><img src="docs/screenshots/storyboard-1.webp" alt="Storyboard" width="420"><br><b>Storyboard</b><br>Shoot your scenes, cut them on a timeline, make stills move and export one film. <a href="docs/STORYBOARD.md">Guide</a></td></tr>
<tr><td width="50%" valign="top"><img src="docs/screenshots/swap-ui.webp" alt="Swap" width="420"><br><b>Swap</b><br>Click anything in a clip and pick what it becomes: someone from your Cast, a product, a colour, or gone. <a href="docs/SWAP.md">Guide</a></td><td width="50%" valign="top"><img src="docs/screenshots/templates.webp" alt="Templates" width="420"><br><b>Templates</b><br>11 ready-made clips made by Crackio on open models. Put yourself, a friend or a product in them.</td></tr>
<tr><td width="50%" valign="top"><img src="docs/screenshots/tool-product.webp" alt="Product Studio" width="420"><br><b>Product Studio</b><br>Drop a photo of anything you sell. Crackio reads what it is, suggests the shots, and re-shoots any take where the label or shape drifted.</td><td width="50%" valign="top"><img src="docs/screenshots/tool-relight.webp" alt="Relight" width="420"><br><b>Relight</b><br>Drag a light around your subject or pick a look. The subject stays exactly as it is; only the light changes.</td></tr>
<tr><td width="50%" valign="top"><img src="docs/screenshots/tool-retouch.webp" alt="Retouch" width="420"><br><b>Retouch</b><br>Click a thing in your picture and say how it should change. Everything you didn't mark keeps its exact pixels.</td><td width="50%" valign="top"><img src="docs/screenshots/tool-upscale.webp" alt="Upscale" width="420"><br><b>Upscale</b><br>Pictures 2× or 4× and clips to 1080p, 2K or 4K on your GPU, with a before/after slider.</td></tr>
<tr><td width="50%" valign="top"><img src="docs/screenshots/tool-angles.webp" alt="Angles" width="420"><br><b>Angles</b><br>Orbit a virtual camera around your picture and get the same scene photographed from there.</td><td width="50%" valign="top"><img src="docs/screenshots/tool-motion.webp" alt="Motion" width="420"><br><b>Motion</b><br>An agent that makes ads, trailers and explainers: it plans the piece, builds it in code, makes pictures and clips where they're needed, and checks its own work.</td></tr>
<tr><td width="50%" valign="top"><img src="docs/screenshots/tool-voice.webp" alt="Voice" width="420"><br><b>Voice</b><br>Type a line and pick who says it: one of Crackio's voices, yours cloned from a short recording, or one described in words. <a href="docs/VOICE.md">Guide</a></td><td width="50%" valign="top"><img src="docs/screenshots/tool-lipsync.webp" alt="Lip Sync" width="420"><br><b>Lip Sync</b><br>Change what someone in a clip says by editing their words like text. Only the mouth is redrawn. <a href="docs/LIPSYNC.md">Guide</a></td></tr>
<tr><td width="50%" valign="top"><img src="docs/screenshots/tool-cast.webp" alt="Cast" width="420"><br><b>Cast</b><br>Add a person, an animal, a character or an object once. Type <code>@name</code> anywhere and it looks like itself.</td><td width="50%" valign="top"><img src="docs/screenshots/tool-train.webp" alt="Train" width="420"><br><b>Train</b><br>Make a LoRA of your own from 10 to 200 pictures, on your GPU or a rented one. <a href="docs/TRAIN.md">Guide</a></td></tr>
<tr><td width="50%" valign="top"><img src="docs/screenshots/tool-library.webp" alt="Library" width="420"><br><b>Library</b><br>Everything you made, in folders, on your computer. <b>How it was made</b> shows the model, seed, machine and the ComfyUI workflow.</td><td width="50%" valign="top"><img src="docs/screenshots/tool-comfyui.webp" alt="ComfyUI" width="420"><br><b>ComfyUI</b><br>Every ComfyUI you've connected opens inside Crackio. Each job is its own graph, and the running node lights up.</td></tr>
<tr><td width="50%" valign="top"><img src="docs/screenshots/tool-settings.webp" alt="Settings" width="420"><br><b>Settings</b><br>One place for every machine, tool, model and key. Each tool lists the models that fit, with real times, and sets them up in one click.</td><td width="50%" valign="top"><img src="docs/screenshots/tool-rent.webp" alt="Rent" width="420"><br><b>Rent</b><br>Save the GPU you want and a price cap. Crackio watches vast.ai and rents the first box that fits. Only you can switch a hunt on.</td></tr>
<tr><td width="50%" valign="top"><img src="docs/screenshots/tool-usage.webp" alt="Usage" width="420"><br><b>Usage</b><br>What your takes cost, and what they saved against the models' official APIs.</td><td width="50%" valign="top"><img src="docs/screenshots/tool-agents.webp" alt="Agents" width="420"><br><b>Agents (MCP)</b><br>Connect Claude Code, Codex CLI, Cursor or another MCP client in one click. <a href="docs/AGENTS.md">Guide</a></td></tr>
</table>

## Agents (MCP)

You say "make me a thumbnail". Your coding agent writes the prompts, makes drafts on your GPU, looks at them, and hands you the finished picture.

- **One click:** **Settings → Agents** lists the agents on your computer. **Connect** adds Crackio to one.
- **22 tools:** pictures, clips, Cast, LoRAs, retouch, relight, upscale, swaps, product shoots, the Director, voices, and Motion projects it can work inside.
- **You decide what it may spend:** **Nothing** (the default, your own computers only), **Ask me each time**, or **Allow everything**.
- **It's a guest:** it shares the queue with you, never cancels your jobs, and can delete only what an agent made.

Full guide, limits and manual set-up: [docs/AGENTS.md](docs/AGENTS.md).

## Hardware

Measured through Crackio on real machines:

| Where | What to expect |
| --- | --- |
| **GTX 1060 6 GB** (2016) | a picture in about 1 min, a 5 s 540p clip in about 9 min |
| **MacBook Air M2 16 GB** | a picture in about 1.6 min |
| **RTX 4060 Ti / 4070** | a picture in 3 to 11 s, a 5 s 720p clip in about a minute |
| **RTX 5090** | a 4K picture in 33 s, a 5 s 720p clip with sound in about 55 s |
| **Two computers** | one model split across both GPUs |
| **No GPU** | RunPod Serverless by the second, a rented vast.ai or RunPod box, or Comfy's cloud |

![Settings → Machines: every machine, its GPU live, and the tools ready on it](docs/screenshots/settings-machines.webp)

Times per card, Macs, rented GPUs, upscalers and pooling two computers: [docs/HARDWARE.md](docs/HARDWARE.md).

## Built on ComfyUI

- **Every job is a ComfyUI workflow**, on your ComfyUI, another computer, a rented box or RunPod Serverless.
- **Every result keeps its workflow.** Open it in ComfyUI or download it from the Library.
- **Crackio's own nodes** ship in [`comfyui/crackio_bridge`](comfyui/crackio_bridge) (MIT; the LFM3-VL model code in `lfm3_vl/` keeps Liquid AI's own licence) and work in any workflow: a model split across two computers, character swaps on 6 GB cards, Mac tuning and more.
- **[`workflows/`](workflows):** 15 graphs captured from real Crackio jobs, each runnable in stock ComfyUI.

## Known limits in v1.1

- **Train** runs on NVIDIA GPUs. It hasn't been run on a Windows PC's own card of 12 GB or more, on AMD or Intel GPUs, or on RunPod Serverless. No video LoRAs yet.
- **Agents** can't reach Storyboard or Lip Sync and can't start a training. Run for real with Claude Code, Codex CLI, Gemini CLI, OpenCode and Antigravity CLI; Cursor and Grok CLI connect and list the tools but haven't been run through a job.
- **Lip Sync** needs an NVIDIA card with 11 GB or more and isn't tried on Macs.
- **Swap's** best route needs a GPU with about 24 GB. Small cards use SCAIL-2, which is slow.
- **LoRAs:** of the about 440 listed, about 30 were run on a GPU (FLUX 3 Klein, Krea 2, SDXL, Qwen-Image 2.1, all ten Wan 2.2 14B picks and more); the rest are checked by their file format against ComfyUI's loader. A gated LoRA downloads only after you accept its terms on Hugging Face with the account whose token is in Settings.
- **Video models:** LTX-2.5, Wan 2.2 5B, Wan 2.2 14B, Causal Forcing and Kandinsky 5 Lite were run at every setting they offer. The other open video models from ComfyUI's templates (LTX-2.3, LTX-2, Wan VACE, Capybara) weren't run for this release. Hosted video models were checked setting by setting against Comfy's own price check, not each run. Models made for five seconds (Wan 2.2 14B, Kandinsky 5 Lite) stop at 5 s.
- **Rent** hunts on vast.ai only.
- **The live demo** runs the first release, not v1.1.

## Guides

| | |
| --- | --- |
| [Director](docs/DIRECTOR.md) | sets, cast, camera, Film it, Fix this spot |
| [Storyboard](docs/STORYBOARD.md) | projects, the timeline, Make it move, export |
| [Swap and Templates](docs/SWAP.md) | how swaps work, small cards |
| [Voice](docs/VOICE.md) · [Lip Sync](docs/LIPSYNC.md) | voices, scenes, changing what someone says |
| [Train](docs/TRAIN.md) | the seven models, measured speeds, edits, your own LoRA files |
| [Agents (MCP)](docs/AGENTS.md) | what an agent can do, spending, manual set-up |
| [Hardware](docs/HARDWARE.md) | times per GPU, Macs, rented GPUs, RunPod Serverless, two computers |
| [Models and licences](docs/MODELS.md) | every open model Crackio uses and its licence |
| [How it's built](docs/ARCHITECTURE.md) | where each part lives in the code |

## Models and licences

Crackio installs open models from **Settings**, and each one shows its licence there. Some are non-commercial (Qwen-Image 2.1 under the Qwen Research licence) or free only under a revenue limit (FLUX 3 Klein, Krea 2, Fish Audio Drama 3, LFM3-VL). The full list is in [docs/MODELS.md](docs/MODELS.md).

## Privacy

Keys never leave your machine, except to the provider they belong to. An agent you connect sends what it reads and looks at to its own AI provider; turn "Agents can see my pictures" off and it gets file paths only. See [SECURITY.md](SECURITY.md).

Crackio is an independent project built for Comfy's #OpenSourceHiggsfield challenge. It is not affiliated with or endorsed by Comfy or any other company, and it copies no other product's code, assets or designs. Its templates and demo clips were generated for it: no real people, no third-party footage. Company and model logos come from [Lobe Icons](https://github.com/lobehub/lobe-icons) (MIT) and [Simple Icons](https://simpleicons.org) (CC0); they're trademarks of their owners.

## Thanks

Crackio stands on [ComfyUI](https://github.com/comfyanonymous/ComfyUI) and the Comfy Org team's SDK and Router, and on the people who publish open models and nodes: Black Forest Labs, Alibaba Qwen and Tongyi-MAI, Lightricks (LTX-2.5), WepeNerd (Ripple IC-LoRA), Zhipu AI (SCAIL-2), Meta (SAM 3.1), ByteDance Seed (SeedVR2), Phips (Nomos2), city96 (ComfyUI-GGUF), Kijai, unsloth and many more.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Making an existing tool more reliable is as valuable as adding a new one.

## License

[MIT](LICENSE)
