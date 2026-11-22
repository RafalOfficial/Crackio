/**
 * Runs once when the server starts. It starts the ComfyUI Crackio installed on this computer (unless you stopped it), so
 * local models are ready after a reboot. In `next dev` it also gets every page compiled in the background
 * (lib/server/warm-pages), so first clicks don't wait; production builds are compiled ahead and skip it. Set
 * CRACKIO_WARM_PAGES=0 to turn that off. It also opens Crackio's secure address for the other devices on your network
 * (lib/server/lan-https: https on PORT + 1000), so a Mac or a phone can use the microphone.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // libvips keeps up to 20 pictures it read open; on Windows an open file can't be deleted or renamed (a take's temp
  // files, an atomic write). Its memory cache stays.
  if (process.platform === "win32") {
    const sharp = (await import("sharp").catch(() => null))?.default;
    sharp?.cache({ files: 0 });
  }
  // The live demo uses the box's own ComfyUI and never starts or stops one (docs/DEMO.md). A demo whose GPU is a RunPod
  // endpoint gets it ready now: its stand-in starts, and lists what the endpoint holds, before the first visitor.
  if (process.env.CRACKIO_DEMO === "1") {
    const { comfyTargets } = await import("./lib/server/comfy-targets");
    void comfyTargets().catch(() => undefined);
    return;
  }
  // Temp folders and files of jobs that stopped midway, a day old or more.
  setTimeout(
    () =>
      void import("./lib/server/temp-cleanup")
        .then((m) => m.cleanOldTemp())
        .then((r) => r.removed && console.log(`[temp] cleared ${r.removed} leftovers of stopped jobs (${Math.round(r.bytes / 1e6)} MB)`))
        .catch(() => undefined),
    60_000,
  );
  const { startWithCrackio } = await import("./lib/server/comfy-install");
  void startWithCrackio().catch(() => undefined);
  const { startLanHttps } = await import("./lib/server/lan-https");
  void startLanHttps();
  // The text models and the machines with Crackio's own LFM3 fine-tunes, looked up before the first question: a
  // Retouch picture right after a restart waited ~15 s for them.
  setTimeout(() => void import("./lib/engines/refine").then((m) => m.warmTextModels()).catch(() => undefined), 3000);
  // The idle stops set for rented boxes are watched from the start, not only once Settings is opened (a box left on
  // overnight stops by itself, also after Crackio restarted), and a training that was running is picked up again
  // without waiting for someone to open the Train page.
  setTimeout(() => {
    void import("./lib/server/setup/cloud-money").then((m) => m.watchIdle()).catch(() => undefined);
    void import("./lib/server/train/run").then((m) => m.reattach()).catch(() => undefined);
  }, 5000);
  if (process.env.NODE_ENV === "development") {
    const { warmPagesSoon } = await import("./lib/server/warm-pages");
    warmPagesSoon();
  }
}
