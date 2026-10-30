#!/usr/bin/env node
// Draws Crackio's logo: CRACKIO in the face of the "See it work" lockups (Archivo ExtraBold
// Italic, width 75; see .ad-label), outlined, with a strip of 35 mm film running through the O.
// The film shows in the O's counter, comes out of its right side and rises like a print leaving a
// camera. Its frames, perforations and cut end lean with the italic.
//
// Writes
//   src/components/brand/wordmark-art.ts   path data for components/brand/Logo.tsx
//   src/app/icon.svg                       the mark on a graphite tile (browsers that take SVG)
//   src/app/favicon.ico                    the same tile at 16, 32 and 48 px
//   src/app/apple-icon.png                 the same tile at 180 px
//
// Usage: node scripts/assets/logo.mjs
//
// The outlines below are Archivo's (SIL Open Font License) at wght 800, wdth 75, italic, in font
// units: 1000 per em, y down, baseline at 0. Everything this writes uses those units.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");

const GLYPHS = {
  C: { adv: 589, d: "M270 12Q152 12 95 -44Q38 -101 38 -217Q38 -247 41 -281Q44 -314 50 -351Q72 -471 114 -548Q157 -625 222 -663Q287 -700 376 -700Q443 -700 492 -679Q540 -659 566 -617Q592 -574 592 -507Q592 -487 590 -464Q588 -441 583 -415H426Q430 -436 432 -453Q434 -471 434 -484Q434 -511 426 -529Q418 -547 402 -556Q385 -565 360 -565Q332 -565 309 -554Q287 -543 271 -521Q254 -499 242 -466Q231 -434 223 -391Q215 -345 210 -314Q205 -284 202 -266Q200 -248 199 -237Q198 -226 198 -217Q198 -186 206 -164Q215 -143 233 -133Q251 -122 279 -122Q314 -122 338 -139Q363 -155 380 -188Q396 -221 405 -269H557Q541 -171 502 -109Q464 -47 406 -17Q348 12 270 12Z" },
  R: { adv: 584, d: "M10 0 131 -687H408Q475 -687 516 -667Q557 -646 576 -610Q594 -574 594 -527Q594 -476 581 -429Q568 -382 541 -344Q514 -306 473 -281L527 0H356L319 -243H214L171 0ZM237 -371H336Q363 -371 384 -388Q404 -406 416 -435Q427 -464 427 -500Q427 -527 413 -542Q399 -557 369 -557H269Z" },
  A: { adv: 584, d: "M-40 0 265 -687H476L532 0H366L361 -125H178L127 0ZM228 -254H357L353 -432Q353 -444 352 -458Q352 -472 351 -488Q350 -503 350 -518Q349 -532 349 -545H342Q336 -528 328 -507Q319 -486 312 -466Q304 -447 298 -432Z" },
  K: { adv: 593, d: "M10 0 131 -687H292L239 -390L468 -687H653L423 -395L537 0H366L292 -270L203 -183L171 0Z" },
  I: { adv: 273, d: "M10 0 131 -687H292L171 0Z" },
  O: { adv: 634, d: "M279 12Q201 12 147 -14Q93 -41 66 -93Q39 -146 39 -225Q39 -253 41 -284Q44 -316 50 -350Q71 -469 114 -547Q157 -624 223 -662Q290 -699 381 -699Q461 -699 515 -673Q569 -647 597 -594Q624 -542 624 -462Q624 -435 621 -403Q618 -372 612 -338Q592 -219 549 -141Q505 -63 438 -26Q371 12 279 12ZM291 -122Q322 -122 347 -134Q371 -146 389 -168Q407 -191 419 -224Q432 -257 439 -299Q447 -343 452 -371Q457 -400 459 -417Q461 -434 462 -445Q463 -455 463 -463Q463 -496 453 -519Q443 -541 423 -553Q403 -565 371 -565Q340 -565 315 -554Q291 -542 273 -519Q255 -496 243 -464Q230 -431 223 -389Q215 -345 210 -316Q206 -288 203 -270Q201 -253 200 -243Q199 -233 199 -225Q199 -192 209 -169Q219 -146 239 -134Q260 -122 291 -122Z" },
};
/** The face's only kerning pair in this word. */
const KERN = { AC: -9 };
/** Letter-spacing, as in the lockup (.ad-label: 0.06em). */
const TRACK = 60;
const CAP = 686;
const ITALIC = Math.tan((10 * Math.PI) / 180);

