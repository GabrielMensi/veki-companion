import { copy, type Boton } from "../copy/es-AR";
import type { ChatProvider, Msg } from "../providers/types";
import { MAX_BOTONES, MAX_ETIQUETA, MAX_TEXTO, toolDefs, toolSchemas, type ToolName } from "../tools/defs";
import { runTool, type ToolHost } from "../tools/index";
import { applyDraftUpdate, nextMissingField } from "./draft";
import { buildSystem } from "./prompt";
import { trimHistory, type AgentState, type HistoryItem } from "./state";

/** Tope de llamadas al LLM por update (subrequests, docs/02 §2.1/§3.3). */
export const MAX_LLM_CALLS = 4;

export type AgentOutput = {
  texto: string;
  botones?: Boton[];
  /** Si la salida es la vista previa de una acción pendiente (los botones ya son Sí / Cambiar / Cancelar). */
  pendingActionId?: string;
};

export type AgentDeps = {
  chat: ChatProvider;
  host: ToolHost;
  /** Resumen del catálogo para el contexto (≤ 50 productos). */
  catalogSummary?: string;
};

export type AgentInput = {
  chatId: number;
  text: string;
  /** Texto transcrito de un audio con baja confianza. */
  lowConfidenceVoice?: boolean;
};

export type AgentResult = {
  output: AgentOutput;
  state: AgentState;
  history: HistoryItem[];
  llmCalls: number;
  /** El LLM no logró una acción válida: se mandó `copy.noEntendi` (o los atajos). */
  misunderstood: boolean;
  /** 2 malentendidos seguidos: avisar a Gabriel con el `update_id` (sin el texto). */
  escalate: boolean;
  tokensIn: number;
  tokensOut: number;
};

type Checked = { ok: true; output: AgentOutput } | { ok: false; reason: string; coerced?: AgentOutput };

/** Valida `responder`: ≤350 caracteres, ≤6 botones, etiquetas ≤24 y como mucho un `?`. */
export function checkResponder(raw: unknown): Checked {
  const parsed = toolSchemas.responder.safeParse(raw);
  const obj = (raw ?? {}) as { texto?: unknown; botones?: unknown };
  const reasons: string[] = [];
  const questions = typeof obj.texto === "string" ? (obj.texto.match(/\?/g) ?? []).length : 0;
  if (questions > 1) reasons.push("Hiciste más de una pregunta: dejá solo una, con un solo signo de pregunta.");
  if (!parsed.success) {
    reasons.push(`Respuesta inválida: texto hasta ${MAX_TEXTO} caracteres, hasta ${MAX_BOTONES} botones, etiquetas hasta ${MAX_ETIQUETA}.`);
  }
  if (parsed.success && reasons.length === 0) {
    const { texto, botones } = parsed.data;
    return { ok: true, output: { texto, ...(botones?.length ? { botones } : {}) } };
  }
  return { ok: false, reason: reasons.join(" "), coerced: coerce(obj) };
}

/** Último recurso tras el reintento: recorta en vez de dejar a la usuaria sin respuesta. */
function coerce(obj: { texto?: unknown; botones?: unknown }): AgentOutput | undefined {
  if (typeof obj.texto !== "string" || !obj.texto.trim()) return undefined;
  let texto = obj.texto.trim();
  const q = texto.indexOf("?");
  if (q >= 0) texto = texto.slice(0, q + 1);
  if (texto.length > MAX_TEXTO) texto = `${texto.slice(0, MAX_TEXTO - 1)}…`;
  const botones = Array.isArray(obj.botones)
    ? (obj.botones as Boton[])
        .filter((b) => b && typeof b.etiqueta === "string" && typeof b.valor === "string" && b.etiqueta && b.valor)
        .slice(0, MAX_BOTONES)
        .map((b) => ({ etiqueta: b.etiqueta.slice(0, MAX_ETIQUETA), valor: b.valor }))
    : [];
  return { texto, ...(botones.length ? { botones } : {}) };
}

