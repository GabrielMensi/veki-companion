import { formatPrice, searchProducts, type SearchItem, type ToolHost, type ToolName } from "@veki/core";
import type { D1DatabaseLike } from "../env";

type ProductRow = { id: string; slug: string; name: string; category: string; description: string | null; price_ars: number | null; status: string };
type VariantRow = { id: string; product_id: string; design: string; size: string; color: string; price_ars: number | null; stock: number | null };

const MAX_RESULTS = 8;

const variantView = (v: VariantRow) => ({
  id: v.id,
  diseno: v.design,
  talle: v.size,
  color: v.color,
  precio: v.price_ars === null ? undefined : formatPrice(v.price_ars),
  stock: v.stock, // null = no sabe / a pedido
});

async function activeVariants(db: D1DatabaseLike, productId?: string): Promise<VariantRow[]> {
  const where = productId ? "AND product_id = ?" : "";
  const stmt = db.prepare(`SELECT id, product_id, design, size, color, price_ars, stock FROM variants WHERE status = 'active' ${where} ORDER BY updated_at, id`);
  return (await (productId ? stmt.bind(productId) : stmt).all<VariantRow>()).results;
}

/** `buscar_productos`: sin tildes ni mayúsculas, sobre productos activos u ocultos (no archivados ni borradores). */
export async function buscarProductos(db: D1DatabaseLike, consulta: string) {
  const products = (
    await db
      .prepare("SELECT id, slug, name, category, description, price_ars, status FROM products WHERE status IN ('active','hidden') ORDER BY updated_at DESC, id")
      .all<ProductRow>()
  ).results;
  const variants = await activeVariants(db);
  const items: (SearchItem & { row: ProductRow; vs: VariantRow[] })[] = products.map((row) => {
    const vs = variants.filter((v) => v.product_id === row.id);
    return { id: row.id, name: row.name, category: row.category, variants: vs, row, vs };
  });
  return searchProducts(consulta, items, MAX_RESULTS).map((i) => ({
    id: i.id,
    nombre: i.row.name,
    categoria: i.row.category,
    precio: formatPrice(i.row.price_ars),
    estado: i.row.status,
    variantes: i.vs.map(variantView),
  }));
}

/** `ver_producto`: ficha con variantes activas, stock y fotos (en orden de portada). `null` si no existe. */
export async function verProducto(db: D1DatabaseLike, productoId: string) {
  const p = await db
    .prepare("SELECT id, slug, name, category, description, price_ars, status FROM products WHERE id = ?")
    .bind(productoId)
    .first<ProductRow>();
  if (!p) return null;
  const fotos = (
    await db
      .prepare("SELECT id, kind, position FROM media WHERE product_id = ? AND status = 'attached' ORDER BY position, id")
      .bind(productoId)
      .all<{ id: string; kind: string; position: number | null }>()
  ).results;
  return {
    id: p.id,
    nombre: p.name,
    categoria: p.category,
    descripcion: p.description,
    precio: formatPrice(p.price_ars),
    estado: p.status,
    variantes: (await activeVariants(db, productoId)).map(variantView),
    fotos: fotos.map((f) => ({ id: f.id, tipo: f.kind, posicion: f.position })),
  };
}

/** Lecturas del `ToolHost` que le tocan al catálogo. Las otras (`ver_agenda`, `ver_contenido`) las agregan sus tareas. */
export function catalogRead(db: D1DatabaseLike): NonNullable<ToolHost["read"]> {
  return async (name: ToolName, args: Record<string, unknown>) => {
    if (name === "buscar_productos") {
      const found = await buscarProductos(db, String(args.consulta ?? ""));
      return found.length ? found : "No encontré productos con eso.";
    }
    if (name === "ver_producto") return (await verProducto(db, String(args.producto_id ?? ""))) ?? "No encuentro ese producto.";
    return "Esa consulta todavía no está disponible.";
  };
}
