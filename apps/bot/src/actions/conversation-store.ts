import {
  emptyState,
  parseHistory,
  parseState,
  type AgentState,
  type ConversationSnapshot,
  type ConversationStore,
  type HistoryItem,
} from "@veki/core";
import type { ChatRole, D1DatabaseLike } from "../env";

export class ConversationVersionConflict extends Error {
  constructor(chatId: number) {
    super(`conversation version conflict (chat ${chatId})`);
    this.name = "ConversationVersionConflict";
  }
}

export const isVersionConflict = (e: unknown): boolean =>
  e instanceof ConversationVersionConflict || (e instanceof Error && /version conflict/.test(e.message));

type Row = { state: string; history: string; version: number };

/** `ConversationStore` sobre `conversations` con bloqueo optimista por `version`. */
export class D1ConversationStore implements ConversationStore {
  constructor(
    private readonly db: D1DatabaseLike,
    private readonly roleOf: (chatId: number) => ChatRole = () => "owner",
    private readonly now: () => number = Date.now,
  ) {}

  async load(chatId: number): Promise<ConversationSnapshot> {
    const row = await this.db.prepare("SELECT state, history, version FROM conversations WHERE chat_id = ?").bind(chatId).first<Row>();
    if (!row) return { state: emptyState(), history: [], version: 0 };
    return { state: parseState(row.state), history: parseHistory(row.history), version: row.version };
  }

  async save(chatId: number, snap: { state: AgentState; history: HistoryItem[] }, expectedVersion: number): Promise<void> {
    const t = this.now();
    const state = JSON.stringify(snap.state);
    const history = JSON.stringify(snap.history);
    const upd = await this.db
      .prepare(
        "UPDATE conversations SET state = ?, history = ?, version = version + 1, last_user_msg_at = ?, updated_at = ? WHERE chat_id = ? AND version = ?",
      )
      .bind(state, history, t, t, chatId, expectedVersion)
      .run();
    if (upd.meta.changes === 1) return;
    if (expectedVersion === 0) {
      // Primera vez: si dos escrituras compiten por crear la fila, solo una la inserta.
      const ins = await this.db
        .prepare(
          "INSERT INTO conversations (chat_id, role, state, history, last_user_msg_at, version, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?) ON CONFLICT(chat_id) DO NOTHING",
        )
        .bind(chatId, this.roleOf(chatId), state, history, t, t)
        .run();
      if (ins.meta.changes === 1) return;
    }
    throw new ConversationVersionConflict(chatId);
  }
}

/** Lee, transforma el estado y guarda; si otro update se coló (conflicto de versión), relee y reintenta. */
export async function updateState(
  store: ConversationStore,
  chatId: number,
  fn: (s: AgentState) => AgentState,
  attempts = 4,
): Promise<AgentState> {
  for (let i = 1; ; i++) {
    const snap = await store.load(chatId);
    const state = fn(snap.state);
    try {
      await store.save(chatId, { state, history: snap.history }, snap.version);
      return state;
    } catch (e) {
      if (!isVersionConflict(e) || i >= attempts) throw e;
    }
  }
}