/**
 * Un update de la usuaria → una salida. Hasta 4 llamadas al LLM; `responder` es el único canal de salida.
 * Si el proveedor falla en todas las cadenas, la excepción sube (la cola reintenta el update): no se guarda nada.
 */
export async function runAgent(
  deps: AgentDeps,
  args: { state: AgentState; history: HistoryItem[]; input: AgentInput },
): Promise<AgentResult> {
  const { input } = args;
  let state = args.state;
  const messages: Msg[] = [...args.history, { role: "user", content: input.text } as Msg];
  let regenerated = false;
  let output: AgentOutput | null = null;
  let calls = 0;
  let tokensIn = 0;
  let tokensOut = 0;

  while (!output && calls < MAX_LLM_CALLS) {
    calls++;
    const system = buildSystem({ state, catalogSummary: deps.catalogSummary, lowConfidenceVoice: input.lowConfidenceVoice });
    const res = await deps.chat.complete({ system, messages, tools: toolDefs });
    tokensIn += res.usage.tokensIn;
    tokensOut += res.usage.tokensOut;

    if (res.toolCalls.length === 0) {
      messages.push({ role: "assistant", content: res.text ?? "" });
      messages.push({ role: "user", content: "(sistema) Respondé usando la herramienta responder." });
      continue;
    }
    messages.push({ role: "assistant", content: res.text, toolCalls: res.toolCalls });

    for (const tc of res.toolCalls) {
      const tool = (content: string): Msg => ({ role: "tool", toolCallId: tc.id, name: tc.name, content });
      if (output) {
        messages.push(tool("Ignorada: ya hay respuesta."));
        continue;
      }
      if (!(tc.name in toolSchemas)) {
        messages.push(tool(`Herramienta desconocida: ${tc.name}.`));
        continue;
      }
      const name = tc.name as ToolName;

      if (name === "responder") {
        const checked = checkResponder(tc.arguments);
        if (checked.ok) {
          output = checked.output;
        } else if (!regenerated) {
          regenerated = true; // se pide regenerar UNA vez
          messages.push(tool(`Rechazada. ${checked.reason}`));
        } else if (checked.coerced) {
          output = checked.coerced;
        } else {
          messages.push(tool(`Rechazada. ${checked.reason}`));
        }
        continue;
      }

      if (name === "actualizar_borrador") {
        const parsed = toolSchemas.actualizar_borrador.safeParse(tc.arguments);
        if (!parsed.success) {
          messages.push(tool("Argumentos inválidos para actualizar_borrador."));
          continue;
        }
        const draft = applyDraftUpdate(state.draft, parsed.data.tipo, parsed.data.campos, parsed.data.media_ids);
        state = { ...state, draft };
        const missing = nextMissingField(draft);
        messages.push(tool(missing ? `Guardado. Falta: ${missing} (preguntale ${copy.campoFaltante[missing]}).` : "Guardado. Falta: nada."));
        continue;
      }

      const outcome = await runTool(
        deps.host,
        { chatId: input.chatId, draft: state.draft, awaitingActionId: state.awaiting?.pending_action_id },
        name,
        tc.arguments,
      );
      if (outcome.kind === "pending") {
        output = { texto: outcome.preview, botones: copy.botonesAccion(outcome.actionId), pendingActionId: outcome.actionId };
        state = { ...state, awaiting: null };
      } else {
        messages.push(tool(outcome.kind === "error" ? outcome.message : outcome.content));
      }
    }
  }

  let misunderstood = false;
  let escalate = false;
  if (output) {
    state = { ...state, misunderstandings: 0 };
  } else {
    misunderstood = true;
    const n = state.misunderstandings + 1;
    if (n >= 2) {
      escalate = true;
      output = { texto: copy.atajosTexto, botones: copy.atajos };
      state = { ...state, misunderstandings: 0 };
    } else {
      output = { texto: copy.noEntendi };
      state = { ...state, misunderstandings: n };
    }
  }

  const history = trimHistory([
    ...args.history,
    { role: "user", content: input.text },
    { role: "assistant", content: output.texto },
  ]);
  return { output, state, history, llmCalls: calls, misunderstood, escalate, tokensIn, tokensOut };
}
