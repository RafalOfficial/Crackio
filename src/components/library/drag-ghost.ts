/**
 * What follows the pointer while takes are dragged: up to three of them, stacked, and how many.
 * Painted on a canvas from the cards' own pictures, so it's there the instant the drag starts
 * (the browser takes its snapshot right away).
 */
export const GHOST_SIZE = 104;

export function paintGhost(ghost: HTMLElement, keys: string[]) {
  const canvas = ghost.querySelector("canvas");
  const ctx = canvas?.getContext("2d");
  if (!canvas || !ctx) return;
  const S = GHOST_SIZE;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = S * dpr;
  canvas.height = S * dpr;
  canvas.style.width = `${S}px`;
  canvas.style.height = `${S}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, S, S);

  const pictures = keys.slice(0, 3).map((k) => document.querySelector<HTMLImageElement | HTMLVideoElement>(`[data-take="${CSS.escape(k)}"] :is(img, video)`));
  const card = 70;
  const tilt = [0, -8, 8];
  // Back to front, so the take that was grabbed ends up on top.
  for (let n = pictures.length - 1; n >= 0; n--) {
    ctx.save();
    ctx.translate(S / 2, S / 2 + 3);
    ctx.rotate((tilt[n] * Math.PI) / 180);
    const x = -card / 2;
    const y = -card / 2;
    ctx.shadowColor = "rgb(0 0 0 / 0.5)";
    ctx.shadowBlur = 14;
    ctx.shadowOffsetY = 5;
    ctx.beginPath();
    ctx.roundRect(x, y, card, card, 15);
    ctx.fillStyle = "#2a2531";
    ctx.fill();
    ctx.shadowColor = "transparent";
    ctx.clip();
    const el = pictures[n];
    if (el) drawCover(ctx, el, x, y, card, card);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "rgb(255 255 255 / 0.22)";
    ctx.stroke();
    ctx.restore();
  }

  if (keys.length > 1) {
    const label = keys.length > 99 ? "99+" : String(keys.length);
    ctx.font = `700 12px ${getComputedStyle(document.body).fontFamily}`;
    const w = Math.max(24, ctx.measureText(label).width + 14);
    const cx = S - 10 - w / 2;
    ctx.beginPath();
    ctx.roundRect(cx - w / 2, 6, w, 24, 12);
    ctx.fillStyle = "#ff5b2e";
    ctx.fill();
    ctx.fillStyle = "#1b0a04";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, cx, 18.5);
  }
}

function drawCover(ctx: CanvasRenderingContext2D, el: HTMLImageElement | HTMLVideoElement, x: number, y: number, w: number, h: number) {
  const video = el instanceof HTMLVideoElement;
  const sw = video ? el.videoWidth : el.naturalWidth;
  const sh = video ? el.videoHeight : el.naturalHeight;
  // A clip that hasn't loaded a frame yet, or a picture still on its way: the plain card shows.
  if (!sw || !sh || (video ? el.readyState < 2 : !el.complete)) return;
  const s = Math.max(w / sw, h / sh);
  const cw = w / s;
  const ch = h / s;
  ctx.drawImage(el, (sw - cw) / 2, (sh - ch) / 2, cw, ch, x, y, w, h);
}