/** The film. Sizes are along the strip (s) and across it (v, + = its right-hand side). */
const FILM = {
  height: 430,
  perf: { w: 50, h: 54, edge: 28 }, // sprocket holes and their inset from the edge
  pitch: 96, // hole to hole; a frame spans four
  frameGap: 46,
  frameStart: -30, // where a frame begins, from the strip's start inside the O
  railGap: 22, // between the holes and the frames
  straight: 30, // past the O's right side before it bends
  bendRadius: 950,
  bendDeg: -13, // negative turns it up
  tail: 520,
  endPad: 40, // bare film left at the cut end
  gap: 24, // the dark seam where the O passes over the film
  feed: 240, // how far it feeds out when the logo is hovered (see .wordmark in globals.css)
};

/* ------------------------------------------------------------------ paths */

const r = (n) => Math.round(n);
const fmt = (pts) => "M" + pts.map(([x, y]) => `${r(x)} ${r(y)}`).join("L") + "Z";

/** Run every point of an absolute path (M L H V Q C Z, implicit L after M) through `fn`. */
function mapPath(d, fn) {
  const toks = d.match(/[MLHVQCZ]|-?\d+(?:\.\d+)?/g);
  let out = "", cmd = "", i = 0, x = 0, y = 0;
  const num = () => Number(toks[i++]);
  const pt = (px, py) => { const [a, b] = fn(px, py); return `${r(a)} ${r(b)}`; };
  while (i < toks.length) {
    if (/[A-Z]/.test(toks[i])) { cmd = toks[i++]; if (cmd === "Z") { out += "Z"; continue; } }
    if (cmd === "M") { x = num(); y = num(); out += "M" + pt(x, y); cmd = "L"; }
    else if (cmd === "L") { x = num(); y = num(); out += "L" + pt(x, y); }
    else if (cmd === "H") { x = num(); out += "L" + pt(x, y); }
    else if (cmd === "V") { y = num(); out += "L" + pt(x, y); }
    else if (cmd === "Q") { const a = [num(), num()]; x = num(); y = num(); out += "Q" + pt(...a) + " " + pt(x, y); }
    else if (cmd === "C") { const a = [num(), num()], b = [num(), num()]; x = num(); y = num(); out += "C" + pt(...a) + " " + pt(...b) + " " + pt(x, y); }
  }
  return out;
}

/** A contour's outline as points (curves sampled), for measuring. */
function outline(d) {
  const toks = d.match(/[MLHVQCZ]|-?\d+(?:\.\d+)?/g);
  const pts = [];
  let cmd = "", i = 0, x = 0, y = 0;
  const num = () => Number(toks[i++]);
  while (i < toks.length) {
    if (/[A-Z]/.test(toks[i])) cmd = toks[i++];
    if (cmd === "Z") break;
    if (cmd === "M") { x = num(); y = num(); pts.push([x, y]); cmd = "L"; }
    else if (cmd === "L") { x = num(); y = num(); pts.push([x, y]); }
    else if (cmd === "H") { x = num(); pts.push([x, y]); }
    else if (cmd === "V") { y = num(); pts.push([x, y]); }
    else if (cmd === "Q") {
      const [x1, y1, x2, y2] = [num(), num(), num(), num()];
      for (let k = 1; k <= 12; k++) { const t = k / 12, a = (1 - t) ** 2, b = 2 * (1 - t) * t, c = t * t; pts.push([a * x + b * x1 + c * x2, a * y + b * y1 + c * y2]); }
      x = x2; y = y2;
    }
  }
  return pts;
}

