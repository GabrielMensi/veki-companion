import fixture from "../fixtures/catalog.fixture.json";
import { catalogSchema, type Catalog, type Product } from "./catalog-schema";

/** Valida o falla: no se publica un sitio vacío por un catálogo roto (§5.4). */
export function parseCatalog(raw: unknown, source: string): Catalog {
  const result = catalogSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join(".") || "(raíz)"}: ${i.message}`).join("\n");
    throw new Error(`El catálogo (${source}) no valida su schema:\n${issues}`);
  }
  return result.data;
}

export function catalogUrl(): string | null {
  return process.env.CATALOG_URL?.trim() || null;
}

let cached: Promise<Catalog> | undefined;

export function loadCatalog(): Promise<Catalog> {
  cached ??= (async () => {
    const url = catalogUrl();
    if (!url) return parseCatalog(fixture, "fixture");
    const res = await fetch(url);
    if (!res.ok) throw new Error(`GET ${url} respondió ${res.status}`);
    return parseCatalog(await res.json(), url);
  })();
  return cached;
}

/** Destacados primero, luego los más recientes. */
export function sortProducts(products: Product[]): Product[] {
  return [...products].sort((a, b) => Number(b.featured) - Number(a.featured) || b.updated_at - a.updated_at);
}

export function sortedMedia(p: Product) {
  return [...p.media].sort((a, b) => a.position - b.position);
}

export function upcomingFairs(catalog: Catalog, now = Date.now()) {
  return catalog.fairs.filter((f) => f.ends_at >= now).sort((a, b) => a.starts_at - b.starts_at);
}
