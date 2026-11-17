import type { PendingActionRow } from "@veki/core";
import type { D1DatabaseLike, D1PreparedStatementLike } from "../env";
import { ACTION_TTL_MS, dirtyStmt, eventStmt, getAction, runBatch, type LogActor } from "./pending";

/** Tablas que una acción puede restaurar al deshacerse. */
export const UNDO_TABLES = ["products", "variants", "media", "fairs"] as const;
export type UndoTable = (typeof UNDO_TABLES)[number];

/**
 * Operación inversa basada en instantáneas: `upsert` deja la fila EXACTAMENTE como estaba (todas las columnas),
 * `delete` borra lo que la acción creó. Se aplican en orden dentro de un solo batch atómico.
 */
export type Op =
  | { op: "upsert"; table: UndoTable; row: Record<string, unknown> }
  | { op: "delete"; table: UndoTable; id: string };

/** Lo que se guarda en `pending_actions.inverse`. `public`: la acción original cambió algo del sitio. */
export type Inverse = { ops: Op[]; public: boolean };

const IDENT = /^[a-z_][a-z0-9_]*$/;

export function inverseStatements(db: D1DatabaseLike, ops: Op[]): D1PreparedStatementLike[] {
  return ops.map((o) => {
    if (!UNDO_TABLES.includes(o.table)) throw new Error(`tabla no permitida: ${o.table}`);
    if (o.op === "delete") return db.prepare(`DELETE FROM ${o.table} WHERE id = ?`).bind(o.id);
    const cols = Object.keys(o.row);
    if (!cols.includes("id") || !cols.every((c) => IDENT.test(c))) throw new Error("fila inválida en inverse");
    const set = cols.filter((c) => c !== "id").map((c) => `${c} = excluded.${c}`).join(", ");
    // Upsert (no REPLACE): REPLACE borraría la fila y chocaría con las claves foráneas.
    return db
      .prepare(`INSERT INTO ${o.table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")}) ON CONFLICT(id) DO UPDATE SET ${set}`)
      .bind(...cols.map((c) => o.row[c]));
  });
}

export function parseInverse(json: string | null): Inverse | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as Partial<Inverse>;
    return Array.isArray(v.ops) ? { ops: v.ops, public: v.public === true } : null;
  } catch {
    return null;
  }
}

export type UndoResult =
  | { kind: "undone"; action: PendingActionRow }
  | { kind: "expired" } // pasaron más de 24 h
  | { kind: "already" } // ya estaba deshecha (o la deshizo otro toque en paralelo)
  | { kind: "not_undoable" }
  | { kind: "not_found" };

/**
 * Deshace una acción ejecutada: reclama `executed → undone` con un UPDATE condicional (un doble toque no aplica
 * dos veces) y restaura las filas. Si el batch falla, devuelve la acción a `executed` y propaga el error.
 */
export async function undoAction(
  db: D1DatabaseLike,
  actionId: string,
  o: { chatId: number; actor: LogActor; now: number },
): Promise<UndoResult> {
  const row = await getAction(db, actionId);
  if (!row || row.chat_id !== o.chatId) return { kind: "not_found" };
  if (row.status === "undone") return { kind: "already" };
  if (row.status !== "executed" || row.tool === "deshacer") return { kind: "not_undoable" };
  const inverse = parseInverse(row.inverse);
  if (!inverse) return { kind: "not_undoable" };
  if (row.executed_at === null || row.executed_at + ACTION_TTL_MS < o.now) return { kind: "expired" };

  const claim = await db
    .prepare("UPDATE pending_actions SET status = 'undone' WHERE id = ? AND status = 'executed' AND executed_at >= ?")
    .bind(actionId, o.now - ACTION_TTL_MS)
    .run();
  if (claim.meta.changes !== 1) return { kind: "already" };

  try {
    const stmts = [
      ...inverseStatements(db, inverse.ops),
      eventStmt(db, { now: o.now, actor: o.actor, type: "action.undone", entity: "pending_action", entityId: actionId, data: { tool: row.tool } }),
    ];
    if (inverse.public) stmts.push(dirtyStmt(db, o.now));
    await runBatch(db, stmts);
  } catch (e) {
    await db.prepare("UPDATE pending_actions SET status = 'executed' WHERE id = ? AND status = 'undone'").bind(actionId).run();
    throw e;
  }
  return { kind: "undone", action: { ...row, status: "undone" } };
}

/** La última acción ejecutada (y deshacible) de la conversación en las últimas 24 h. */
export async function lastUndoableId(db: D1DatabaseLike, chatId: number, now: number): Promise<string | null> {
  const r = await db
    .prepare(
      "SELECT id FROM pending_actions WHERE chat_id = ? AND status = 'executed' AND tool != 'deshacer' AND executed_at >= ? ORDER BY executed_at DESC, id DESC LIMIT 1",
    )
    .bind(chatId, now - ACTION_TTL_MS)
    .first<{ id: string }>();
  return r?.id ?? null;
}
