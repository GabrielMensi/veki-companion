// Genera placeholders inventados (degradados de la paleta) para el fixture. Uso: node scripts/make-fixture-images.mjs
import sharp from "sharp";
import { mkdirSync } from "node:fs";

const palette = { lila: ["#AC9FD6", "#d9d2ee"], verde: ["#C3D787", "#e4edc0"], celeste: ["#A3D3DD", "#d3eaf0"] };
const items = [
  ["m-01", "lila"], ["m-02", "verde"], ["m-03", "celeste"], ["m-04", "lila"],
  ["m-05", "verde"], ["m-06", "celeste"], ["m-07", "lila"], ["m-08", "verde"],
];
mkdirSync(new URL("../src/fixtures/img/", import.meta.url), { recursive: true });
for (const [id, tone] of items) {
  const [a, b] = palette[tone];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1200"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="1200" height="1200" fill="url(#g)"/><circle cx="600" cy="600" r="260" fill="#ffffff" fill-opacity=".45"/><text x="600" y="640" font-family="sans-serif" font-size="110" text-anchor="middle" fill="#2b2540" fill-opacity=".6">${id}</text></svg>`;
  await sharp(Buffer.from(svg)).png({ palette: true, colors: 32 }).toFile(new URL(`../src/fixtures/img/${id}.png`, import.meta.url).pathname);
}
