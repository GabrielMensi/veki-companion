import { ulid } from "@veki/core";
import type { D1DatabaseLike } from "../env";

/** Retención (docs/02 §2.5). */
export const UPDATES_RETENTION_MS = 14 * 86_400_000;
export const EVENT_LOG_RETENTION_MS = 180 * 86_400_000;
export const INBOX_VIDEO_RETENTION_MS = 30 * 86_400_000;
const VIDEO_BATCH = 100;

export interface PurgeBucket {
  delete(keys: string | string[]): Promise<void>;
}

export type PurgeResult = { updates: number; events: number; videos: number };

/**
 * Purgas diarias: `updates` a 14 días, `event_log` a 180, y los videos que quedaron en `inbox` sin usar a 30
 * (se borra el objeto de R2 y después la fila; si R2 falla la fila queda y se reintenta mañana).
 */
export async function runPurge(env: { DB: D1DatabaseLike; MEDIA: unknown }, now: number): Promise<PurgeResult> {
  const db = env.DB;
  const bucket = env.MEDIA as PurgeBucket;
  const updates = (await db.prepare("DELETE FROM updates WHERE received_at < ?").bind(now - UPDATES_RETENTION_MS).run()).meta.changes;
  const events = (await db.prepare("DELETE FROM event_log WHERE ts < ?").bind(now - EVENT_LOG_RETENTION_MS).run()).meta.changes;

  const { results } = await db
    .prepare("SELECT id, r2_key FROM media WHERE kind = 'video' AND status = 'inbox' AND product_id IS NULL AND variant_id IS NULL AND created_at < ? LIMIT ?")
    .bind(now - INBOX_VIDEO_RETENTION_MS, VIDEO_BATCH)
    .all<{ id: string; r2_key: string }>();
  let videos = 0;
  for (const v of results) {
    await bucket.delete(v.r2_key);
    videos += (await db.prepare("DELETE FROM media WHERE id = ? AND status = 'inbox'").bind(v.id).run()).meta.changes;
  }

  await db
    .prepare("INSERT INTO event_log (id, ts, actor, type, severity, data) VALUES (?, ?, 'cron', 'purge.done', 'info', ?)")
    .bind(ulid(now), now, JSON.stringify({ updates, events, videos }))
    .run();
  return { updates, events, videos };
}
