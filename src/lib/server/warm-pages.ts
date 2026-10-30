import { TOOLS } from "@/lib/tools";

/**
 * In development, Next compiles each page the first time it's opened, so the first click on every
 * tab waits seconds. Once the dev server is up, this opens every page in the background, one at a
 * time, so each is compiled before you get to it (see src/instrumentation.ts).
 */
export function warmPagesSoon() {
  const g = globalThis as { __crackioWarmPages?: boolean };
  if (g.__crackioWarmPages || process.env.CRACKIO_WARM_PAGES === "0") return;
  g.__crackioWarmPages = true;
  // After start-up settles, so the page you're opening right now goes first.
  setTimeout(() => void warmPages(), 5000);
}

/**
 * Every page in the sidebar, in its order. (A list, not a scan of src/app: a folder scan here makes
 * the build trace the whole project.) Pages with a [param] compile on their first visit.
 */
const PAGES = ["/", "/create", "/video", "/templates", "/library", ...TOOLS.map((t) => t.href), "/settings/connections", "/settings/models"];

async function warmPages() {
  const origin = process.env.__NEXT_PRIVATE_ORIGIN || `http://localhost:${process.env.PORT || 3000}`;
  for (const page of PAGES) {
    try {
      const res = await fetch(new URL(page, origin), { signal: AbortSignal.timeout(180_000) });
      await res.arrayBuffer();
    } catch {
      // The server is busy or restarting: that page compiles on its first visit, as before.
    }
  }
}
