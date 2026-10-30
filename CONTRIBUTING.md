# Contributing to Crackio

Thanks for helping. Crackio aims for ten tools that work every time rather than a hundred that mostly work, so contributions that make an existing tool more reliable are as welcome as new ones.

## Setup

```bash
pnpm install
pnpm dev          # http://localhost:3000
pnpm typecheck    # tsc --noEmit
pnpm lint
```

Requires Node.js 22.13+ (Crackio uses the built-in `node:sqlite`) and pnpm.

## How the code is organized

| Path | What lives there |
| --- | --- |
| `src/app` | Routes (Next.js App Router). `(studio)` holds the app shell and every page. `api/` holds route handlers. |
| `src/components` | UI. `director/` is the staging tool, `tools/` the image tools, `dashboard/` the home page. |
| `src/lib/director` | Pure scene math and the prompt compiler — no React. Start here to improve how scenes become prompts. |
| `src/lib/engines` | One file per engine (Comfy Router through the Comfy SDK, your own ComfyUIs). Each implements the small `Engine` interface in `types.ts`. |
| `src/lib/providers` | Detects which engines are connected on this machine. |
| `src/lib/server` | Local storage (SQLite, media files, settings) and the job runner. |
| `scripts/assets` | The prompts behind every image on Crackio's own pages and its app icons, and the scripts that render them. |

## Adding an engine

1. Create `src/lib/engines/<name>.ts` exporting an `Engine` (`id`, `label`, `supports`, `run`).
2. Register it in `src/lib/engines/index.ts` and add its id to `AUTO_ORDER` in `src/lib/providers/order.ts`.
3. Add detection to `src/lib/providers/detect.ts` so Connections can show its status.
4. Throw `EngineError(message, hint)` for anything a person can fix — the hint is shown under the failed card.

## Guidelines

- Write UI copy in plain words, from the user's side ("Connect an engine", not "Configure provider").
- Every visual choice in a tool should have a picture or diagram, with the film-set term underneath. People shouldn't need the vocabulary to get the shot.
- Don't add features that pretend to work. If an engine can't do something, say so in the UI.
- Never log or return API keys or session tokens.

## UI conventions

- **Icons.** Tools and navigation use app icons: a glossy squircle in the tool's hue with a solid white glyph image (`<ToolTile>`, `<NavTile>`, `<AppIcon>` in `src/components/ui/ToolTile.tsx`). The glyphs are in `public/icons`, made from `scripts/assets/icons.json` with `pnpm assets:icons`. Small controls inside panels keep using lucide line icons.
- **Company logos.** Use `<VendorMark vendor model />` for a model and `<ProviderMark provider />` for a connection (`src/components/brand/BrandMark.tsx`). Add a new company there rather than drawing a letter badge.
- **Shape.** Buttons, chips, cards and popovers are squircles: use the radius tokens (`rounded-chip`, `rounded-btn`, `rounded-card`, `rounded-panel`), which draw squircles automatically, or add `squircle` next to any other `rounded-*`. Reserve `rounded-full` for dots, avatars, switches and tags.
- **Feel.** Give every clickable control `press` (a quick press-in) instead of `transition-colors`. Text fields keep `outline-none` and add `field-focus`. Horizontal thumbnail strips get `strip-fade pr-9`.
- **Rows of controls.** A row of chips that can outgrow its space (like the Home composer's settings) goes in `<ScrollRow>` (`src/components/ui/ScrollRow.tsx`): one line at any width, scrolling sideways past what fits, with a dark fade and a jump arrow at each edge that has more. Don't let it wrap or drop labels at breakpoints.
- **Layers.** Put new component classes in `@layer components` in `globals.css`, so utilities on the same element still win.
- **Menus.** Use `<Popover>`: it renders into `<body>` and flips to the side with room, so an `overflow-hidden` parent can't cut it off.

## Pull requests

Keep PRs focused, describe what you tested, and include a screenshot or short clip for UI changes.
