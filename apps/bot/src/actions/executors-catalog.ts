import { copyAcciones, copyCatalogo, draftSchema, nextMissingField, normalizeText, priceToColumn, slugify, toolSchemas, uniqueSlug, ulid, type ToolName } from "@veki/core";
import type { D1DatabaseLike, D1PreparedStatementLike } from "../env";
import { ActionError, registerExecutor, type Executor } from "./executors";
import { eventStmt } from "./pending";
import type { Op } from "./undo";

type Row = Record<string, unknown>;

const snapshot = (db: D1DatabaseLike, table: "products" | "variants" | "media", id: string) =>
  db.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first<Row>();

const parse = <N extends ToolName>(name: N, args: unknown) => {
  const r = toolSchemas[name].safeParse(args);
  if (!r.success) throw new ActionError(copyAcciones.faltaCambio);
  return r.data as import("zod").infer<(typeof toolSchemas)[N]>;
};

/** Upsert de una fila completa de `variants` (alta o cambio). */
function upsertVariant(db: D1DatabaseLike, v: Row): D1PreparedStatementLike {
  return db
    .prepare(
      "INSERT INTO variants (id, product_id, design, size, color, price_ars, stock, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET design = excluded.design, size = excluded.size, color = excluded.color, price_ars = excluded.price_ars, stock = excluded.stock, status = excluded.status, updated_at = excluded.updated_at",
    )
    .bind(v.id, v.product_id, v.design, v.size, v.color, v.price_ars, v.stock, v.status, v.updated_at);
}

const attachStmt = (db: D1DatabaseLike, mediaId: string, productId: string, position: number) =>
  db.prepare("UPDATE media SET product_id = ?, position = ?, status = 'attached' WHERE id = ?").bind(productId, position, mediaId);

// ── crear_producto ──────────────────────────────────────────────────────────
/** Alta desde el borrador completo: producto + variante por defecto + fotos `attached` (portada = posición 0). */
const crearProducto: Executor = async ({ db, args, now, action }) => {
  const parsed = draftSchema.safeParse((args as { draft?: unknown } | null)?.draft);
  if (!parsed.success || parsed.data.tipo !== "producto" || nextMissingField(parsed.data) !== null) {
    throw new ActionError(copyCatalogo.borradorIncompleto);
  }
  const { campos: c, media_ids } = parsed.data;
  const name = c.name!;

  const photos: Row[] = [];
  for (const mid of media_ids) {
    const m = await snapshot(db, "media", mid);
    if (!m || m.status !== "inbox") throw new ActionError(copyCatalogo.fotoNoDisponible);
    photos.push(m);
  }

  const base = slugify(name);
  const taken = (await db.prepare("SELECT slug FROM products WHERE slug = ? OR slug LIKE ?").bind(base, `${base}-%`).all<{ slug: string }>()).results;
  const slug = uniqueSlug(base, taken.map((t) => t.slug));

  // Id derivado de la acción (se fija al crearla, docs/02 §3.1.6).
  const productId = action.id;
  const variantId = ulid(now);
  return {
    statements: [
      db
        .prepare(
          "INSERT INTO products (id, slug, name, category, description, price_ars, status, featured, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'active', 0, ?, ?)",
        )
        .bind(productId, slug, name, c.category!, c.description ?? null, priceToColumn(c.price_ars), now, now),
      // Variante por defecto: sin diseño, talle ni color; stock desconocido (NULL).
      upsertVariant(db, { id: variantId, product_id: productId, design: "", size: "", color: "", price_ars: null, stock: null, status: "active", updated_at: now }),
      ...photos.map((m, i) => attachStmt(db, String(m.id), productId, i)),
    ],
    // Las fotos primero: referencian al producto (clave foránea).
    inverse: [
      ...photos.map((m): Op => ({ op: "upsert", table: "media", row: m })),
      { op: "delete", table: "variants", id: variantId },
      { op: "delete", table: "products", id: productId },
    ],
    message: copyAcciones.productoCreado(name),
    public: true,
    entity: "product",
    entityId: productId,
  };
};

// ── editar_variantes ────────────────────────────────────────────────────────
const variantKey = (v: { design: unknown; size: unknown; color: unknown }) => [v.design, v.size, v.color].map((x) => normalizeText(String(x ?? ""))).join("|");
const DEFAULT_KEY = "||";

/**
 * Agrega o archiva variantes. Una variante igual (mismo diseño/talle/color, sin importar tildes ni mayúsculas) se
 * reactiva/actualiza en vez de duplicarse. La variante por defecto, cuando entran variantes con nombre, se archiva si no tiene stock
 * y, si tiene, se convierte en la primera variante nueva conservando su stock; y reaparece si se archivan todas (siempre queda al menos una activa).
 */
