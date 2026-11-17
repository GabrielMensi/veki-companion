import { z } from "zod";
import { draftSchema } from "./draft";

export const MAX_HISTORY = 12;

export const awaitingSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("edit"), pending_action_id: z.string() }),
]);

/** `conversations.state` (JSON). */
export const agentStateSchema = z.object({
  draft: draftSchema.nullable().default(null),
  awaiting: awaitingSchema.nullable().default(null),
  misunderstandings: z.number().int().nonnegative().default(0),
});
export type AgentState = z.infer<typeof agentStateSchema>;

export const emptyState = (): AgentState => ({ draft: null, awaiting: null, misunderstandings: 0 });

/** Solo texto: nunca se guarda audio ni resultados de herramientas. */
export type HistoryItem = { role: "user" | "assistant"; content: string };

export function parseState(json: string | null | undefined): AgentState {
  if (!json) return emptyState();
  try {
    return agentStateSchema.parse(JSON.parse(json));
  } catch {
    return emptyState();
  }
}

export function parseHistory(json: string | null | undefined): HistoryItem[] {
  if (!json) return [];
  try {
    return z
      .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() }))
      .parse(JSON.parse(json));
  } catch {
    return [];
  }
}

/** Últimos 12 mensajes (usuario + asistente). */
export const trimHistory = (h: HistoryItem[]): HistoryItem[] => h.slice(-MAX_HISTORY);

/** Lo llama quien ejecuta la acción (T18) cuando `crear_producto`/`crear_feria` se confirman. */
export const clearDraft = (s: AgentState): AgentState => ({ ...s, draft: null, awaiting: null });

export type ConversationSnapshot = { state: AgentState; history: HistoryItem[]; version: number };

/** Puerto de almacenamiento (`conversations`); la implementación D1 con `version` optimista vive en el bot. */
export interface ConversationStore {
  load(chatId: number): Promise<ConversationSnapshot>;
  /** Debe fallar si `expectedVersion` ya no coincide. */
  save(chatId: number, snap: { state: AgentState; history: HistoryItem[] }, expectedVersion: number): Promise<void>;
}

export class InMemoryConversationStore implements ConversationStore {
  readonly rows = new Map<number, ConversationSnapshot>();
  async load(chatId: number): Promise<ConversationSnapshot> {
    return this.rows.get(chatId) ?? { state: emptyState(), history: [], version: 0 };
  }
  async save(chatId: number, snap: { state: AgentState; history: HistoryItem[] }, expectedVersion: number) {
    const cur = await this.load(chatId);
    if (cur.version !== expectedVersion) throw new Error("conversation version conflict");
    this.rows.set(chatId, { ...snap, version: expectedVersion + 1 });
  }
}
