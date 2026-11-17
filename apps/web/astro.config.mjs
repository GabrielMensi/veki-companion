import { defineConfig } from "astro/config";

// Sitio estático (docs/02-diseno.md §5). SITE_URL se define en el build de Pages.
export default defineConfig({
  site: process.env.SITE_URL ?? "https://veky.pages.dev",
  output: "static",
  trailingSlash: "always",
  build: { format: "directory" },
  image: {
    // En producción las fotos vienen del Worker (https). En local, de un Worker en localhost.
    remotePatterns: [{ protocol: "https" }, { protocol: "http", hostname: "localhost" }],
  },
});
