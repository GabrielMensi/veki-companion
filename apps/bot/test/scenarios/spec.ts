// Guiones de conversacion de la Etapa 1 (T23): una sola fuente para los tests (FakeChatProvider) y para el
// script manual `scripts/eval-chat.ts` (Groq real). Todo inventado: productos, ids y frases.
// Este modulo NO importa nada de `cloudflare:test`: lo puede cargar tambien un script de Node.

/** Un turno de la usuaria. `user` es lo que le llega al agente (texto, transcripcion de un audio o evento de fotos). */
export type EvalTurn = {
  user: string;
  /** Herramientas que el modelo tiene que haber llamado en el turno (en cualquier orden). */
  includes?: string[];
  /** Herramientas que NO puede llamar (p. ej. escribir antes de aclarar). */
  excludes?: string[];
  /** `pending`: el turno termina en una vista previa; `reply`: termina hablando con `responder`. */
  outcome?: "pending" | "reply";
  /** El audio llego con baja confianza (el runtime lo marca con `lowConfidenceVoice`). */
  lowConfidence?: boolean;
  /** La respuesta tiene que ser exactamente UNA pregunta (un solo `?`). Solo se cuenta; el texto no se imprime. */
  oneQuestion?: boolean;
  /** Precio que tiene que quedar en el borrador al terminar el turno. */
  draftPrice?: number;
  /** Subconjunto de argumentos que tiene que tener la accion pendiente creada en el turno (datos correctos). */
  pendingArgs?: Record<string, unknown>;
};

export type SeedVariant = { id: string; design: string; size: string; color: string; stock: number | null };
export type SeedProduct = { id: string; slug: string; name: string; category: string; price_ars: number; variants: SeedVariant[] };

export type EvalScenario = {
  id: string;
  /** Criterio de aceptacion de la Etapa 1 (docs/03 seccion 3) o `diseno` para los guiones de docs/02. */
  covers: string;
  catalog: SeedProduct[];
  turns: EvalTurn[];
};

// ── Catalogo inventado ─────────────────────────────────────────────────────
export const RINONERA: SeedProduct = {
  id: "prod-rinonera-girasol",
  slug: "rinonera-girasol",
  name: "Riñonera Girasol",
  category: "riñoneras",
  price_ars: 12000,
  variants: [{ id: "var-rinonera-base", design: "", size: "", color: "", stock: null }],
};

export const NECESER: SeedProduct = {
  id: "prod-neceser-lunares",
  slug: "neceser-lunares",
  name: "Neceser Lunares",
  category: "neceseres",
  price_ars: 8000,
  variants: [
    { id: "var-neceser-rosa", design: "", size: "", color: "Rosa", stock: 5 },
    { id: "var-neceser-azul", design: "", size: "", color: "Azul", stock: 4 },
  ],
};

// ── Frases de la usuaria (iguales en tests y en eval) ───────────────────────
export const SAY = {
  voiceProducto: "Es un neceser de lona floreado, lo vendo a doce mil quinientos pesos.",
  categoria: "neceseres",
  preguntaPrecio: "¿Cuánto sale la riñonera girasol?",
  cambiarPrecio: "cambiale el precio a quince mil",
  deshacer: "Deshacé lo último",
  vendi: "vendí 2 neceseres",
  laRosa: "la rosa",
  cambiarOtroPrecio: "mejor veinte mil",
  voiceBolso: "Es un bolso de cuero tipo banana, lo dejo a doce mil pesos.",
  precioSinProducto: "cambiale el precio",
  stockSinProducto: "sumá cinco al stock",
  vendiRosa: "vendí 2 neceseres rosa",
} as const;

/** Texto con el que entra al agente un evento de fotos (mismo formato que `albumEventText` del bot). */
export const photoEventText = (ids: string[]) =>
  `(sistema) La usuaria mandó ${ids.length === 1 ? "1 foto" : `${ids.length} fotos`}. media_ids: ${ids.join(", ")}`;

/**
 * Guiones que corre `eval-chat.ts` contra el chat real. Cada turno se juzga solo por las herramientas elegidas
 * (nunca por el texto del modelo). Los botones "Sí" no son turnos de chat: no aparecen aca.
 */
export const NECESER_Y_RINONERA = [RINONERA, NECESER];

export const EVAL_SCENARIOS: EvalScenario[] = [
  {
    id: "alta-producto-con-fotos-y-voz",
    covers: "1",
    catalog: [],
    turns: [
      { user: photoEventText(["media-a1", "media-a2", "media-a3"]), includes: ["actualizar_borrador"], excludes: ["crear_producto"], outcome: "reply" },
      { user: SAY.voiceProducto, includes: ["actualizar_borrador"], excludes: ["crear_producto"], outcome: "reply" },
      { user: SAY.categoria, includes: ["actualizar_borrador", "crear_producto"], outcome: "pending" },
    ],
  },
  {
    id: "cambiar-precio",
    covers: "3",
    catalog: [RINONERA],
    turns: [
      { user: SAY.preguntaPrecio, includes: ["buscar_productos"], excludes: ["editar_producto"], outcome: "reply" },
      { user: SAY.cambiarPrecio, includes: ["editar_producto"], outcome: "pending" },
    ],
  },
  {
    id: "deshacer-lo-ultimo",
    covers: "3",
    catalog: [RINONERA],
    turns: [{ user: SAY.deshacer, includes: ["deshacer"], outcome: "pending" }],
  },
  {
    id: "venta-con-dos-variantes",
    covers: "diseno",
    catalog: [NECESER],
    turns: [
      { user: SAY.vendi, includes: ["buscar_productos"], excludes: ["cambiar_stock"], outcome: "reply" },
    ],
  },
  {
    // Whisper puede oir "doce mil" como "dos mil": el numero queda en el borrador tal cual y nada se guarda sin Si.
    id: "precio-dicho-por-voz",
    covers: "diseno",
    catalog: [],
    turns: [
      { user: photoEventText(["media-b1"]), includes: ["actualizar_borrador"], excludes: ["crear_producto"], outcome: "reply" },
      { user: SAY.voiceBolso, lowConfidence: true, includes: ["actualizar_borrador"], excludes: ["crear_producto"], outcome: "reply", draftPrice: 12000 },
    ],
  },
  {
    id: "pedido-ambiguo-precio",
    covers: "diseno",
    catalog: NECESER_Y_RINONERA,
    turns: [{ user: SAY.precioSinProducto, excludes: ["editar_producto", "cambiar_stock", "deshacer"], outcome: "reply", oneQuestion: true }],
  },
  {
    id: "pedido-ambiguo-stock",
    covers: "diseno",
    catalog: NECESER_Y_RINONERA,
    turns: [{ user: SAY.stockSinProducto, excludes: ["editar_producto", "cambiar_stock", "deshacer"], outcome: "reply", oneQuestion: true }],
  },
  {
    id: "venta-de-variante-con-nombre",
    covers: "diseno",
    catalog: [NECESER],
    turns: [
      {
        user: SAY.vendiRosa,
        includes: ["buscar_productos", "cambiar_stock"],
        outcome: "pending",
        pendingArgs: { variante_id: "var-neceser-rosa", delta: -2, motivo: "venta" },
      },
    ],
  },
];