const editarVariantes: Executor = async ({ db, args, now }) => {
  const a = parse("editar_variantes", args);
  const product = await snapshot(db, "products", a.producto_id);
  if (!product) throw new ActionError(copyAcciones.noEncontre);
  if (!a.agregar?.length && !a.archivar?.length) throw new ActionError(copyAcciones.faltaCambio);

  const prev = (await db.prepare("SELECT * FROM variants WHERE product_id = ? ORDER BY updated_at, id").bind(a.producto_id).all<Row>()).results;
  const cur = new Map(prev.map((r) => [String(r.id), { ...r }]));
  const prevIds = new Set(cur.keys());
  const touched = new Set<string>();
  const findByKey = (k: string) => [...cur.values()].find((r) => variantKey(r as never) === k);

  for (const id of a.archivar ?? []) {
    const r = cur.get(id);
    if (!r) throw new ActionError(copyCatalogo.variantesMal);
    Object.assign(r, { status: "archived", updated_at: now });
    touched.add(id);
  }

  const explicit = new Set<string>();
  let firstNewNamed: string | null = null; // id de la primera variante con nombre que se crea de cero
  for (const v of a.agregar ?? []) {
    const norm = { design: v.design?.trim() ?? "", size: v.size?.trim() ?? "", color: v.color?.trim() ?? "" };
    const k = variantKey(norm);
    explicit.add(k);
    const found = findByKey(k);
    if (found) {
      Object.assign(found, { status: "active", updated_at: now });
      if (v.price_ars !== undefined) found.price_ars = v.price_ars;
      if (v.stock !== undefined) found.stock = v.stock;
      touched.add(String(found.id));
    } else {
      const id = ulid(now);
      cur.set(id, { id, product_id: a.producto_id, ...norm, price_ars: v.price_ars ?? null, stock: v.stock ?? null, status: "active", updated_at: now });
      touched.add(id);
      if (k !== DEFAULT_KEY) firstNewNamed ??= id;
    }
  }

  const archiveRow = (r: Row) => {
    Object.assign(r, { status: "archived", updated_at: now });
    touched.add(String(r.id));
  };
  const def = findByKey(DEFAULT_KEY);
  const namedActive = [...cur.values()].some((r) => r.status === "active" && variantKey(r as never) !== DEFAULT_KEY);
  if (def && def.status === "active" && namedActive && !explicit.has(DEFAULT_KEY)) {
    const stock = typeof def.stock === "number" ? def.stock : 0;
    if (stock === 0) archiveRow(def); // sin stock que perder
    else if (firstNewNamed) {
      // Nunca se esconde stock: la variante por defecto se convierte en la primera con nombre y conserva su stock.
      const named = cur.get(firstNewNamed)!;
      Object.assign(def, { design: named.design, size: named.size, color: named.color, price_ars: named.price_ars ?? def.price_ars, updated_at: now });
      cur.delete(firstNewNamed);
      touched.delete(firstNewNamed);
      touched.add(String(def.id));
    } // si todas las variantes pedidas ya existían, la de por defecto queda activa (no se esconde su stock)
  }

  if (![...cur.values()].some((r) => r.status === "active")) {
    if (def) {
      Object.assign(def, { status: "active", updated_at: now });
      touched.add(String(def.id));
    } else {
      const id = ulid(now);
      cur.set(id, { id, product_id: a.producto_id, design: "", size: "", color: "", price_ars: null, stock: null, status: "active", updated_at: now });
      touched.add(id);
    }
  }

  const changed = [...touched].map((id) => cur.get(id)!);
  return {
    statements: [
      ...changed.map((r) => upsertVariant(db, r)),
      db.prepare("UPDATE products SET updated_at = ? WHERE id = ?").bind(now, a.producto_id),
    ],
    inverse: [
      { op: "upsert", table: "products", row: product },
      ...[...touched].map((id): Op => (prevIds.has(id) ? { op: "upsert", table: "variants", row: prev.find((r) => r.id === id)! } : { op: "delete", table: "variants", id })),
    ],
    message: copyCatalogo.variantesActualizadas(String(product.name)),
    public: true,
    entity: "product",
    entityId: a.producto_id,
  };
};

// ── agregar_fotos ───────────────────────────────────────────────────────────
const byPosition = (x: Row, y: Row) => ((x.position as number | null) ?? 1e9) - ((y.position as number | null) ?? 1e9) || String(x.id).localeCompare(String(y.id));

