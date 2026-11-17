// Runtime-agnostic flyer renderer: Satori (JSX-less element tree) -> SVG -> resvg-wasm -> PNG.
// Only uses WebAssembly + typed arrays, so the same code runs in Node and in Cloudflare Workers.
import satori, { init as initSatori } from "satori/standalone";
import { Resvg, initWasm as initResvg } from "@resvg/resvg-wasm";
import { BRAND } from "./brand.js";

export interface FlyerDeps {
  yogaWasm: WebAssembly.Module; // satori/layout.wasm
  resvgWasm: WebAssembly.Module; // @resvg/resvg-wasm/index_bg.wasm
  fonts: { regular: ArrayBuffer; bold: ArrayBuffer };
}

export interface FlyerInput {
  width: number;
  height: number;
  title: string;
  price: string;
  cta: string;
  bg?: string; // optional background override (used for reel stills)
}

let ready: Promise<void> | undefined;
export function initFlyer(deps: FlyerDeps): Promise<void> {
  ready ??= (async () => {
    await initSatori(deps.yogaWasm);
    await initResvg(deps.resvgWasm);
  })();
  return ready;
}

/** Synthetic product placeholder (no real photo): brand-colored bag-like shapes as an SVG data URI. */
function productSvg(size: number): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 400 400">
<rect width="400" height="400" fill="${BRAND.celeste}"/>
<circle cx="330" cy="70" r="48" fill="${BRAND.verde}"/>
<path d="M130 150 Q200 40 270 150" fill="none" stroke="${BRAND.ink}" stroke-width="12" stroke-linecap="round"/>
<rect x="90" y="140" width="220" height="190" rx="36" fill="${BRAND.lila}"/>
<rect x="90" y="140" width="220" height="60" rx="30" fill="${BRAND.verde}"/>
<circle cx="200" cy="255" r="26" fill="${BRAND.white}"/>
</svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

export async function renderFlyer(deps: FlyerDeps, input: FlyerInput): Promise<Uint8Array> {
  await initFlyer(deps);
  const { width, height } = input;
  const pad = 72;
  const img = width - pad * 2;
  const tree = {
    type: "div",
    props: {
      style: {
        width, height, boxSizing: "border-box", display: "flex", flexDirection: "column", alignItems: "center",
        justifyContent: "space-between", background: input.bg ?? BRAND.lila, padding: pad,
        fontFamily: BRAND.font, color: BRAND.ink,
      },
      children: [
        { type: "div", props: { style: { display: "flex", fontSize: 84, fontWeight: 700, color: BRAND.white }, children: BRAND.name } },
        { type: "img", props: { src: productSvg(img), width: img, height: img, style: { boxSizing: "border-box", borderRadius: 48, border: `10px solid ${BRAND.white}` } } },
        {
          type: "div",
          props: {
            style: { display: "flex", flexDirection: "column", alignItems: "center" },
            children: [
              { type: "div", props: { style: { display: "flex", fontSize: 72, fontWeight: 700, textAlign: "center" }, children: input.title } },
              { type: "div", props: { style: { display: "flex", fontSize: 96, fontWeight: 700, color: BRAND.white, marginTop: 8 }, children: input.price } },
            ],
          },
        },
        {
          type: "div",
          props: {
            style: { display: "flex", background: BRAND.verde, borderRadius: 80, padding: "28px 64px", fontSize: 48, fontWeight: 700 },
            children: input.cta,
          },
        },
      ],
    },
  };
  const svg = await satori(tree as never, {
    width, height,
    fonts: [
      { name: BRAND.font, data: deps.fonts.regular, weight: 400, style: "normal" },
      { name: BRAND.font, data: deps.fonts.bold, weight: 700, style: "normal" },
    ],
  });
  const resvg = new Resvg(svg, { fitTo: { mode: "width", value: width } });
  const png = resvg.render().asPng();
  resvg.free();
  return png;
}
