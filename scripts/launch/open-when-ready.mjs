// For the Start Crackio launchers: waits until Crackio answers on its address, then opens it in your browser.
// usage: node scripts/launch/open-when-ready.mjs http://localhost:3211
import { exec } from "node:child_process";

const url = process.argv[2] ?? "http://localhost:3211";
const opener = process.platform === "win32" ? `start "" "${url}"` : process.platform === "darwin" ? `open "${url}"` : `xdg-open "${url}"`;
const until = Date.now() + 5 * 60_000;

for (;;) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (res.status < 500) break;
  } catch {
    /* not up yet */
  }
  if (Date.now() > until) process.exit(1);
  await new Promise((r) => setTimeout(r, 1500));
}
// CRACKIO_NO_BROWSER: start without opening one (tests, a server).
if (!process.env.CRACKIO_NO_BROWSER) exec(opener);
