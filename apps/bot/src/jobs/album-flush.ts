import type { Env } from "../env";
import { logEvent } from "../queues";
import { MEMBER_EVENT, type DbBatch } from "../handlers/media";

export const ALBUM_DEBOUNCE_MS = 2000;
export const REQUEUE_DELAY_SECONDS = 2;

/** Evento que entra al agente cuando se cierra un álbum (docs/02 §2.3). */
export type AlbumEvent = { chatId: number; media_ids: string[] };
export type AgentEntry = (event: AlbumEvent, env: Env) => Promise<void>;

/**
 * Entrega por defecto hasta que el wiring del agente (T16/T18) registre la suya con `setAgentEntry`:
 * no pierde el álbum, lo deja en `event_log` como `album.undelivered`.
 */
const defaultEntry: AgentEntry = async (event, env) => {
  await logEvent(env, "album.undelivered", "warn", { count: event.media_ids.length, media_ids: event.media_ids });
};
let entry: AgentEntry = defaultEntry;
export const setAgentEntry = (fn: AgentEntry | null) => void (entry = fn ?? defaultEntry);

/** Adaptador de texto: el agente recibe el evento como un turno de sistema con los ids. */
export const albumEventText = (media_ids: string[]) => `(sistema) La usuaria mandó ${media_ids.length === 1 ? "1 foto" : `${media_ids.length} fotos`}. media_ids: ${media_ids.join(", ")}`;

/**
 * Consumidor de `album.flush`. El `UPDATE` condicional es atómico: solo un mensaje "gana" y entrega.
 * Si el grupo sigue `open` (llegó otra foto hace menos de 2 s) se re-encola con 2 s en vez de dormir.
 */
export async function handleAlbumFlush(msg: { gid?: unknown }, env: Env, now: number = Date.now()): Promise<"delivered" | "requeued" | "skipped"> {
  const gid = typeof msg.gid === "string" ? msg.gid : null;
  if (!gid) return "skipped";
  const db = env.DB as DbBatch;
  const won = await db
    .prepare("UPDATE inbox_groups SET status='flushed' WHERE media_group_id=? AND status='open' AND last_at <= ?")
    .bind(gid, now - ALBUM_DEBOUNCE_MS)
    .run();
  if (won.meta.changes !== 1) {
    const g = await db.prepare("SELECT status FROM inbox_groups WHERE media_group_id=?").bind(gid).first<{ status: string }>();
    if (g?.status !== "open") return "skipped"; // ya entregado (o inexistente): ack
    await env.Q_JOBS.send({ type: "album.flush", gid }, { delaySeconds: REQUEUE_DELAY_SECONDS });
    return "requeued";
  }

  const group = await db.prepare("SELECT chat_id FROM inbox_groups WHERE media_group_id=?").bind(gid).first<{ chat_id: number }>();
  // Álbumes nuevos: columna `media.media_group_id`. Álbumes anteriores a la migración 0002: filas legacy de event_log.
  const [cur, legacy] = await Promise.all([
    db.prepare("SELECT id FROM media WHERE media_group_id=? ORDER BY created_at, rowid").bind(gid).all<{ id: string }>(),
    db
      .prepare("SELECT json_extract(data, '$.media_id') AS media_id FROM event_log WHERE type=? AND json_extract(data, '$.gid')=? ORDER BY ts, rowid")
      .bind(MEMBER_EVENT, gid)
      .all<{ media_id: string | null }>(),
  ]);
  const media_ids = [...new Set([...cur.results.map((r) => r.id), ...legacy.results.map((r) => r.media_id).filter((x): x is string => !!x)])];
  try {
    await entry({ chatId: group!.chat_id, media_ids }, env);
  } catch (e) {
    // Sin entrega no hay álbum ganado: se reabre para que el reintento de la cola vuelva a ganar.
    await db.prepare("UPDATE inbox_groups SET status='open' WHERE media_group_id=? AND status='flushed'").bind(gid).run();
    throw e;
  }
  return "delivered";
}