/** Where a closed outline crosses the line y (leftmost, rightmost). */
function span(pts, y) {
  const xs = [];
  pts.forEach(([x1, y1], k) => {
    const [x2, y2] = pts[(k + 1) % pts.length];
    if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) xs.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
  });
  return [Math.min(...xs), Math.max(...xs)];
}

/** The strip's spine: a straight run, an arc, another straight run. Returns (s, v) -> point. */
function spine(start, runs) {
  const pts = [{ x: start.x, y: start.y, h: 0, s: 0 }];
  let { x, y } = start, h = 0, s = 0;
  for (const run of runs) {
    const len = run.arc ? Math.abs(run.deg * Math.PI / 180) * run.arc : run.line;
    const turn = run.arc ? (run.deg * Math.PI) / 180 : 0;
    const n = Math.max(1, Math.ceil(len / 2));
    for (let k = 0; k < n; k++) {
      const mid = h + turn / n / 2;
      x += Math.cos(mid) * (len / n); y += Math.sin(mid) * (len / n); h += turn / n; s += len / n;
      pts.push({ x, y, h, s });
    }
  }
  const at = (q) => {
    const end = q > s ? pts[pts.length - 1] : q < 0 ? pts[0] : null;
    if (end) { const d = q - end.s; return { x: end.x + Math.cos(end.h) * d, y: end.y + Math.sin(end.h) * d, h: end.h }; }
    let lo = 0, hi = pts.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (pts[m].s <= q) lo = m; else hi = m; }
    const a = pts[lo], b = pts[hi], t = (q - a.s) / (b.s - a.s || 1);
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, h: a.h + (b.h - a.h) * t };
  };
  // Lean everything with the italic: a point's place along the strip shifts with its height on it.
  const map = (q, v) => { const p = at(q - v * ITALIC); return [p.x - Math.sin(p.h) * v, p.y + Math.cos(p.h) * v]; };
  return { length: s, map };
}

/** A box on the strip, from s0 to s1 along and v0 to v1 across, as a polygon that follows it. */
function onStrip(sp, s0, s1, v0, v1, step = 30) {
  const pts = [];
  const n = Math.max(1, Math.ceil((s1 - s0) / step));
  for (let k = 0; k <= n; k++) pts.push(sp.map(s0 + ((s1 - s0) * k) / n, v0));
  for (let k = n; k >= 0; k--) pts.push(sp.map(s0 + ((s1 - s0) * k) / n, v1));
  return fmt(pts);
}

/* ------------------------------------------------------------------ the wordmark */

let pen = 0;
const word = [...("CRACKIO")].map((ch, i, all) => {
  const at = pen;
  pen += GLYPHS[ch].adv + (all[i + 1] ? (KERN[ch + all[i + 1]] ?? 0) + TRACK : 0);
  return { ch, at };
});
const oAt = word[6].at;
const shift = (d, dx) => mapPath(d, (x, y) => [x + dx, y]);
const LETTERS = word.slice(0, 6).map(({ ch, at }) => shift(GLYPHS[ch].d, at)).join("");
const O = shift(GLYPHS.O.d, oAt);
const [O_OUTLINE, COUNTER] = O.split(/(?=M)/);
const outer = outline(O_OUTLINE);
const inner = outline(COUNTER);

// The film runs through the middle of the counter.
const ys = inner.map((p) => p[1]);
const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
const [cl, cr] = span(inner, cy);
const cx = (cl + cr) / 2;
const [ol, or] = span(outer, cy);
const startX = ol + 40;
const sp = spine({ x: startX, y: cy }, [
  { line: or - startX + FILM.straight },
  { arc: FILM.bendRadius, deg: FILM.bendDeg },
  { line: FILM.tail },
]);
const h2 = FILM.height / 2;
const end = sp.length;
// The strip reaches back past the O's left side, so that it never runs out while it feeds.
const back = -(FILM.feed + 300);