/** Suma fotos `inbox` al final de las del producto; con `portada` esa foto pasa a la posición 0. */
const agregarFotos: Executor = async ({ db, args }) => {
  const a = parse("agregar_fotos", args);
  const product = await snapshot(db, "products", a.producto_id);
  if (!product) throw new ActionError(copyAcciones.noEncontre);

  const existing = (await db.prepare("SELECT * FROM media WHERE product_id = ? AND status = 'attached'").bind(a.producto_id).all<Row>()).results.sort(byPosition);
  const attached = new Set(existing.map((m) => String(m.id)));
  const fresh: Row[] = [];
  for (const mid of new Set(a.media_ids)) {
    if (attached.has(mid)) continue;
    const m = await snapshot(db, "media", mid);
    if (!m || m.status !== "inbox") throw new ActionError(copyCatalogo.fotoNoDisponible);
    fresh.push(m);
  }
  if (fresh.length === 0 && !a.portada) throw new ActionError(copyAcciones.faltaCambio);

  let order = [...existing, ...fresh];
  if (a.portada) {
    const cover = order.find((m) => m.id === a.portada);
    if (!cover) throw new ActionError(copyCatalogo.fotoNoDisponible);
    order = [cover, ...order.filter((m) => m !== cover)];
  }
  const touched = order.filter((m, i) => m.position !== i || m.status !== "attached" || m.product_id !== a.producto_id);
  const name = String(product.name);
  return {
    statements: order.flatMap((m, i) => (touched.includes(m) ? [attachStmt(db, String(m.id), a.producto_id, i)] : [])),
    inverse: touched.map((m): Op => ({ op: "upsert", table: "media", row: m })),
    message: fresh.length ? copyCatalogo.fotosAgregadas(name, fresh.length) : copyAcciones.productoEditado(name),
    public: true,
    entity: "product",
    entityId: a.producto_id,
  };
};

// ── pedir_contenido (Stage 3: todavía no existe) ────────────────────────────
/**
 * Los trabajos de contenido son de la etapa 3. Para que el "Sí" no quede mudo: deja un `event_log`, la acción queda
 * `cancelled` (ActionError, `execute.ts`) y se le contesta con `copyCatalogo.contenidoTodavia`. No hay nada que deshacer.
 */
const pedirContenido: Executor = async ({ db, args, now, action, actor }) => {
  const a = parse("pedir_contenido", args);
  await eventStmt(db, {
    now, actor, type: "content.not_available", entity: "pending_action", entityId: action.id,
    data: { tool: "pedir_contenido", tipo: a.tipo, plantilla: a.plantilla },
  }).run();
  throw new ActionError(copyCatalogo.contenidoTodavia);
};

// ── posponer_aviso (el motor de avisos es de la etapa 2, T33) ───────────────
const HORA = 3_600_000;
const DIA = 24 * HORA;
const AR_OFFSET = 3 * HORA; // Argentina = UTC-3, sin horario de verano

export const snoozeKey = (tipoAviso: string) => `snooze:${normalizeText(tipoAviso).replace(/ /g, "_")}`;

/** Cuándo termina la pausa: `null` = nunca más; "mañana" = 09:00 de Argentina del día siguiente. */
export function snoozeUntil(hasta: "en_3h" | "manana" | "nunca", now: number): number | null {
  if (hasta === "nunca") return null;
  if (hasta === "en_3h") return now + 3 * HORA;
  return Math.floor((now - AR_OFFSET) / DIA) * DIA + DIA + 9 * HORA + AR_OFFSET;
}

/**
 * Guarda la pausa en `settings` (`snooze:<tipo>` → `{until, hasta, action_id}`). `inverse` es `[]` porque `undo`
 * solo restaura catálogo y ferias: deshacer deja la acción `undone` y `activeSnooze` ya no la cuenta.
 */
const posponerAviso: Executor = async ({ db, args, now, action }) => {
  const a = parse("posponer_aviso", args);
  if (!normalizeText(a.tipo_aviso)) throw new ActionError(copyAcciones.faltaCambio);
  const key = snoozeKey(a.tipo_aviso);
  const value = JSON.stringify({ until: snoozeUntil(a.hasta, now), hasta: a.hasta, action_id: action.id });
  return {
    statements: [db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(key, value)],
    inverse: [],
    message: copyCatalogo.avisoAnotado,
    public: false,
    entity: "setting",
    entityId: key,
  };
};

/** ¿Ese tipo de aviso está pausado ahora? Lo usará el motor de avisos (T33). Una pausa deshecha no cuenta. */
export async function activeSnooze(db: D1DatabaseLike, tipoAviso: string, now: number): Promise<boolean> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(snoozeKey(tipoAviso)).first<{ value: string }>();
  if (!row) return false;
  let v: { until?: number | null; action_id?: string };
  try {
    v = JSON.parse(row.value) as typeof v;
  } catch {
    return false;
  }
  if (v.until !== null && (typeof v.until !== "number" || v.until <= now)) return false;
  if (!v.action_id) return false;
  const a = await db.prepare("SELECT status FROM pending_actions WHERE id = ?").bind(v.action_id).first<{ status: string }>();
  return a?.status === "executed";
}

export function registerCatalogExecutors(): void {
  registerExecutor("crear_producto", crearProducto);
  registerExecutor("editar_variantes", editarVariantes);
  registerExecutor("agregar_fotos", agregarFotos);
  registerExecutor("pedir_contenido", pedirContenido);
  registerExecutor("posponer_aviso", posponerAviso);
}

registerCatalogExecutors();
