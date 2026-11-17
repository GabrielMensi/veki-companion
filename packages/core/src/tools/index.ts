import { normalizeText } from "../catalog/search";
import { copy, copyResolucion, copyVistaPrevia, formatPrecio } from "../copy/es-AR";
import type { Draft } from "../agent/draft";
import { nextMissingField } from "../agent/draft";
import { MAX_BOTONES, toolKinds, toolSchemas, type ToolName } from "./defs";

export * from "./defs";

export type PendingActionInput = {
  chatId: number;
  tool: ToolName;
  /** Argumentos ya validados; para `crear_producto` es `{ draft }` con el borrador completo. */
  args: Record<string, unknown>;
  /** Vista previa en texto fijo (la mostrará T18 con los botones Sí / Cambiar / Cancelar). */
  preview: string;
  /** Acción anterior que queda `cancelled` (flujo "Cambiar"). */
  supersedes?: string;
};

/** Puerto con el que el agente toca el mundo. T18 implementa `createPendingAction`; T19 las lecturas. */
export interface ToolHost {
  createPendingAction(input: PendingActionInput): Promise<{ id: string }>;
  /** Lecturas (`buscar_productos`, `ver_producto`, `ver_agenda`, `ver_contenido`). Devuelven texto/JSON corto. */
  read?(name: ToolName, args: Record<string, unknown>): Promise<unknown>;
}

export type ToolOutcome =
  | { kind: "error"; message: string }
  | { kind: "result"; content: string }
  | { kind: "pending"; actionId: string; preview: string };

const draftLine = (d: Draft) => {
  const c = d.campos;
  return d.tipo === "producto"
    ? [
        "Te queda así 👇",
        `🧵 ${c.name} — ${formatPrecio(c.price_ars)}`,
        `Categoría: ${c.category}${c.description ? ` · ${c.description}` : ""}`,
        `Fotos: ${d.media_ids.length} (portada: la primera)`,
      ]
    : [
        "Te queda así 👇",
        `📅 ${c.name} — ${c.place}${c.address ? ` (${c.address})` : ""}`,
        `Desde ${c.starts_at} hasta ${c.ends_at}`,
      ];
};

/** Vista previa fija de una escritura (no la inventa el LLM). Nunca muestra ids ni JSON. */
export function previewFor(
  tool: ToolName,
  args: Record<string, unknown>,
  draft: Draft | null,
  producto: { nombre?: string; precioActual?: string } | null = null,
): string {
  if (tool === "crear_producto" && draft) return draftLine(draft).join("\n");
  if (tool === "editar_producto") return copyVistaPrevia.editarProducto(producto, (args.cambios ?? {}) as Parameters<typeof copyVistaPrevia.editarProducto>[1]);
  if (tool === "deshacer") return copyVistaPrevia.deshacer;
  return copyVistaPrevia.generica;
}

/** Nombre y precio de hoy del producto, para la vista previa. Si no se puede leer, la vista previa sale sin esos datos. */
async function productoActual(host: ToolHost, args: Record<string, unknown>) {
  try {
    const r = (await host.read?.("ver_producto", { producto_id: args.producto_id })) as { nombre?: unknown; precio?: unknown } | string | undefined;
    if (!r || typeof r === "string") return null;
    return {
      nombre: typeof r.nombre === "string" ? r.nombre : undefined,
      precioActual: typeof r.precio === "string" ? r.precio : undefined,
    };
  } catch {
    return null;
  }
}

type CatalogProductHit = {
  id: string;
  nombre: string;
  variantes?: { id: string; diseno?: string; talle?: string; color?: string; stock?: number | null }[];
};

const variantLabel = (v: NonNullable<CatalogProductHit["variantes"]>[number]) =>
  [v.diseno, v.talle, v.color].filter(Boolean).join(" ").trim() || "Única";

async function resolveProductByName(
  host: ToolHost,
  query: string,
): Promise<{ ok: true; product: CatalogProductHit } | { ok: false; outcome: ToolOutcome }> {
  if (!host.read) return { ok: false, outcome: { kind: "error", message: copyResolucion.productoNoEncontrado(query) } };
  const raw = await host.read("buscar_productos", { consulta: query });
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, outcome: { kind: "result", content: copyResolucion.productoNoEncontrado(query) } };
  }
  const hits = raw as CatalogProductHit[];
  if (hits.length === 1) return { ok: true, product: hits[0]! };
  const qNorm = normalizeText(query);
  const exact = hits.filter((h) => normalizeText(h.nombre) === qNorm);
  if (exact.length === 1) return { ok: true, product: exact[0]! };
  const opts = hits.slice(0, MAX_BOTONES).map((h) => h.nombre);
  return {
    ok: false,
    outcome: {
      kind: "result",
      content: `Varios productos coinciden con "${query}": ${opts.join(", ")}. Preguntale cuál es con responder usando botones (${opts.join(", ")}).`,
    },
  };
}