const STRIP = onStrip(sp, back, end, -h2, h2);
const EDGE_HI = onStrip(sp, back, end, -h2, -h2 + 14);
const EDGE_LO = onStrip(sp, back, end, h2 - 18, h2);
const { w: pw, h: ph, edge } = FILM.perf;
const perfs = [];
for (let s = 30 + Math.floor(back / FILM.pitch) * FILM.pitch; s + pw < end - FILM.endPad; s += FILM.pitch) {
  perfs.push(onStrip(sp, s, s + pw, -h2 + edge, -h2 + edge + ph, 60), onStrip(sp, s, s + pw, h2 - edge - ph, h2 - edge, 60));
}
const rail = edge + ph + FILM.railGap;
const framePitch = FILM.pitch * 4;
const FRAMES = [];
for (let s = FILM.frameStart + Math.floor(back / framePitch) * framePitch; s < end - FILM.endPad; s += framePitch) {
  const s1 = Math.min(s + framePitch - FILM.frameGap, end - FILM.endPad);
  if (s1 - s > 120) FRAMES.push(onStrip(sp, s, s1, -h2 + rail, h2 - rail));
}
// Everything right of the counter's middle, leaning with the italic: with the O's outline, it's
// where the film may show (it never pokes out between the I and the O).
const FRONT = fmt([[cx + ITALIC * 3000, cy - 3000], [99999, cy - 3000], [99999, cy + 3000], [cx - ITALIC * 3000, cy + 3000]]);

// The art's boxes: the whole word, and the O with its film (the mark).
const tip = [sp.map(end, -h2), sp.map(end, h2)];
const pad = 40;
const right = Math.max(pen, ...tip.map((p) => p[0])) + pad;
const top = Math.min(-CAP - 20, ...tip.map((p) => p[1])) - pad;
const bottom = 20 + pad;
const VIEW = { x: 0, y: r(top), w: r(right), h: r(bottom - top) };
const MARK_VIEW = { x: oAt + 10, y: r(top), w: r(right - oAt - 10), h: r(bottom - top) };

const art = `// Generated by scripts/assets/logo.mjs: change that and run it, don't edit this.
// Crackio's wordmark in font units (1000 per em, y down, baseline at 0).

/** The whole word, and the mark alone (the O and its film). */
export const VIEW = ${JSON.stringify(VIEW)};
export const MARK_VIEW = ${JSON.stringify(MARK_VIEW)};
/** C R A C K I. */
export const LETTERS = "${LETTERS}";
/** The O: its outline, and its counter (the hole the film shows through). */
export const O = "${O}";
export const O_OUTLINE = "${O_OUTLINE}";
export const COUNTER = "${COUNTER}";
/** Right of the counter's middle: with the O's outline, where the film may show. */
export const FRONT = "${FRONT}";
/** The film, its lit top edge and shaded bottom edge, its sprocket holes and its frames. */
export const STRIP = "${STRIP}";
export const EDGE_HI = "${EDGE_HI}";
export const EDGE_LO = "${EDGE_LO}";
export const PERFS = "${perfs.join("")}";
export const FRAMES = ${JSON.stringify(FRAMES)};
/** Where the film comes out of the dark of the O, along x. */
export const SHADE = [${r(or - 260)}, ${r(or + 380)}] as const;
/** The seam where the O passes over the film. */
export const GAP = ${FILM.gap};
/** How far the film feeds out when the logo is hovered. */
export const FEED = ${FILM.feed};
/** Cap height. */
export const CAP = ${CAP};
`;
await fs.writeFile(path.join(root, "src/components/brand/wordmark-art.ts"), art);

