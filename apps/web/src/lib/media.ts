import type { ImageMetadata } from "astro";
import { catalogUrl } from "./catalog";

const local = import.meta.glob<{ default: ImageMetadata }>("../fixtures/img/*.{png,jpg,webp}", { eager: true });

/**
 * Con CATALOG_URL, la foto se pide al Worker (`/public/media/{id}`) y astro:assets la procesa.
 * Sin CATALOG_URL (fixture), se busca `fixtures/img/{id}.png|jpg|webp`.
 */
export function mediaSrc(id: string): ImageMetadata | string {
  const url = catalogUrl();
  if (url) return new URL(`media/${id}`, url).href;
  const hit = Object.entries(local).find(([path]) => path.replace(/^.*\//, "").replace(/\.\w+$/, "") === id);
  if (!hit) throw new Error(`Fixture sin imagen para media "${id}" (src/fixtures/img/)`);
  return hit[1].default;
}
