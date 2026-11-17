// Generates ONLY synthetic inputs for the reel: 5 brand-colored stills (Satori+resvg) and 1 short clip (ffmpeg lavfi).
import { mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { renderFlyer } from "./flyer.js";
import { loadDeps } from "./deps.js";
import { BRAND } from "./brand.js";

const dir = "out/assets";
await mkdir(dir, { recursive: true });
const deps = await loadDeps();
const looks = [
  { title: "Carteras", bg: BRAND.lila },
  { title: "Riñoneras", bg: BRAND.celeste },
  { title: "Neceseres", bg: BRAND.verde },
  { title: "Colores", bg: BRAND.lila },
  { title: "Únicos", bg: BRAND.celeste },
];
// 1.2x oversized stills so the Ken Burns zoom keeps full resolution.
for (const [i, l] of looks.entries()) {
  const png = await renderFlyer(deps, { width: 1296, height: 2304, title: l.title, price: "$12.500", cta: "Consultá por WhatsApp", bg: l.bg });
  await writeFile(`${dir}/still-${i + 1}.png`, png);
}
const r = spawnSync("ffmpeg", [
  "-y", "-loglevel", "error",
  "-f", "lavfi", "-i", "testsrc2=size=1080x1920:rate=30:duration=4",
  "-c:v", "libx264", "-pix_fmt", "yuv420p", `${dir}/clip-1.mp4`,
], { stdio: "inherit" });
if (r.status !== 0) throw new Error(`ffmpeg clip generation failed: ${r.error ?? r.status}`);
console.log(`assets written to ${dir}`);