/** Resuelve `producto_id` / `variante_id` en el servidor cuando el modelo pasa nombres en lugar de ids. */
async function resolveWriteArgs(
  host: ToolHost,
  name: ToolName,
  args: Record<string, unknown>,
): Promise<{ ok: true; args: Record<string, unknown> } | { ok: false; outcome: ToolOutcome }> {
  if (name === "editar_producto") {
    if (typeof args.producto_id === "string" && args.producto_id) return { ok: true, args };
    const query = typeof args.producto === "string" ? args.producto.trim() : "";
    if (!query) return { ok: false, outcome: { kind: "error", message: copyResolucion.faltaProducto } };
    const res = await resolveProductByName(host, query);
    if (!res.ok) return res;
    return { ok: true, args: { ...args, producto_id: res.product.id } };
  }
  if (name === "cambiar_stock") {
    if (typeof args.variante_id === "string" && args.variante_id) return { ok: true, args };
    const prodQuery = typeof args.producto === "string" ? args.producto.trim() : "";
    const varQuery = typeof args.variante === "string" ? args.variante.trim() : "";
    const searchQuery = prodQuery || varQuery;
    if (!searchQuery) return { ok: false, outcome: { kind: "error", message: copyResolucion.faltaProducto } };
    const res = await resolveProductByName(host, searchQuery);
    if (!res.ok) return res;
    const prod = res.product;
    const variants = prod.variantes ?? [];
    if (variants.length === 0) {
      return { ok: false, outcome: { kind: "result", content: copyResolucion.sinVariantesActivas(prod.nombre) } };
    }
    if (!varQuery) {
      if (variants.length === 1) return { ok: true, args: { ...args, variante_id: variants[0]!.id } };
      const opts = variants.slice(0, MAX_BOTONES).map(variantLabel);
      return {
        ok: false,
        outcome: {
          kind: "result",
          content: `${prod.nombre} tiene varias variantes: ${opts.join(", ")}. Preguntale cuál es con responder usando botones (${opts.join(", ")}).`,
        },
      };
    }
    const words = normalizeText(varQuery).split(" ").filter(Boolean);
    const matched = variants.filter((v) => {
      const lbl = normalizeText(variantLabel(v));
      return words.every((w) => lbl.includes(w));
    });
    if (matched.length === 0) {
      return { ok: false, outcome: { kind: "result", content: copyResolucion.varianteNoEncontrada(varQuery, prod.nombre) } };
    }
    if (matched.length === 1) return { ok: true, args: { ...args, variante_id: matched[0]!.id } };
    const vNorm = normalizeText(varQuery);
    const exact = matched.filter((v) => normalizeText(variantLabel(v)) === vNorm);
    if (exact.length === 1) return { ok: true, args: { ...args, variante_id: exact[0]!.id } };
    const opts = matched.slice(0, MAX_BOTONES).map(variantLabel);
    return {
      ok: false,
      outcome: {
        kind: "result",
        content: `Varias variantes de ${prod.nombre} coinciden con "${varQuery}": ${opts.join(", ")}. Preguntale cuál es con responder usando botones (${opts.join(", ")}).`,
      },
    };
  }
  return { ok: true, args };
}

/**
 * Ejecuta una herramienta que NO es `responder` ni `actualizar_borrador` (esas las maneja el ciclo, porque
 * tocan el estado y la salida). Las de escritura nunca escriben: crean una `pending_action`.
 */
export async function runTool(
  host: ToolHost,
  ctx: { chatId: number; draft: Draft | null; awaitingActionId?: string },
  name: ToolName,
  rawArgs: unknown,
): Promise<ToolOutcome> {
  const parsed = toolSchemas[name].safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return { kind: "error", message: `Argumentos inválidos: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}` };
  }
  const args = parsed.data as Record<string, unknown>;
  const kind = toolKinds[name];

  if (kind === "read") {
    if (!host.read) return { kind: "error", message: "Esa consulta todavía no está disponible." };
    const out = await host.read(name, args);
    return { kind: "result", content: typeof out === "string" ? out : JSON.stringify(out) };
  }

  if (kind === "write") {
    const resolved = await resolveWriteArgs(host, name, args);
    if (!resolved.ok) return resolved.outcome;
    let toStore = resolved.args;
    if (name === "crear_producto") {
      if (!ctx.draft || ctx.draft.tipo !== "producto") return { kind: "error", message: "No hay borrador de producto. Usá actualizar_borrador primero." };
      const missing = nextMissingField(ctx.draft);
      if (missing) return { kind: "error", message: `Falta ${missing}: preguntale ${copy.campoFaltante[missing]}.` };
      toStore = { draft: ctx.draft };
    }
    const preview = previewFor(name, resolved.args, ctx.draft, name === "editar_producto" ? await productoActual(host, resolved.args) : null);
    const { id } = await host.createPendingAction({
      chatId: ctx.chatId,
      tool: name,
      args: toStore,
      preview,
      supersedes: ctx.awaitingActionId,
    });
    return { kind: "pending", actionId: id, preview };
  }

  return { kind: "error", message: "Herramienta no disponible." };
}
