import { clearDraft, type ConversationStore, type PendingActionRow } from "@veki/core";
import type { D1DatabaseLike } from "../env";
import { updateState } from "./conversation-store";
import { ActionError, executors as defaultExecutors, type ExecutorMap } from "./executors";
import { dirtyStmt, eventStmt, expireAction, getAction, runBatch, type LogActor } from "./pending";

export type ExecuteResult =
  | { kind: "executed"; action: PendingActionRow; message: string }
  | { kind: "expired" } // pasó el plazo de 24 h (queda `expired`)
  | { kind: "noop" } // ya ejecutada/cancelada/vencida (doble toque, reintento) o no es de este chat
  | { kind: "rejected"; message: string } // la acción era imposible (ActionError): queda `cancelled`
  | { kind: "unsupported" }; // todavía no hay ejecutor para esa herramienta

export type ExecuteDeps = {
  db: D1DatabaseLike;
  store?: ConversationStore;
  executors?: ExecutorMap;
  now?: number;
  actor?: LogActor;
};

/** Herramientas cuya confirmación cierra el borrador (T16: "lo llama quien ejecuta la acción"). */
const CLOSES_DRAFT: Record<string, "producto" | "feria"> = { crear_producto: "producto", crear_feria: "feria" };

/**
 * "Sí": `UPDATE … SET status='executed' WHERE id=? AND status='pending' AND expires_at>?` es la compuerta de
 * idempotencia (docs/02 §3.1.6): solo un toque gana el reclamo y ejecuta; los demás dan `noop`.
 * Luego el ejecutor arma las sentencias + `inverse`, y todo (cambios, inverse, event_log, dirty_since) se
 * aplica en UN batch atómico. Si el batch falla, la acción vuelve a `pending` y la cola reintenta.
 */
export async function executeAction(actionId: string, chatId: number, deps: ExecuteDeps): Promise<ExecuteResult> {
  const { db } = deps;
  const now = deps.now ?? Date.now();
  const actor = deps.actor ?? "owner";
  const registry = deps.executors ?? defaultExecutors;

  const row = await getAction(db, actionId);
  if (!row || row.chat_id !== chatId) return { kind: "noop" };
  if (row.status !== "pending") return { kind: "noop" };
  if (row.expires_at <= now) {
    return (await expireAction(db, actionId, now)) ? { kind: "expired" } : { kind: "noop" };
  }
  const executor = registry[row.tool as keyof ExecutorMap];
  if (!executor) return { kind: "unsupported" }; // sin reclamar: la acción sigue vigente

  const claim = await db
    .prepare("UPDATE pending_actions SET status = 'executed', executed_at = ? WHERE id = ? AND status = 'pending' AND expires_at > ?")
    .bind(now, actionId, now)
    .run();
  if (claim.meta.changes !== 1) return { kind: "noop" };

  const release = (to: "pending" | "cancelled") =>
    db
      .prepare("UPDATE pending_actions SET status = ?, executed_at = NULL WHERE id = ? AND status = 'executed' AND inverse IS NULL")
      .bind(to, actionId)
      .run();

  try {
    const args = JSON.parse(row.args) as unknown;
    const res = await executor({ db, action: row, args, now, actor });
    const stmts = [
      ...res.statements,
      db.prepare("UPDATE pending_actions SET inverse = ? WHERE id = ? AND status = 'executed'").bind(JSON.stringify({ ops: res.inverse, public: res.public }), actionId),
    ];
    if (!res.selfLogged) {
      stmts.push(
        eventStmt(db, { now, actor, type: "action.executed", entity: res.entity ?? "pending_action", entityId: res.entityId ?? actionId, data: { tool: row.tool, action_id: actionId } }),
      );
      if (res.public) stmts.push(dirtyStmt(db, now));
    }
    await runBatch(db, stmts);

    const closes = CLOSES_DRAFT[row.tool];
    if (closes && deps.store) {
      try {
        await updateState(deps.store, chatId, (s) => (s.draft?.tipo === closes ? clearDraft(s) : s));
      } catch {
        // El alta ya está hecha; un borrador viejo se pisa solo en la próxima conversación.
      }
    }
    return { kind: "executed", action: { ...row, status: "executed", executed_at: now }, message: res.message };
  } catch (e) {
    if (e instanceof ActionError) {
      await release("cancelled");
      return { kind: "rejected", message: e.userMessage };
    }
    await release("pending");
    throw e;
  }
}
