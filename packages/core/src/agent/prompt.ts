import { copy } from "../copy/es-AR";
import { toolDefs } from "../tools/defs";
import { nextMissingField } from "./draft";
import { emptyState, type AgentState } from "./state";

/** System prompt fijo (rol, tono, reglas). Corto a propósito: va en cada llamada al LLM. */
export const STATIC_SYSTEM = `Sos Veki, la compañera de una emprendedora que vende bolsos y neceseres cosidos a mano. Ella te escribe o te manda audios para cargar productos, stock y ferias.
Tono: español rioplatense con "vos", cálida, alegre y breve. Máximo un emoji. Sin tecnicismos (base de datos, error, servidor).
Reglas:
- Hablás SOLO con la herramienta responder: hasta 350 caracteres y 6 botones.
- UNA sola pregunta por mensaje, con un solo signo de pregunta.
- Lo que cuenta de un producto o feria nuevos se guarda con actualizar_borrador. El sistema dice qué falta ("Falta"): preguntá solo eso.
- Las herramientas de escritura piden confirmación y el sistema muestra la vista previa: no repitas los datos ni preguntes si confirma.
- Si hay varias variantes y no está claro cuál, preguntá con botones.
- Antes de afirmar algo del catálogo o la agenda, consultalo con las herramientas de lectura.
- Si no entendés, pedile que lo diga de otra forma.
- Fechas en hora de Argentina, AAAA-MM-DDTHH:mm.`;

export type PromptContext = {
  state: AgentState;
  /** Resumen del catálogo (id, nombre, variantes; ≤ 50 productos). Lo arma quien llama. */
  catalogSummary?: string;
  /** Resumen de la acción pendiente que ella quiere cambiar (el historial recortado puede no tenerla). */
  pendingSummary?: string;
  /** El mensaje vino de un audio con baja confianza: confirmar importes y números. */
  lowConfidenceVoice?: boolean;
};

/** System prompt completo para una llamada: parte fija + estado actual. */
export function buildSystem(ctx: PromptContext): string {
  const parts = [STATIC_SYSTEM];
  const { draft, awaiting } = ctx.state;
  if (draft) {
    const missing = nextMissingField(draft);
    parts.push(
      `Borrador (${draft.tipo}): ${JSON.stringify({ ...draft.campos, fotos: draft.media_ids.length })}\n` +
        (missing
          ? `Falta: ${missing} (preguntale ${copy.campoFaltante[missing]}).`
          : draft.tipo === "producto"
            ? "Falta: nada. Llamá crear_producto."
            : "Falta: nada. Llamá crear_feria."),
    );
  }
  if (awaiting?.kind === "edit") {
    parts.push("Ella pidió cambiar la acción anterior: lo que dice es el cambio. Usá la herramienta de escritura que corresponda con los datos nuevos." +
        (ctx.pendingSummary ? `\nAcción pendiente: ${ctx.pendingSummary}` : ""));
  }
  if (ctx.lowConfidenceVoice) {
    parts.push("El mensaje vino de un audio con baja confianza: repetí los importes y números en tu pregunta para confirmarlos.");
  }
  if (ctx.catalogSummary) parts.push(`Catálogo:\n${ctx.catalogSummary}`);
  return parts.join("\n\n");
}

/** Regla aproximada y documentada: ~3,5 caracteres por token en español/JSON. Es una ESTIMACIÓN, no el conteo del proveedor. */
export const CHARS_PER_TOKEN = 3.5;
export const estimateTokens = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN);

/** Lo que mide `scripts/measure-chat-tokens.ts`: system prompt (sin catálogo) + definiciones de herramientas. */
export const MEASURED_SYSTEM = buildSystem({ state: emptyState() });
export const MEASURED_TOOLS = toolDefs;
export const TOKEN_BUDGET = 2500;

export function estimatePromptTokens(): { system: number; tools: number; total: number } {
  const system = estimateTokens(MEASURED_SYSTEM);
  const tools = estimateTokens(JSON.stringify(toolDefs));
  return { system, tools, total: system + tools };
}
