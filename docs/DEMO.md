# The live demo

Crackio can run as a public, code-gated website, so people can try it without installing anything: judges, a
giveaway, a link in a post. It runs on one GPU box whose ComfyUI is already set up, and only that box's own models are
used. Everything is off unless you build and start Crackio with `CRACKIO_DEMO=1`.

## What a visitor gets

- **Home, Image, Video, Library, Templates (Crackio's own clips), Swap, Upscale, Retouch, Relight and Angles.** You can
  narrow this with `CRACKIO_DEMO_TOOLS`, for example `image,video,recast`. Tool ids: `image`, `video`, `templates`,
  `recast` (Swap), `upscale`, `retouch`, `relight` and `angles`.
- **Access codes, which are the accounts.** A code carries credits, and whoever has it spends them. Its work (takes,
  uploads, the Library) is shown only to that code. Without a code, you can look around but not generate.
- **Prices in credits.** 1 cent is 2 credits. Each price is what the job would cost on RunPod serverless with an RTX
  5090 ($1.79 an hour), started cold, so the numbers stay true if the demo moves there. They're set in
  `src/lib/demo/price-list.ts`, and the demo page lists them:
  - a picture or an edit: 6 credits (2K: 7, 4K: 8), plus 2 for each extra picture in the same job;
  - a 5 s clip: 15 credits at 540p/720p, 23 at 1080p/1440p (longer clips cost in proportion);
  - a swap or a template run: 48 credits;
  - an upscale: 3 credits for a picture, 20 for a 5 s clip.

  A job that fails or is cancelled gives its credits back. A 300-credit code makes about 50 pictures, 20 clips or 6
  swaps.
- **Limits, set by environment variables:**
  - one running job per code;
  - clips up to 5 s (`CRACKIO_DEMO_CLIP_SECONDS`);
  - swaps and upscaled clips up to 10 s (`CRACKIO_DEMO_SWAP_SECONDS`);
  - pictures up to 4K (`CRACKIO_DEMO_IMAGE_TOP=2k` stops at 2K);
  - uploads: pictures, plus clips up to 100 MB (`CRACKIO_DEMO_UPLOAD_MB`), checked by their first bytes;
  - `CRACKIO_CONCURRENCY` jobs on the GPU at once (the deploy sets 2).

## What it never does

Every page and API route that isn't on the demo's list doesn't exist (`src/lib/demo/routes.ts`, enforced in
`src/proxy.ts`):

- settings, keys, sign-ins and connections;
- the Local page's installs, machines and cloud GPUs;
- the ComfyUI relay;
- Motion's agent (it runs code);
- URL downloads and the lab;
- Director, Cast, Product Studio and Storyboard. They plan with a text model and keep stores that aren't split per
  code yet.

Cloud models are hidden, because they would bill the server's keys. Visitors never enter keys: Connections stays
shut. A page that's left out shows the demo page in its place, which says why. The Local status the pickers read
leaves out every machine's address.

## Run it

The demo's web app needs no GPU: a small Ubuntu host (a VPS) runs it. The GPU work goes to the machines set up in the
demo's own data folder, the way Local adds them (a RunPod Serverless endpoint, a rented box). `COMFYUI_URL` optionally
adds a ComfyUI the host can reach. From your own computer:

```bash
scripts/demo/push.sh root@<host> <ssh-port>          # optional env: COMFYUI_URL, CRACKIO_DEMO_TOOLS, TUNNEL_TOKEN
```

That sends the committed code (never `data/`) and runs `scripts/demo/deploy.sh` on the host. The deploy:

- installs Node 22, pnpm and cloudflared when they're missing;
- builds Crackio in demo mode;
- runs it as its own unprivileged user on `127.0.0.1:3299`, with a Cloudflare tunnel in front, both as systemd services
  (supervisor or background processes where there's no systemd).

For the tunnel you get either:

- **A quick tunnel:** a random `https://….trycloudflare.com`, the default. Its address is printed at the end and
  changes when the tunnel restarts, so a front door (a Cloudflare Pages proxy with a fixed address) can sit before it.
  Behind one, the demo works without trusting the Host header: no absolute redirects, the cookie has no Domain, and it
  reads the visitor's address from the first `X-Forwarded-For` entry.
- **A named tunnel on your own domain:** make it in Cloudflare Zero Trust, pointing at `http://127.0.0.1:3299`, then
  deploy again with `TUNNEL_TOKEN=<token>`.

Settings live in `/opt/crackio-demo/demo.env`, which is made once with a fresh sign-in secret. The demo's data lives in
`/opt/crackio-demo/data`. It starts empty, with no keys and no settings, and the deploy refuses a data folder that holds
provider API keys. The demo never starts, stops or changes a ComfyUI.

**Credits and billed time.** By default a job costs its price from the list. When a job's recipe carries the GPU time a
serverless provider billed (RunPod's `executionTime` and `delayTime` per step), that time is charged instead, at the
same $1.79-an-hour rate plus the 5 s idle, up to what the code has left (`billedCredits` in `src/lib/demo/codes.ts`).

## Codes

On the host:

```bash
cd /opt/crackio-demo/app && set -a && . /opt/crackio-demo/demo.env && set +a
node scripts/demo/codes.mjs add --credits 1000 --count 3 --label judge  # prints each code once
node scripts/demo/codes.mjs add --credits 300 --count 10 --label pub
node scripts/demo/codes.mjs list
node scripts/demo/codes.mjs off <id>                                # switch one off
node scripts/demo/codes.mjs topup <id> --credits 100
```

Only a hash of each code is kept. Every charge and refund is appended to `data/demo/ledger.jsonl`. Wrong codes are
limited to 10 tries an hour per address.

## Private studios

A code can also get a whole studio of its own: a Crackio process with its own data folder, built with
`CRACKIO_DEMO_FULL=1`, so Director, Cast, Product Studio, Storyboard and Connections (your own Comfy key, RunPod key or
GPUs) work there as they do at home, and nobody else can see what's made in it. A small router
(`scripts/demo/router.mjs`) holds the public port: signing in with a studio's code sends that visitor to the studio from
then on, and everyone else gets the shared demo. On the host:

```bash
bash scripts/demo/studio.sh setup                              # once: the full build, the router, the services
bash scripts/demo/studio.sh add --credits 1000 --label judge1  # prints the studio's code once
bash scripts/demo/studio.sh list
bash scripts/demo/studio.sh off <id>
```

Each studio takes about 350 MB of memory while idle. Every later deploy rebuilds the studios too.

## Check it

```bash
bash scripts/demo/selftest.sh https://<demo-address> <code A> <code B>
```

The self-test tries the shut routes, the pages left out, generating without a code, a forged sign-in, path tricks, and
two codes looking at each other's work. It spends one Draft picture's credits, which come back when the test cancels it.

## Turn it off

```bash
systemctl stop crackio-tunnel crackio-demo        # or: supervisorctl stop crackio-tunnel crackio-demo
```

The address stops answering at once. To remove the demo, disable both services, delete their unit files
(`/etc/systemd/system/crackio-*.service`, or `/etc/supervisor/conf.d/crackio-*.conf`) and delete `/opt/crackio-demo`.
