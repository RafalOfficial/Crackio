/**
 * The Motion runtime: a few lines injected into every composition so one document can be
 * played live in the browser (preview) and scrubbed frame by frame in headless Chrome (render).
 *
 * Compositions animate with CSS @keyframes, the Web Animations API, or `window.onFrame(t)`.
 * The runtime pauses every animation and sets its time, so frame N always looks the same.
 */

export type Stage = { width: number; height: number; duration: number; fps: number };

export const ASPECT_STAGES: Record<string, { width: number; height: number }> = {
  "16:9": { width: 1920, height: 1080 },
  "9:16": { width: 1080, height: 1920 },
  "1:1": { width: 1080, height: 1080 },
  "4:5": { width: 1080, height: 1350 },
};

function runtimeScript(stage: Stage) {
  return `<script>
(() => {
  const DURATION = ${stage.duration};
  const videos = () => Array.from(document.querySelectorAll("video"));
  const apply = (t) => {
    for (const a of document.getAnimations()) {
      try { a.pause(); a.currentTime = t * 1000; } catch (e) {}
    }
    try { if (typeof window.onFrame === "function") window.onFrame(t); } catch (e) { console.error(e); }
  };
  const seekVideo = (v, t) => new Promise((resolve) => {
    const start = Number(v.dataset.start || 0);
    const length = isFinite(v.duration) ? v.duration : 0;
    const local = Math.max(0, Math.min(Math.max(0, length - 0.04), t - start));
    if (!length || Math.abs(v.currentTime - local) < 0.001) return resolve();
    const done = () => { v.removeEventListener("seeked", done); resolve(); };
    v.addEventListener("seeked", done);
    v.currentTime = local;
    setTimeout(done, 2000);
  });
  let raf = 0, t0 = 0, playing = false;
  const api = {
    duration: DURATION,
    async ready() {
      // Module scripts (three.js) run late and may load textures: they promise readiness on window.motionReady.
      if (document.readyState !== "complete") await new Promise((r) => window.addEventListener("load", r, { once: true }));
      await new Promise((r) => setTimeout(r, 30));
      if (window.motionReady && typeof window.motionReady.then === "function") await Promise.race([window.motionReady, new Promise((r) => setTimeout(r, 30000))]).catch(() => {});
      await (document.fonts ? document.fonts.ready : Promise.resolve());
      await Promise.all(Array.from(document.images).map((img) => img.complete ? null : new Promise((r) => { img.onload = img.onerror = r; })));
      await Promise.all(videos().map((v) => v.readyState >= 1 ? null : new Promise((r) => { v.onloadedmetadata = v.onerror = r; setTimeout(r, 4000); })));
    },
    async seek(t) {
      videos().forEach((v) => v.pause());
      apply(t);
      await Promise.all(videos().map((v) => seekVideo(v, t)));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    },
    play(from) {
      playing = true;
      t0 = performance.now() - (from || 0) * 1000;
      videos().forEach((v) => { v.muted = true; v.play().catch(() => {}); });
      const tick = (now) => {
        if (!playing) return;
        const t = ((now - t0) / 1000) % DURATION;
        apply(t);
        for (const v of videos()) {
          const local = t - Number(v.dataset.start || 0);
          if (local < 0) { v.pause(); continue; }
          if (Math.abs(v.currentTime - local) > 0.3 && isFinite(v.duration) && local < v.duration) v.currentTime = local;
          if (v.paused) v.play().catch(() => {});
        }
        try { parent.postMessage({ type: "crackio:time", t }, "*"); } catch (e) {}
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    },
    pause() { playing = false; cancelAnimationFrame(raf); videos().forEach((v) => v.pause()); },
  };
  // A composition can read it but never replace it (a page once overwrote it and couldn't render).
  Object.defineProperty(window, "__crackio", { value: api, writable: false, configurable: false });
  apply(0);
  window.addEventListener("load", () => apply(0));
  window.addEventListener("message", (e) => {
    const d = e.data || {};
    if (d.type === "crackio:play") api.play(d.t || 0);
    if (d.type === "crackio:pause") api.pause();
    if (d.type === "crackio:seek") { api.pause(); api.seek(d.t || 0).then(() => { try { parent.postMessage({ type: "crackio:time", t: d.t || 0 }, "*"); } catch (e) {} }); }
  });
})();
</script>`;
}

/**
 * The composition, ready to load: a base URL so "/api/media/…" assets resolve, the stage size
 * locked, and the runtime added before any of the composition's own scripts run.
 */
export function withRuntime(html: string, stage: Stage, baseUrl?: string) {
  const head = [
    baseUrl ? `<base href="${baseUrl}">` : "",
    `<style>html,body{margin:0!important;width:${stage.width}px!important;height:${stage.height}px!important;overflow:hidden!important}</style>`,
    runtimeScript(stage),
  ].join("");
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => `${m}${head}`);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => `${m}<head>${head}</head>`);
  return `<!doctype html><html><head>${head}</head><body>${html}</body></html>`;
}
