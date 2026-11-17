// Cloudflare Worker entry used ONLY to measure bundle size via `wrangler deploy --dry-run`.
// Never deployed (no Cloudflare account in this spike).
import yogaWasm from "satori/layout.wasm";
import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm";
import regular from "../node_modules/@expo-google-fonts/poppins/400Regular/Poppins_400Regular.ttf";
import bold from "../node_modules/@expo-google-fonts/poppins/700Bold/Poppins_700Bold.ttf";
import { renderFlyer } from "./flyer.js";

export default {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const story = url.searchParams.get("size") === "story";
    const png = await renderFlyer(
      { yogaWasm, resvgWasm, fonts: { regular, bold } },
      {
        width: 1080, height: story ? 1920 : 1350,
        title: "Riñonera Floral", price: "$12.500", cta: "Consultá por WhatsApp",
      },
    );
    return new Response(png as unknown as BodyInit, { headers: { "content-type": "image/png" } });
  },
};
