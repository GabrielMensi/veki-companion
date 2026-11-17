import { ulid, type PendingActionInput, type PendingActionRow, type ToolHost } from "@veki/core";
import type { D1DatabaseLike, D1PreparedStatementLike, Env } from "../env";

/** Las acciones pendientes vencen a las 24 h (docs/02 §3.3); el Deshacer también es válido 24 h. */
export const ACTION_TTL_MS = 24 * 60 * 60 * 1000;

type Batchable = D1DatabaseLike & { batch?: (stmts: D1PreparedStatementLike[]) => Promise<unknown[]> };

/** Ejecuta varias sentencias de forma atómica (D1 `batch`: todo o nada). */
export async function runBatch(db: D1DatabaseLike, stmts: D1PreparedStatementLike[]): Promise<void> {
  if (stmts.length === 0) return;
  const b = (db as Batchable).batch;
  if (!b) throw new Error("db.batch no disponible");
  await b.call(db, stmts);
}

export async function getAction(db: D1DatabaseLike, id: string): Promise<PendingActionRow | null> {
  return db.prepare("SELECT * FROM pending_actions WHERE id = ?").bind(id).first<PendingActionRow>();
}

/**
 * Crea la acción pendiente (el puerto `ToolHost.createPendingAction` que llaman las herramientas de escritura).
 * El id se genera acá, al crear, y no al ejecutar (docs/02 §3.1.6). Con `supersedes`, la acción anterior de la
 * misma conversación pasa a `cancelled` en la misma operación atómica ("Cambiar").
 */
export async function createPendingAction(
  env: Pick<Env, "DB">,
  input: PendingActionInput,
  now: number = Date.now(),
): Promise<{ id: string }> {
  const id = ulid(now);
  const stmts = [
    env.DB.prepare(
      "INSERT INTO pending_actions (id, chat_id, tool, args, preview, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)",
    ).bind(id, input.chatId, input.tool, JSON.stringify(input.args), input.preview, now, now + ACTION_TTL_MS),
  ];
  if (input.supersedes) {
    stmts.push(
      env.DB.prepare("UPDATE pending_actions SET status = 'cancelled' WHERE id = ? AND chat_id = ? AND status = 'pending'").bind(
        input.supersedes,
        input.chatId,
      ),
    );
  }
  await runBatch(env.DB, stmts);
  return { id };
}

/** `ToolHost` respaldado por D1 (las lecturas las agrega T19 con `read`). */
export function d1ToolHost(env: Pick<Env, "DB">, read?: ToolHost["read"]): ToolHost {
  return { createPendingAction: (input) => createPendingAction(env, input), ...(read ? { read } : {}) };
}

/** Guarda el id del mensaje de Telegram donde se mostró la vista previa (para quitarle los botones después). */
export async function attachMessage(db: D1DatabaseLike, id: string, tgMessageId: number): Promise<void> {
  await db.prepare("UPDATE pending_actions SET tg_message_id = ? WHERE id = ?").bind(tgMessageId, id).run();
}

/** Pasa a `cancelled` solo si sigue pendiente. `true` si esta llamada la canceló. */
export async function cancelAction(db: D1DatabaseLike, id: string, chatId: number): Promise<boolean> {
  const r = await db
    .prepare("UPDATE pending_actions SET status = 'cancelled' WHERE id = ? AND chat_id = ? AND status = 'pending'")
    .bind(id, chatId)
    .run();
  return r.meta.changes === 1;
}

/** Pasa a `expired` solo si sigue pendiente y ya venció. */
export async function expireAction(db: D1DatabaseLike, id: string, now: number): Promise<boolean> {
  const r = await db
    .prepare("UPDATE pending_actions SET status = 'expired' WHERE id = ? AND status = 'pending' AND expires_at <= ?")
    .bind(id, now)
    .run();
  return r.meta.changes === 1;
}

/** Rol para `event_log.actor`. */
export type LogActor = "owner" | "admin";

/** Sentencia que escribe `event_log` (sin datos personales ni textos de la usuaria). */
export function eventStmt(
  db: D1DatabaseLike,
  e: { now: number; actor: LogActor; type: string; entity?: string | null; entityId?: string | null; data?: unknown },
): D1PreparedStatementLike {
  return db
    .prepare("INSERT INTO event_log (id, ts, actor, type, severity, entity, entity_id, data) VALUES (?, ?, ?, ?, 'info', ?, ?, ?)")
    .bind(ulid(e.now), e.now, e.actor, e.type, e.entity ?? null, e.entityId ?? null, e.data === undefined ? null : JSON.stringify(e.data));
}

/** Marca el sitio como "sucio" (algo público cambió); conserva la marca más vieja si ya estaba. */
export function dirtyStmt(db: D1DatabaseLike, now: number): D1PreparedStatementLike {
  return db
    .prepare("INSERT INTO site_state (id, dirty_since) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET dirty_since = COALESCE(dirty_since, excluded.dirty_since)")
    .bind(now);
}
