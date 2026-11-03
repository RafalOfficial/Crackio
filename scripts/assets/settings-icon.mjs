// Draws the "settings" sidebar glyph (public/icons/settings.png) in code: a solid gear with rounded teeth and a round
// hole, white on transparent, 256 px, matching the traced glyphs icons.mjs makes. Usage: node scripts/assets/settings-icon.mjs
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const sharp = createRequire(import.meta.url)("sharp");
const S = 1024, c = S / 2;
const teeth = 8, rOut = 0.405 * S, rIn = 0.322 * S, rHole = 0.135 * S;
const pts = [];
for (let i = 0; i < teeth; i++) {
  const a0 = (i / teeth) * 2 * Math.PI - Math.PI / 2;
  const w = (2 * Math.PI) / teeth;
  // tooth: flat top ~38% of the pitch, flanks slightly tapered
  const seq = [
    [a0 - w * 0.5, rIn],
    [a0 - w * 0.22, rIn],
    [a0 - w * 0.16, rOut],
    [a0 + w * 0.16, rOut],
    [a0 + w * 0.22, rIn],
  ];
  for (const [a, r] of seq) pts.push([c + r * Math.cos(a), c + r * Math.sin(a)]);
}
const d = "M" + pts.map((p) => p.map((v) => v.toFixed(1)).join(",")).join("L") + "Z";
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
<defs><mask id="m"><rect width="${S}" height="${S}" fill="white"/><circle cx="${c}" cy="${c}" r="${rHole}" fill="black"/></mask></defs>
<g mask="url(#m)"><path d="${d}" fill="#fff" stroke="#fff" stroke-width="${0.045 * S}" stroke-linejoin="round"/><circle cx="${c}" cy="${c}" r="${rIn + 2}" fill="#fff"/></g>
</svg>`;
const out = process.argv[2] ?? fileURLToPath(new URL("../../public/icons/settings.png", import.meta.url));
await sharp(Buffer.from(svg)).resize(256, 256, { kernel: "lanczos3" }).png().toFile(out);
console.log("wrote", out);
