/** Textos fijos de Veki (español rioplatense, "vos"). No los inventa el LLM. Máx. un emoji por mensaje. */

export type Boton = { etiqueta: string; valor: string };

/** `callback_data` de los botones de una acción pendiente: `pa:<id>:yes|edit|no` (docs/02 §3.1). */
export const paData = (id: string, accion: "yes" | "edit" | "no") => `pa:${id}:${accion}`;

export const copy = {
  noEntendi: "Perdón, no te entendí. ¿Me lo decís de otra forma?",
  algoSalioMal: "Ups, algo salió mal de mi lado. ¿Probás de nuevo? 🙏",
  vencido: "Eso ya venció, ¿lo armamos de nuevo?",
  lenta: "Estoy un poquito lenta, te respondo en un ratito 🙏",
  noPudeEscuchar: "No pude escuchar el audio, ¿me lo mandás de nuevo o me lo escribís?",
  tipoNoSoportado: "Por ahora entiendo fotos, audios, videos cortitos y texto 🙂",
  cambiarPregunta: "¿Qué le cambio?",
  /** Atajos tras 2 malentendidos seguidos (docs/02 §3.4). */
  atajosTexto: "Probemos por acá, ¿qué querés hacer?",
  atajos: [
    { etiqueta: "Cargar producto", valor: "atajo:producto" },
    { etiqueta: "Vendí algo", valor: "atajo:venta" },
    { etiqueta: "Nueva feria", valor: "atajo:feria" },
    { etiqueta: "Pedir flyer", valor: "atajo:flyer" },
  ] satisfies Boton[],
  botonesAccion: (id: string): Boton[] => [
    { etiqueta: "Sí", valor: paData(id, "yes") },
    { etiqueta: "Cambiar", valor: paData(id, "edit") },
    { etiqueta: "Cancelar", valor: paData(id, "no") },
  ],
  /** Qué pedirle al LLM según el campo que falta del borrador (lo decide el código, docs/02 §3.1.3). */
  campoFaltante: {
    name: "cómo se llama",
    price_ars: "cuánto sale (o si es 'consultar')",
    category: "en qué categoría va",
    media_ids: "que mande al menos una foto",
    place: "dónde es",
    starts_at: "cuándo empieza (día y hora)",
    ends_at: "cuándo termina (día y hora)",
  } as Record<string, string>,
};

export function formatPrecio(p: number | "consultar" | null | undefined): string {
  if (p === "consultar" || p == null) return "precio a consultar";
  return `$${Math.round(p).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".")}`;
}
