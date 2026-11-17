import { availabilityFromStock, catalogSchema, categorySlug, type Catalog } from "@veki/core";

/** Mínimos estructurales de D1/R2 (los tipos de Workers no están instalados en el paquete). */
export interface D1Like {
  prepare(sql: string): {
    bind(...v: unknown[]): {
      all<T = unknown>(): Promise<{ results: T[] }>;
      first<T = unknown>(): Promise<T | null>;
      run(): Promise<{ meta?: { changes?: number } }>;
    };
  };
}
export interface R2Like {
  get(key: string): Promise<{ body: ReadableStream; httpEtag?: string } | null>;
}
export interface PublicEnv {
  DB: D1Like;
  MEDIA: R2Like;
}

export const MEDIA_CACHE_CONTROL = "public, max-age=31536000, immutable";
export const CATALOG_CACHE_CONTROL = "public, max-age=60";

const json = (body: unknown, status: number, cache = "no-store") =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": cache },
  });

async function setting<T>(db: D1Like, key: string, fallback: T): Promise<T> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

/** Arma el catálogo público: solo `active`, sin stock numérico, ferias públicas futuras. */
export async function buildCatalog(db: D1Like, now: number): Promise<Catalog> {
  const [products, variants, media, fairs, categories, whatsapp] = await Promise.all([
    db.prepare("SELECT id, slug, name, category, description, price_ars, featured, updated_at FROM products WHERE status = 'active' ORDER BY updated_at DESC").bind().all<any>(),
    db.prepare("SELECT v.id, v.product_id, v.design, v.size, v.color, v.price_ars, v.stock FROM variants v JOIN products p ON p.id = v.product_id WHERE p.status = 'active' AND v.status = 'active' ORDER BY v.design, v.size, v.color").bind().all<any>(),
    db.prepare("SELECT m.id, m.product_id, m.position, m.alt_text FROM media m JOIN products p ON p.id = m.product_id WHERE p.status = 'active' AND m.status = 'attached' AND m.kind = 'photo' ORDER BY m.position, m.created_at").bind().all<any>(),
    db.prepare("SELECT id, name, place, address, maps_url, starts_at, ends_at FROM fairs WHERE public = 1 AND status = 'confirmed' AND ends_at >= ? ORDER BY starts_at").bind(now).all<any>(),
    setting<string[]>(db, "categories", []),
    setting<string>(db, "whatsapp_number", ""),
  ]);

  const catalog = {
    generated_at: now,
    whatsapp_number: whatsapp,
    categories: categories.map((label) => ({ slug: categorySlug(label), label: label.charAt(0).toUpperCase() + label.slice(1) })),
    products: products.results.map((p) => ({
      id: p.id, slug: p.slug, name: p.name, category: categorySlug(p.category), description: p.description,
      price_ars: p.price_ars, featured: p.featured === 1, updated_at: p.updated_at,
      variants: variants.results.filter((v) => v.product_id === p.id).map((v) => ({
        id: v.id, design: v.design, size: v.size, color: v.color, price_ars: v.price_ars,
        availability: availabilityFromStock(v.stock),
      })),
      media: media.results.filter((m) => m.product_id === p.id).map((m, i) => ({
        id: m.id, position: m.position ?? i, alt_text: m.alt_text?.trim() || p.name,
      })),
    })),
    fairs: fairs.results,
  };
  // Valida lo que emite: si no cumple el contrato, el build del sitio no debe recibirlo.
  return catalogSchema.parse(catalog);
}

/** Foto servible: adjunta a un producto `active` (si está oculto, 404). */
export async function findPublicMedia(db: D1Like, id: string) {
  return db
    .prepare("SELECT m.r2_key, m.mime FROM media m JOIN products p ON p.id = m.product_id WHERE m.id = ? AND m.status = 'attached' AND m.kind = 'photo' AND p.status = 'active'")
    .bind(id)
    .first<{ r2_key: string; mime: string }>();
}

/** Rutas `/public/*`. Devuelve null si el path no es público (lo atiende otro handler). */
export async function handlePublic(request: Request, env: PublicEnv, now = Date.now()): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/public/")) return null;
  if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "method_not_allowed" }, 405);

  if (url.pathname === "/public/catalog.json") {
    try {
      return json(await buildCatalog(env.DB, now), 200, CATALOG_CACHE_CONTROL);
    } catch {
      // Contrato roto o sin número de WhatsApp todavía: que el build falle en vez de publicar un sitio incompleto.
      return json({ error: "catalog_unavailable" }, 503);
    }
  }

  const m = /^\/public\/media\/([A-Za-z0-9_-]{1,64})$/.exec(url.pathname);
  if (m) {
    const row = await findPublicMedia(env.DB, m[1]!);
    const obj = row ? await env.MEDIA.get(row.r2_key) : null;
    if (!row || !obj) return json({ error: "not_found" }, 404);
    const headers: Record<string, string> = { "content-type": row.mime, "cache-control": MEDIA_CACHE_CONTROL };
    if (obj.httpEtag) headers.etag = obj.httpEtag;
    return new Response(request.method === "HEAD" ? null : obj.body, { status: 200, headers });
  }
  return json({ error: "not_found" }, 404);
}

/** Toda escritura que cambia lo público llama a esto (docs/02 §5.4). Conserva el primer instante sucio. */
export async function markSiteDirty(db: D1Like, now = Date.now()): Promise<void> {
  await db
    .prepare("INSERT INTO site_state (id, dirty_since) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET dirty_since = COALESCE(dirty_since, excluded.dirty_since)")
    .bind(now)
    .run();
}


