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

## Reporting a vulnerability

Please open a private security advisory on the repository (Security → Report a vulnerability) instead of a public issue. Include steps to reproduce and the affected version. We aim to respond within a few days.
