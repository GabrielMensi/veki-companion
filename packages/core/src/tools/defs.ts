import { z } from "zod";
import type { ToolDef } from "../providers/types";
import { draftCampos } from "../agent/draft";

/** Herramientas del agente, definidas una sola vez con zod (docs/02 §3.3). */

export const MAX_TEXTO = 350;
export const MAX_BOTONES = 6;
export const MAX_ETIQUETA = 24;

const id = z.string().min(1);
const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/);
const variante = z.object({
  design: z.string().optional(),
  size: z.string().optional(),
  color: z.string().optional(),
  price_ars: z.number().int().nonnegative().optional(),
  stock: z.number().int().nonnegative().optional(),
});

export const toolSchemas = {
  responder: z.object({
    texto: z.string().min(1).max(MAX_TEXTO),
    botones: z
      .array(z.object({ etiqueta: z.string().min(1).max(MAX_ETIQUETA), valor: z.string().min(1) }))
      .max(MAX_BOTONES)
      .optional(),
  }),
  buscar_productos: z.object({ consulta: z.string().min(1) }),
  ver_producto: z.object({ producto_id: id }),
  ver_agenda: z.object({ desde: fecha.optional(), hasta: fecha.optional() }),
  ver_contenido: z.object({}),
  actualizar_borrador: z.object({
    tipo: z.enum(["producto", "feria"]),
    campos: draftCampos.optional(),
    media_ids: z.array(id).optional(),
  }),
  crear_producto: z.object({}),
  editar_producto: z.object({
    producto_id: id,
    cambios: z.object({
      name: z.string().min(1).optional(),
      price_ars: z.number().int().nonnegative().optional(),
      description: z.string().optional(),
      category: z.string().min(1).optional(),
      status: z.enum(["active", "hidden"]).optional(),
    }),
  }),
  editar_variantes: z.object({
    producto_id: id,
    agregar: z.array(variante).optional(),
    archivar: z.array(id).optional(),
  }),
  cambiar_stock: z.object({
    variante_id: id,
    delta: z.number().int().optional(),
    fijar: z.number().int().nonnegative().optional(),
    motivo: z.enum(["venta", "reposicion", "ajuste"]),
  }),
  agregar_fotos: z.object({ producto_id: id, media_ids: z.array(id).min(1), portada: id.optional() }),
  crear_feria: z.object({
    nombre: z.string().min(1),
    lugar: z.string().min(1),
    direccion: z.string().optional(),
    inicio: fecha,
    fin: fecha,
  }),
  editar_feria: z.object({
    feria_id: id,
    cambios: z.object({
      nombre: z.string().optional(),
      lugar: z.string().optional(),
      direccion: z.string().optional(),
      inicio: fecha.optional(),
      fin: fecha.optional(),
    }),
  }),
  cancelar_feria: z.object({ feria_id: id }),
  pedir_contenido: z.object({
    tipo: z.enum(["flyer", "carrusel", "reel"]),
    plantilla: z.enum(["producto", "feria", "novedad"]),
    producto_id: id.optional(),
    feria_id: id.optional(),
    media_ids: z.array(id).optional(),
  }),
  posponer_aviso: z.object({ tipo_aviso: z.string().min(1), hasta: z.enum(["en_3h", "manana", "nunca"]) }),
  /** El ejecutor acepta un id (comando de admin, botones); al modelo NO se le muestra: `modelParameters` lo oculta. */
  deshacer: z.object({ accion_id: id.optional() }),
} as const;

export type ToolName = keyof typeof toolSchemas;
export type ToolArgs<N extends ToolName> = z.infer<(typeof toolSchemas)[N]>;

export type ToolKind = "speak" | "read" | "draft" | "write";

export const toolKinds: Record<ToolName, ToolKind> = {
  responder: "speak",
  buscar_productos: "read",
  ver_producto: "read",
  ver_agenda: "read",
  ver_contenido: "read",
  actualizar_borrador: "draft",
  crear_producto: "write",
  editar_producto: "write",
  editar_variantes: "write",
  cambiar_stock: "write",
  agregar_fotos: "write",
  crear_feria: "write",
  editar_feria: "write",
  cancelar_feria: "write",
  pedir_contenido: "write",
  posponer_aviso: "write",
  deshacer: "write",
};

/** Descripciones cortas a propósito: cada token cuenta (presupuesto ≤ 2.500 con el system prompt). */
const descriptions: Record<ToolName, string> = {
  responder: "Único modo de hablarle a la usuaria. Solo para preguntar lo que falta o contestar; si pidió guardar o cambiar algo, llamá antes la herramienta que corresponde.",
  buscar_productos: "Busca productos por nombre, diseño o color. Devuelve ids de producto y de variante. Obligatoria antes de editar o tocar stock.",
  ver_producto: "Ficha de un producto: variantes, stock, fotos.",
  ver_agenda: "Ferias de un rango (por defecto, próximos 30 días).",
  ver_contenido: "Estado de los flyers/reels en curso.",
  actualizar_borrador: "Obligatoria cuando manda fotos o cuenta datos de un producto o feria nuevos (nombre, precio, categoría, fechas). Guarda lo que dijo; no escribe en el catálogo.",
  crear_producto: "Obligatoria cuando el borrador está completo: arma la vista previa para que ella confirme.",
  editar_producto: "Cambia nombre, precio, descripción, categoría o estado de un producto (pide confirmación). Usá el id de buscar_productos.",
  editar_variantes: "Agrega o archiva variantes (pide confirmación).",
  cambiar_stock: "Ventas, reposición o ajuste de stock de una variante (pide confirmación). Venta: delta negativo, motivo venta. Usá el id de variante de buscar_productos.",
  agregar_fotos: "Suma fotos a un producto.",
  crear_feria: "Crea una feria. Fechas hora Argentina.",
  editar_feria: "Cambia datos de una feria.",
  cancelar_feria: "Cancela una feria.",
  pedir_contenido: "Encarga un flyer, carrusel o reel.",
  posponer_aviso: "Pospone o apaga un aviso.",
  deshacer: "Obligatoria cuando pide deshacer, volver atrás o anular. No lleva argumentos: deshace la última acción.",
};

export const READ_TOOLS = (Object.keys(toolKinds) as ToolName[]).filter((n) => toolKinds[n] === "read");

/** JSON Schema sin `$schema` ni `additionalProperties` (ahorra tokens; igual validamos con zod al recibir). */
function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v).filter(([k]) => k !== "$schema" && k !== "additionalProperties").map(([k, x]) => [k, strip(x)]),
      );
    }
    return v;
  };
  return strip(z.toJSONSchema(schema)) as Record<string, unknown>;
}

/** Definiciones en el formato neutro de T13 (`ToolDef`); los proveedores las envuelven a su formato. */
export const toolDefs: ToolDef[] = (Object.keys(toolSchemas) as ToolName[]).map((name) => ({
  name,
  description: descriptions[name],
  parameters: name === "deshacer" ? { type: "object", properties: {} } : jsonSchema(toolSchemas[name]),
}));
