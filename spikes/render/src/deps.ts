// Node-side loader for the flyer dependencies (Workers get them through wrangler module rules instead).
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import type { FlyerDeps } from "./flyer.js";

const require = createRequire(import.meta.url);
export const resolveAsset = (p: string) => require.resolve(p);
const read = (p: string) => readFile(resolveAsset(p));
const ab = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

export const FONT_BOLD = "@expo-google-fonts/poppins/700Bold/Poppins_700Bold.ttf";
export const FONT_REGULAR = "@expo-google-fonts/poppins/400Regular/Poppins_400Regular.ttf";

export async function loadDeps(): Promise<FlyerDeps> {
  return {
    yogaWasm: await WebAssembly.compile(await read("satori/layout.wasm")),
    resvgWasm: await WebAssembly.compile(await read("@resvg/resvg-wasm/index_bg.wasm")),
    fonts: { regular: ab(await read(FONT_REGULAR)), bold: ab(await read(FONT_BOLD)) },
  };
}
