import type { APIRoute } from "astro";
import { loadCatalog } from "../lib/catalog";

export const GET: APIRoute = async ({ site }) => {
  const catalog = await loadCatalog();
  const paths = ["/", "/catalogo/", "/agenda/", ...catalog.products.map((p) => `/p/${p.slug}/`)];
  const urls = paths.map((p) => `  <url><loc>${new URL(p, site).href}</loc></url>`).join("\n");
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
  return new Response(body, { headers: { "Content-Type": "application/xml; charset=utf-8" } });
};
