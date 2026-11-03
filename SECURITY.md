# Security

Crackio is a local-first app: the server runs on your computer and talks directly to the engines you connect.

## What Crackio stores, and where

| What | Where | Leaves your machine? |
| --- | --- | --- |
| API keys you paste in the app (Comfy, Hugging Face, vast.ai, RunPod) | `data/settings.json` (created with owner-only permissions) | Only to the provider it belongs to |
| Uploads and generations | `data/uploads`, `data/media`, `data/crackio.db` | Only the images you send to an engine as references |

- Stored keys are never sent back to the browser — the settings API only reports whether a key is set and its last four characters.
- `data/` is gitignored. Don't commit it.

## Don't expose Crackio to the internet

The server has no user accounts: anyone who can reach it can use your connected engines and read your library. Keep it on `localhost`, or put it behind your own authentication if you host it.

- The double-click launchers (`Start Crackio.bat`, `Start Crackio.command`) and `pnpm studio` listen on `127.0.0.1` only. Setting `CRACKIO_HOST=0.0.0.0` before starting a launcher opens Crackio to your network, where anyone can use it. `pnpm dev` is for working on Crackio and keeps Next's default (your whole network).
- Changes another website asks your browser to make are refused: a POST, PATCH or DELETE to `/api/` whose `Origin` isn't Crackio's own address gets a 403.
- Crackio only answers under this computer's own names (`localhost`, its network addresses and name, any `.local` name). A website that points its own name at your computer (DNS rebinding) gets a 421. To reach Crackio under another name, add it to `CRACKIO_ALLOWED_ORIGINS`.
- The ComfyUI page's relays (one port per machine) refuse requests from other websites, so a page can't queue jobs or delete models on your ComfyUIs through them.

## Reporting a vulnerability

Please open a private security advisory on the repository (Security → Report a vulnerability) instead of a public issue. Include steps to reproduce and the affected version. We aim to respond within a few days.
