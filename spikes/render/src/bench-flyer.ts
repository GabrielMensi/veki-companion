// Flyer benchmark in Node. process.cpuUsage() is only a PROXY for Workers CPU time.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { renderFlyer, type FlyerDeps } from "./flyer.js";
import { SIZES } from "./brand.js";

const require = createRequire(import.meta.url);
const read = (p: string) => readFile(require.resolve(p));
const ab = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

const cpuMs = (a: NodeJS.CpuUsage, b: NodeJS.CpuUsage) => (b.user - a.user + b.system - a.system) / 1000;

async function timed<T>(fn: () => Promise<T>) {
  const c0 = process.cpuUsage();
  const t0 = performance.now();
  const out = await fn();
  return { out, cpu: cpuMs(c0, process.cpuUsage()), wall: performance.now() - t0 };
}

await mkdir("out", { recursive: true });
const init = await timed(async (): Promise<FlyerDeps> => ({
  yogaWasm: await WebAssembly.compile(await read("satori/layout.wasm")),
  resvgWasm: await WebAssembly.compile(await read("@resvg/resvg-wasm/index_bg.wasm")),
  fonts: {
    regular: ab(await read("@expo-google-fonts/poppins/400Regular/Poppins_400Regular.ttf")),
    bold: ab(await read("@expo-google-fonts/poppins/700Bold/Poppins_700Bold.ttf")),
  },
}));
const deps = init.out;
console.log(`load wasm+fonts (Node fs, compile): cpu=${init.cpu.toFixed(1)}ms wall=${init.wall.toFixed(1)}ms`);

const base = { title: "Riñonera Floral", price: "$12.500", cta: "Consultá por WhatsApp" };
const WARM_RUNS = 20;
for (const [name, size] of Object.entries(SIZES)) {
  const runs: { cpu: number; wall: number }[] = [];
  let png: Uint8Array = new Uint8Array();
  for (let i = 0; i < WARM_RUNS + 1; i++) {
    const r = await timed(() => renderFlyer(deps, { ...size, ...base }));
    png = r.out;
    runs.push(r);
  }
  await writeFile(`out/flyer-${size.width}x${size.height}.png`, png);
  const [cold, ...warm] = runs;
  const sorted = warm.map((r) => r.cpu).sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)]!;
  console.log(
    `${name} ${size.width}x${size.height}: first-render(incl. satori+resvg init for 1st size) cpu=${cold!.cpu.toFixed(1)}ms wall=${cold!.wall.toFixed(1)}ms | warm median cpu=${med.toFixed(1)}ms min=${sorted[0]!.toFixed(1)} max=${sorted.at(-1)!.toFixed(1)} (n=${WARM_RUNS}) | png=${(png.length / 1024).toFixed(0)}KB`,
  );
}
