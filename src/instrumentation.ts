/**
 * Runs once when the server starts. It starts the ComfyUI Crackio installed on this computer (unless you stopped it), so
 * local models are ready after a reboot. In `next dev` it also gets every page compiled in the background
 * (lib/server/warm-pages), so first clicks don't wait; production builds are compiled ahead and skip it. Set
 * CRACKIO_WARM_PAGES=0 to turn that off. It also opens Crackio's secure address for the other devices on your network
 * (lib/server/lan-https: https on PORT + 1000), so a Mac or a phone can use the microphone.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // The live demo uses the box's own ComfyUI and never starts or stops one (docs/DEMO.md). A demo whose GPU is a RunPod
  // endpoint gets it ready now: its stand-in starts, and lists what the endpoint holds, before the first visitor.
  if (process.env.CRACKIO_DEMO === "1") {
    const { comfyTargets } = await import("./lib/server/comfy-targets");
    void comfyTargets().catch(() => undefined);
    return;
  }
  const { startWithCrackio } = await import("./lib/server/comfy-install");
  void startWithCrackio().catch(() => undefined);
  const { startLanHttps } = await import("./lib/server/lan-https");
  void startLanHttps();
  // The text models and the machines with Crackio's own LFM3 fine-tunes, looked up before the first question: a
  // Retouch picture right after a restart waited ~15 s for them.
  setTimeout(() => void import("./lib/engines/refine").then((m) => m.warmTextModels()).catch(() => undefined), 3000);
  if (process.env.NODE_ENV === "development") {
    const { warmPagesSoon } = await import("./lib/server/warm-pages");
    warmPagesSoon();
  }
}
