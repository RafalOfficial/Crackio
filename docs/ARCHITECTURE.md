# How it's built

[← Back to Crackio](../README.md)

| Part | Where |
| --- | --- |
| App shell, dashboard, tools | `src/app`, `src/components` (Next.js 16, React 19, Tailwind 4) |
| Director's 3D stage | `src/components/director/stage` (React Three Fiber) |
| Photo → 3D set, cutouts | `src/lib/director/reconstruct.ts`, `src/lib/server/vision.ts` (Depth Anything V2 and BiRefNet lite on onnxruntime, on the GPU through DirectML on Windows; ~220 MB of weights download once to `data/models`) |
| Scene → prompt, layout boxes, camera math | `src/lib/director` (pure TypeScript, no React) |
| Engines | `src/lib/engines` (Comfy SDK for Comfy Router, your own ComfyUIs) |
| Local storage and job queue | `src/lib/server` (`node:sqlite`, files in `data/`) |
| ComfyUI graphs | `workflows/`, and each result's own graphs in `data/recipes/` |
| Crackio's ComfyUI nodes (pooling, small-GPU swaps, Mac tuning) | `comfyui/crackio_bridge` |
| The prompts behind every image on Crackio's own pages | `scripts/assets/manifest.json` (rendered with `pnpm assets:generate`) |
| App icons (white glyphs, traced to vectors, 4K masters) | `scripts/assets/icons.json` (rendered with `pnpm assets:icons`) |
