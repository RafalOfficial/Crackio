/**
 * What the public arenas and the people who use each model say about it, for the model library's cards. Researched
 * 2026-10-28 (Artificial Analysis and LMArena leaderboards; r/StableDiffusion, r/comfyui, r/aivideo, reviews), by
 * Crackio's model id. Quality is 0–100 within the model's main job (pictures, edits, video, swap, upscale). Client-safe.
 */
export type ModelNote = {
  quality?: number;
  /** What the quality rests on: an arena's ranking, the community's consensus, or published comparisons. */
  basis?: "arena" | "community" | "tests";
  /** Its standing, in a few words: "#2 open video model · Artificial Analysis". */
  rank?: string;
  /** What people say, in one line. */
  says?: string;
  released?: string;
  params?: string;
};

/**
 * Quality is one scale for every model of a job, open or closed: the best model overall sits near 97 and the rest follow
 * their arena Elo gap (about 10 points per 60 Elo), so a 67 open model and a 96 cloud model compare at a glance. Models
 * with nothing comparable to go on have no quality. Rebuilt from the research's model-research.json.
 */
export const MODEL_NOTES: Record<string, ModelNote> = {
  "codex:gpt-image-2": { quality: 90, basis: "arena", rank: "#3 of 106 for pictures · Artificial Analysis", says: "GPT Image 2 through a ChatGPT plan: #3 on most image arenas, good multilingual text; model set by plan", released: "2026-04-21" },
  "comfy:bfl/flux-3-image": { quality: 80, basis: "arena", rank: "#13 of 106 for pictures · Artificial Analysis", says: "BFL's closed flagship with 4K and pixel-level control; upper-mid on AA, behind GPT Image and Nano Banana", released: "2026-10-01" },
  "comfy:bria/image-edit-expand": { says: "Outpainting that keeps the original pixels and extends the canvas to new ratios; licensed training data" },
  "comfy:bria/image-edit-increase-resolution": { says: "Upscaler trained on licensed data that enlarges 2× or 4× without inventing detail; no independent tests" },
  "comfy:byteplus/dreamina-seedance-2-5-260628": { quality: 96, basis: "arena", rank: "#2 of 21 for image to video · Artificial Analysis", says: "Near the top of every video arena (AA image-to-video #2); native 30 s takes, 50 references; priciest", released: "2026-07-31" },
  "comfy:byteplus/seedream-5-0-pro-260628": { quality: 72, basis: "arena", rank: "#9 of 77 for edits · Artificial Analysis", says: "ByteDance's flagship: polished campaign-style images and strong edits (AA top 10); mid-pack for text-to-image", released: "2026-07-08" },
  "comfy:fal/crystal-upscaler": { says: "Portrait-focused upscaler from Clarity AI that keeps faces and skin texture; no public head-to-heads yet", released: "2025-12-31" },
  "comfy:freepik/ai-image-upscaler-precision-v2": { quality: 85, basis: "tests", says: "Faithful upscaler with three tuned models; keeps identity and structure, won't fix AI crowd flaws" },
  "comfy:kling/kling-v3": { quality: 74, basis: "arena", rank: "#16 of 21 for image to video · Artificial Analysis", says: "Cinematic motion, multi-shot and native audio up to 15 s; likeness can drift and lip-sync is uneven", released: "2026-02-04" },
  "comfy:kling/kling-v3-omni": { quality: 75, basis: "arena", rank: "#10 of 10 for edits · Artificial Analysis", says: "Kling with reference control and video editing; follows references better than Kling 3; edits not final-grade", released: "2026-02-05" },
  "comfy:fal/flux-3-max": { quality: 94, basis: "arena", rank: "#6 of 30 for video · Artificial Analysis", says: "BFL's video flagship: #3 on LMArena text-to-video, 20 s at 1080p with sound; text only through Router", released: "2026-10-19" },
  "comfy:fal/h3-max": { quality: 93, basis: "arena", rank: "#7 of 30 for video · Artificial Analysis", says: "MiniMax H3's 1080p tier: as strong as H3 on AA text-to-video, sharper output; text only through Router", released: "2026-09-01" },
  "comfy:ideogram/ideogram-4-5": { quality: 69, basis: "arena", rank: "#22 of 61 for edits · LMArena", says: "The typography specialist: posters, logos and long text come out clean; mid-pack for photoreal scenes", released: "2026-09-30" },
  "comfy:krea/krea-3": { quality: 89, basis: "arena", rank: "#5 of 77 for edits · Artificial Analysis", says: "Krea's new flagship: photoreal, art-directed images; its Ultra mode is top 5 on the AA edit arena", released: "2026-10-15" },
  "comfy:ltx/ltx-2-5-pro": { quality: 65, basis: "arena", rank: "#4 open model for video · Artificial Analysis", says: "Hosted LTX-2.5: fast clips with sound, multishot and 4K HDR; well behind the closed leaders on AA", released: "2026-08-11", params: "22B" },
  "comfy:minimax/minimax-h3": { quality: 97, basis: "arena", rank: "#1 of 21 for image to video · Artificial Analysis", says: "#1 image-to-video on both arenas, with sound and rich references; the API adds 2K output", released: "2026-07-31", params: "33B" },
  "comfy:openai/gpt-image-2.5-flare": { quality: 94, basis: "arena", rank: "#2 of 106 for pictures · Artificial Analysis", says: "OpenAI's fast default: #2 on most image arenas at up to half gpt-image-2's latency", released: "2026-09-08" },
  "comfy:openai/gpt-image-2.5-sunburst": { quality: 97, basis: "arena", rank: "#1 of 106 for pictures · Artificial Analysis", says: "#1 on every image arena; best at multi-step edits and keeping subjects; slower and pricier than Flare", released: "2026-09-08" },
  "comfy:qwen/qwen-image-3.0-pro": { quality: 76, basis: "arena", rank: "#17 of 106 for pictures · Artificial Analysis", says: "Qwen's closed top tier: about 25 Elo above Qwen-Image 3.0 on AA, with better edits", released: "2026-07-21" },
  "comfy:qwen/qwen-image-3.0": { quality: 72, basis: "arena", rank: "#18 of 106 for pictures · Artificial Analysis", says: "Closed Qwen that takes 4.5k-token prompts; launched without benchmarks or weights; the Pro tier ranks higher", released: "2026-07-21" },
  "comfy:veo/veo-3.1-generate-001": { quality: 76, basis: "arena", rank: "#11 of 21 for image to video · Artificial Analysis", says: "Polished 1080p clips with good native audio, 8 s max; costly and now ~130 Elo behind 2026 leaders", released: "2025-10-15" },
  "comfy:vertexai/gemini-nano-banana-2.1": { quality: 85, basis: "arena", rank: "#4 of 106 for pictures · Artificial Analysis", says: "Google's Flash-tier model: cheap and fast, cleaner text, 4K and 14 references; small text can blur", released: "2026-10-06" },
  "comfy:wan/wan3.0-video": { quality: 97, basis: "arena", rank: "#1 of 30 for video · Artificial Analysis", says: "#1 on AA text-to-video and video editing; 30 s at 1080p with sound, cheap; no open weights this time", released: "2026-08-06" },
  "comfy:wavespeed/seedvr2": { says: "Hosted SeedVR2: fidelity-first one-step upscaling to 4K/8K for about $0.01; model size not stated", released: "2025-06-10" },
  "comfy:xai/grok-imagine-image-2.0": { quality: 83, basis: "arena", rank: "#5 of 61 for edits · LMArena", says: "xAI's best image model, top 6 on the arenas and strong at edits (region tools, 5 references)", released: "2026-08-07" },
  "comfy:xai/grok-imagine-video-1.5": { quality: 89, basis: "arena", rank: "#4 of 48 for video · LMArena", says: "Fast, cheap clips with sound and reusable character references; physics and effects trail Seedance", released: "2026-06-03" },
  "grok:grok-imagine-image": { quality: 59, basis: "arena", rank: "#24 of 61 for edits · LMArena", says: "Fast, cheap Grok tier for drafts and volume; mid-board quality, behind Grok Imagine 2.0", released: "2026-01-28" },
  "grok:grok-imagine-image-2.0": { quality: 83, basis: "arena", rank: "#5 of 61 for edits · LMArena", says: "xAI's best image model, top 6 on the arenas and strong at edits (region tools, 5 references)", released: "2026-08-07" },
  "grok:grok-imagine-image-quality": { quality: 68, basis: "arena", rank: "#12 of 61 for edits · LMArena", says: "May 2026 quality mode, now outranked by Grok Imagine 2.0; reportedly retiring on Nov 2, 2026", released: "2026-05-19" },
  "grok:grok-imagine-video": { quality: 78, basis: "arena", rank: "#12 of 48 for image to video · LMArena", says: "Original Grok video (480p/720p, up to 15 s, with sound); well liked for image-to-video, now superseded by 1.5", released: "2026-01-28" },
  "grok:grok-imagine-video-1.5": { quality: 89, basis: "arena", rank: "#4 of 48 for video · LMArena", says: "Fast, cheap clips with sound and reusable character references; physics and effects trail Seedance", released: "2026-06-03" },
  "grok:grok-imagine-video-1.5-lite": { quality: 69, basis: "arena", rank: "#19 of 30 for video · Artificial Analysis", says: "Cheapest, fastest Grok tier for simple clips; no references; its 1080p is an upscale of 720p", released: "2026-10-06" },
  "local:flashvsr-plus": { quality: 80, basis: "tests", says: "Fast one-step 4× video upscaler in about half SeedVR2 7B's time; FlashVSR v1.1 shimmered on pans", released: "2026-10-14", params: "1.3B (Wan 2.1 base)" },
  "local:flux2-klein-4b": { quality: 32, basis: "arena", rank: "#7 open model for edits · LMArena", says: "Fastest Apache FLUX: sub-second pictures and usable edits on ~13 GB; well below 9B and FLUX 3 Klein", released: "2026-01-15", params: "4B" },
  "local:flux3-klein": { quality: 67, basis: "arena", rank: "#1 open model for pictures · Artificial Analysis", says: "Top open image model on AA right now; small (5.6B), INT8 runs in 8 GB, edits well; gated licence", released: "2026-10-15", params: "5.6B" },
  "local:ltx-2.5-ripple": { quality: 85, basis: "tests", says: "Crackio's tests: a dancer, a talking man and a falling car swapped for Cast members held identity, moves and mouth over 5 s; the place stays, ~1.5 min per 5 s on an RTX 5090", released: "2026-08-28", params: "22B (LTX-2.5) + IC-LoRA" },
  "local:ltx-2.5": { quality: 68, basis: "arena", rank: "#3 open model for video · Artificial Analysis", says: "Best open video model licensed in the EU/US: sound, multishot, up to 4K; well behind closed leaders", released: "2026-08-11", params: "22B" },
  "local:nomos-webphoto": { quality: 78, basis: "tests", says: "Fast upscaler for compressed web photos: removes JPEG blocks while sharpening; adds no new detail", released: "2024-05-28" },
  "local:nomos2-hq": { quality: 90, basis: "tests", says: "Best open choice for AI renders in Crackio's test: crisp edges and text, invents nothing; slower", released: "2024-08-29" },
  "local:realesrgan-x4": { quality: 62, basis: "tests", says: "Classic GAN upscaler: runs anywhere, even on CPU, in seconds; smooths textures, adds no real detail", released: "2021-07-22", params: "16.7M" },
  "local:scail-2": { quality: 88, basis: "community", says: "Best open character swap and animation; handles several people with masks, but needs prepared masks; 704p", released: "2026-06-09", params: "14B (Wan 2.1 base)" },
  "local:seedvr2-3b": { quality: 60, basis: "tests", says: "SeedVR2 for 12–16 GB cards: fast one-step restore, but clearly less faithful than the 7B", released: "2025-06-10", params: "3B" },
  "local:seedvr2-7b": { quality: 90, basis: "tests", says: "Most faithful open upscaler for real photos and footage in tests; natural faces; slow, 11 GB+", released: "2025-06-11", params: "7B" },
  "local:tpl:anima": { says: "Anime specialist (2B, Cosmos base) that runs in ~7 GB with natural-language prompts; non-commercial", released: "2026-01-29", params: "2B" },
  "local:tpl:bernini-r": { says: "ByteDance's video generation/editing renderer, used here to relight photos and clips; little public testing", released: "2026-06-01" },
  "local:tpl:boogu": { quality: 38, basis: "community", says: "10B Apache model with solid Chinese/English typography and a 3–4 step Turbo; only self-reported scores", released: "2026-06-16", params: "10B" },
  "local:tpl:boogu-edit": { quality: 47, basis: "community", says: "10B Apache editor with Chinese and English text; strong self-reported scores, no independent tests yet", released: "2026-06-16", params: "10B" },
  "local:tpl:capybara": { says: "Unified model that generates and edits images and video; ComfyUI nodes; no public quality tests", released: "2026-02-17" },
  "local:tpl:capybara-video": { says: "Same unified Capybara model for text-to-video and instruction video edits; untested in public", released: "2026-02-17" },
  "local:tpl:causal-forcing-video": { quality: 20, basis: "community", says: "Research real-time video: Wan 2.1 1.3B distilled to 1–4 steps; quick previews, low detail", released: "2026-01-30", params: "1.3B" },
  "local:tpl:chroma": { quality: 30, basis: "community", says: "Uncensored Apache remake of FLUX.1 schnell, liked for flexibility and fine-tunes; anatomy hit-or-miss", released: "2025-08-08", params: "8.9B" },
  "local:tpl:chronoedit": { quality: 47, basis: "community", says: "Edits by imagining a short video, so poses and objects change plausibly; 14B and heavy", released: "2025-10-28", params: "14B" },
  "local:tpl:ernie-image": { quality: 46, basis: "arena", rank: "#23 open model for pictures · Artificial Analysis", says: "Baidu's 8B Apache model, good at dense and long text layouts; runs on 24 GB; mid-pack on AA", released: "2026-04-14", params: "8B" },
  "local:tpl:firered-edit": { quality: 55, basis: "community", says: "Qwen-based 20B editor tuned for identity, makeup and multi-image fusion; mixed vs Qwen 2511 in tests", released: "2026-03-03", params: "20B" },
  "local:tpl:flux1-dev": { quality: 26, basis: "arena", rank: "#16 open model for pictures · LMArena", says: "2024 classic with the largest LoRA library; plastic skin and same-face look; far behind 2026 models", released: "2024-08-01", params: "12B" },
  "local:tpl:flux1-krea": { quality: 43, basis: "arena", rank: "#26 open model for pictures · Artificial Analysis", says: "FLUX.1 fine-tune with a natural, less 'AI' photo look; works with FLUX.1 LoRAs; non-commercial", released: "2025-07-31", params: "12B" },
  "local:tpl:flux1-schnell": { quality: 17, basis: "arena", rank: "#36 open model for pictures · Artificial Analysis", says: "Apache FLUX in 1–4 steps; fine for drafts, but low detail and near the bottom of AA", released: "2024-08-01", params: "12B" },
  "local:tpl:flux2-dev": { quality: 55, basis: "arena", rank: "#6 open model for pictures · LMArena", says: "Strong multi-reference generation and editing, but 32B is slow and VRAM-hungry; non-commercial", released: "2025-11-25", params: "32B" },
  "local:tpl:flux2-klein-9b": { quality: 43, basis: "arena", rank: "#11 open model for pictures · LMArena", says: "Fast 9B FLUX for pictures and edits; non-commercial licence; now behind FLUX 3 Klein (BFL: +91 Elo)", released: "2026-01-15", params: "9B" },
  "local:tpl:flux2-klein-9b-edit": { quality: 57, basis: "arena", rank: "#5 open model for edits · LMArena", says: "Fast multi-reference editor, among the best open edits for its size; non-commercial licence", released: "2026-01-15", params: "9B" },
  "local:tpl:hidream-e1": { quality: 25, basis: "arena", rank: "#22 open model for edits · Artificial Analysis", says: "2025 MIT instruction editor; near the bottom of AA's edit board today", released: "2025-07-16", params: "17B" },
  "local:tpl:hidream-i1": { quality: 38, basis: "community", says: "17B MIT model that led open arenas in spring 2025; heavy and slow, now outclassed", released: "2025-04-06", params: "17B" },
  "local:tpl:hidream-o1": { quality: 50, basis: "arena", rank: "#8 open model for pictures · LMArena", says: "Pixel-native 8B (no VAE): generates, edits, personalises up to 2K; MIT; its Dev variant scores far lower", released: "2026-05-08", params: "8B" },
  "local:tpl:hunyuanvideo-1.5-video": { quality: 46, basis: "arena", rank: "#2 open model for image to video · LMArena", says: "8.3B open video praised for faces and motion; no audio; licence excludes the EU, UK and South Korea", released: "2025-11-20", params: "8.3B" },
  "local:tpl:ideogram-4": { quality: 62, basis: "arena", rank: "#2 open model for pictures · LMArena", says: "Best open model for typography and layouts; JSON prompts with boxes and palettes; non-commercial weights", released: "2026-06-03", params: "9.3B" },
  "local:tpl:joyai-edit": { quality: 53, basis: "community", says: "JD's editor built for spatial edits: move or rotate objects and change the camera; Apache; few tests", released: "2026-03-31", params: "16B DiT + 8B MLLM" },
  "local:tpl:kandinsky-5": { quality: 26, basis: "community", says: "6B MIT model with English and Russian prompts; decent pictures, little community uptake", released: "2025-11-14", params: "6B" },
  "local:tpl:kandinsky-5-video": { quality: 32, basis: "arena", rank: "#6 open model for video · LMArena", says: "Small 2B MIT video model for short clips; light to run, but near the bottom of LMArena", released: "2025-09-26", params: "2B" },
  "local:tpl:krea-2": { quality: 54, basis: "arena", rank: "#6 open model for pictures · Artificial Analysis", says: "Style-range model: 8-step Turbo, 9 style LoRAs, ~3 s on a 4090; free for teams under 50 seats", released: "2026-06-22", params: "12.8B" },
  "local:tpl:lens": { quality: 40, basis: "community", says: "Microsoft's efficient 3.8B model: Turbo makes 1 MP in under a second; uses GPT-OSS-20B text features", released: "2026-05-25", params: "3.8B" },
  "local:tpl:longcat-image": { quality: 36, basis: "arena", rank: "#29 open model for pictures · Artificial Analysis", says: "Meituan's light 6B bilingual model with good Chinese text; well behind current leaders", released: "2025-12-04", params: "6B" },
  "local:tpl:longcat-image-edit": { quality: 47, basis: "arena", rank: "#15 open model for edits · Artificial Analysis", says: "Meituan's light 6B bilingual editor (global, local and text edits); low on AA's edit board", released: "2025-12-05", params: "6B" },
  "local:tpl:ltx-2-video": { quality: 41, basis: "arena", rank: "#4 open model for video · LMArena", says: "Lightricks' first open audio+video model (19B); fast and LoRA-friendly, less detail than Wan 2.2/Hunyuan", released: "2026-01-05", params: "19B" },
  "local:tpl:ltx-2.3-video": { quality: 56, basis: "arena", rank: "#5 open model for video · Artificial Analysis", says: "LTX-2 upgrade: sharper VAE, better audio, native 9:16; fast with sound but behind LTX-2.5", released: "2026-03-05", params: "22B" },
  "local:tpl:mage-flow": { quality: 40, basis: "community", says: "Microsoft's 4B model: native 512–2048 px at any aspect, fast Turbo, MIT; not on public arenas yet", released: "2026-07-22", params: "4B" },
  "local:tpl:mage-flow-edit": { quality: 51, basis: "community", says: "Small MIT instruction editor for backgrounds, styles and local edits; fast Turbo; unproven vs big editors", released: "2026-07-22", params: "4B" },
  "local:tpl:ming-image": { quality: 60, basis: "arena", rank: "#9 open model for pictures · Artificial Analysis", says: "Design specialist for posters, UI and infographics with dense text; about FLUX.2 dev level on AA", released: "2026-09-17", params: "6B" },
  "local:tpl:minimax-h3-video": { quality: 97, basis: "arena", rank: "#1 of 21 for image to video · Artificial Analysis", says: "Best open video model, #1 image-to-video on both arenas, with sound; 33B, not licensed in EU/UK/US/KR", released: "2026-08-03", params: "33B" },
  "local:tpl:netayume": { says: "Anime fine-tune of Neta Lumina (Lumina 2.0) on Danbooru; good character detail, anime only", released: "2025-08-06", params: "2.6B" },
  "local:tpl:newbie": { says: "Anime model (3.5B Next-DiT) with XML-structured prompts for multi-character scenes; experimental", released: "2025-11-30", params: "3.5B" },
  "local:tpl:omnigen2": { quality: 13, basis: "arena", rank: "#21 open model for edits · Artificial Analysis", says: "Early unified generate-and-edit model; flexible, but near the bottom of both AA boards", released: "2025-06-06", params: "~4B DiT + 3B VLM" },
  "local:tpl:pixeldit": { says: "NVIDIA research model that diffuses raw pixels (no VAE); 1.3B; non-commercial; paper results only", released: "2026-03-30", params: "1.3B" },
  "local:tpl:qwen-image": { quality: 40, basis: "arena", rank: "#13 open model for pictures · LMArena", says: "2025's open text-rendering leader (20B, Apache); now surpassed by 2512 and 2.1, and heavy", released: "2025-08-04", params: "20B" },
  "local:tpl:qwen-image-2.1": { quality: 65, basis: "arena", rank: "#1 open model for pictures · LMArena", says: "Top open model on LMArena for both pictures and edits; RGBA, 10 refs, 2.7K; research-only licence", released: "2026-09-20", params: "7B" },
  "local:tpl:qwen-image-2512": { quality: 47, basis: "arena", rank: "#7 open model for pictures · LMArena", says: "Qwen-Image update with more natural people and better text; strong Apache option, but 20B", released: "2025-12-31", params: "20B" },
  "local:tpl:qwen-image-edit": { quality: 48, basis: "arena", rank: "#3 open model for edits · LMArena", says: "First Qwen editor: good text edits, but drifts and shifts pixels; superseded by 2509 and 2511", released: "2025-08-18", params: "20B" },
  "local:tpl:qwen-image-edit-2511": { quality: 56, basis: "arena", rank: "#4 open model for edits · LMArena", says: "Go-to Apache editor: strong face and product consistency, big LoRA ecosystem; 20B, slow without Lightning", released: "2025-12-23", params: "20B" },
  "local:tpl:sdxl": { quality: 10, basis: "community", says: "2023 classic with a vast LoRA, ControlNet and anime fine-tune scene; runs on 8 GB; dated quality", released: "2023-07-26", params: "3.5B" },
  "local:tpl:wan-vace-video": { quality: 32, basis: "community", says: "All-in-one Wan 2.1 editor: reference-to-video, masks, inpaint, pose control; flexible, dated quality", released: "2025-05-14", params: "14B" },
  "local:tpl:wan2.2-14b-video": { quality: 40, basis: "arena", rank: "#3 open model for image to video · LMArena", says: "Open-video workhorse with the biggest LoRA scene and speed LoRAs; no audio; far behind 2026 leaders", released: "2025-07-28", params: "14B active (27B MoE)" },
  "local:tpl:z-image": { quality: 42, basis: "arena", rank: "#27 open model for pictures · Artificial Analysis", says: "Undistilled Z-Image: more varied, follows negative prompts, made for fine-tuning; less polished than Turbo", released: "2026-01-27", params: "6B" },
  "local:wan2.2-5b": { quality: 26, basis: "community", says: "Light Wan 2.2 that fits 8–12 GB cards at 720p; motion and detail clearly below the 14B", released: "2025-07-28", params: "5B" },
  "local:z-image-turbo": { quality: 44, basis: "arena", rank: "#10 open model for pictures · LMArena", says: "Community favourite for fast photoreal pictures on 8–16 GB cards; Apache; less varied, behind 2026 models", released: "2025-11-27", params: "6B" },
  "openai:gpt-image-2.5-flare": { quality: 94, basis: "arena", rank: "#2 of 106 for pictures · Artificial Analysis", says: "OpenAI's fast default: #2 on most image arenas at up to half gpt-image-2's latency", released: "2026-09-08" },
  "openai:gpt-image-2.5-sunburst": { quality: 97, basis: "arena", rank: "#1 of 106 for pictures · Artificial Analysis", says: "#1 on every image arena; best at multi-step edits and keeping subjects; slower and pricier than Flare", released: "2026-09-08" },
};

/** A model's note: by its own id, or the same model through another route (Router and a plan share one). */
export function noteFor(id: string): ModelNote | undefined {
  return MODEL_NOTES[id];
}
