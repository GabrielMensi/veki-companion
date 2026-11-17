import { z } from "zod";

const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/); // hora de Argentina (UTC-3)

/** Campos del borrador que el LLM puede completar (todos opcionales). */
export const draftCampos = z
  .object({
    name: z.string().min(1).max(80),
    price_ars: z.union([z.number().int().nonnegative(), z.literal("consultar")]),
    category: z.string().min(1).max(40),
    description: z.string().max(500),
    place: z.string().min(1).max(80),
    address: z.string().max(120),
    starts_at: fecha,
    ends_at: fecha,
  })
  .partial();
export type DraftCampos = z.infer<typeof draftCampos>;

export const draftSchema = z.object({
  tipo: z.enum(["producto", "feria"]),
  campos: draftCampos,
  media_ids: z.array(z.string()),
});
export type Draft = z.infer<typeof draftSchema>;

/** Campos requeridos por tipo, en el orden en que se preguntan (docs/02 §3.1.3). */
const REQUIRED = {
  producto: ["name", "price_ars", "category", "media_ids"],
  feria: ["name", "place", "starts_at", "ends_at"],
} as const;

export type MissingField = (typeof REQUIRED)[keyof typeof REQUIRED][number];

/** Siguiente campo que falta, o `null` si el borrador está completo. Lo decide el código, no el modelo. */
export function nextMissingField(draft: Draft | null | undefined): MissingField | null {
  if (!draft) return null;
  for (const f of REQUIRED[draft.tipo]) {
    if (f === "media_ids") {
      if (draft.media_ids.length < 1) return f;
    } else if (draft.campos[f as keyof DraftCampos] === undefined) return f;
  }
  return null;
}

/** Mezcla un `actualizar_borrador`. Si cambia el tipo, empieza un borrador nuevo. Devuelve una copia. */
export function applyDraftUpdate(
  draft: Draft | null,
  tipo: Draft["tipo"],
  campos: DraftCampos = {},
  mediaIds: string[] = [],
): Draft {
  const base: Draft = draft && draft.tipo === tipo ? draft : { tipo, campos: {}, media_ids: [] };
  return {
    tipo,
    campos: { ...base.campos, ...campos },
    media_ids: [...new Set([...base.media_ids, ...mediaIds])],
  };
}