/* ------------------------------------------------------------------ the app icon */

// The mark on the graphite squircle the navigation icons sit on; the film runs off its edge.
const TILE = 1000;
const squircle = "M340 0H660C969 0 1000 31 1000 340V660C1000 969 969 1000 660 1000H340C31 1000 0 969 0 660V340C0 31 31 0 340 0Z";
// Center the O's counter a little left of the middle, a bit larger than the tile's half.
const scale = 0.98;
const tx = TILE * 0.42 - cx * scale;
const ty = TILE * 0.5 - cy * scale;
const g = `transform="translate(${r(tx)} ${r(ty)}) scale(${scale})"`;
const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${TILE} ${TILE}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3d3647"/><stop offset="1" stop-color="#221e28"/></linearGradient>
    <radialGradient id="sheen" cx="0.5" cy="0" r="0.75"><stop offset="0" stop-color="#fff" stop-opacity="0.18"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
    <clipPath id="tile"><path d="${squircle}"/></clipPath>
    <clipPath id="show"><path ${g} d="${O_OUTLINE}"/><path ${g} d="${FRONT}"/></clipPath>
    <mask id="seam" maskUnits="userSpaceOnUse" x="-2000" y="-2000" width="6000" height="6000">
      <rect x="-2000" y="-2000" width="6000" height="6000" fill="#fff"/>
      <path ${g} d="${O}" stroke="#000" stroke-width="${FILM.gap * 2}" stroke-linejoin="round"/>
    </mask>
    <mask id="perfs" maskUnits="userSpaceOnUse" x="-2000" y="-2000" width="6000" height="6000">
      <rect x="-2000" y="-2000" width="6000" height="6000" fill="#fff"/>
      <path ${g} d="${perfs.join("")}"/>
    </mask>
  </defs>
  <g clip-path="url(#tile)">
    <path d="${squircle}" fill="url(#bg)"/>
    <path d="${squircle}" fill="url(#sheen)"/>
    <g clip-path="url(#show)" mask="url(#seam)">
      <g mask="url(#perfs)"><path ${g} d="${STRIP}" fill="#ff5b2e"/><path ${g} d="${EDGE_HI}" fill="#fff" fill-opacity="0.28"/></g>
      <path ${g} d="${FRAMES.join("")}" fill="#2a0f06" fill-opacity="0.9"/>
    </g>
    <path ${g} d="${O}" fill="#f0efed"/>
  </g>
</svg>
`;
await fs.writeFile(path.join(root, "src/app/icon.svg"), icon);

const png = (size) => sharp(Buffer.from(icon), { density: (72 * size) / TILE * 4 }).resize(size, size).png().toBuffer();
await fs.writeFile(path.join(root, "src/app/apple-icon.png"), await png(180));
// An .ico is a small directory of PNGs.
const sizes = [16, 32, 48];
const images = await Promise.all(sizes.map(png));
const head = Buffer.alloc(6 + 16 * sizes.length);
head.writeUInt16LE(0, 0);
head.writeUInt16LE(1, 2);
head.writeUInt16LE(sizes.length, 4);
let offset = head.length;
sizes.forEach((size, k) => {
  const e = 6 + 16 * k;
  head.writeUInt8(size, e);
  head.writeUInt8(size, e + 1);
  head.writeUInt16LE(1, e + 4);
  head.writeUInt16LE(32, e + 6);
  head.writeUInt32LE(images[k].length, e + 8);
  head.writeUInt32LE(offset, e + 12);
  offset += images[k].length;
});
await fs.writeFile(path.join(root, "src/app/favicon.ico"), Buffer.concat([head, ...images]));

console.log(`wordmark ${VIEW.w}×${VIEW.h}, mark ${MARK_VIEW.w}×${MARK_VIEW.h}, ${perfs.length} perforations, ${FRAMES.length} frames, art ${(art.length / 1024).toFixed(1)} kB`);
