import { ulid } from "@veki/core";
import { artDay } from "../cron";
import type { D1DatabaseLike } from "../env";

/** Tablas de negocio que se respaldan (docs/02 §6.4). Excluye `conversations`, `updates` y `event_log` (minimización). */
export const BACKUP_TABLES = ["products", "variants", "media", "fairs", "settings", "nudge_policy"] as const;
export const BACKUP_PREFIX = "backups/";
export const BACKUP_FORMAT_VERSION = 1;
export const BACKUP_RETENTION_DAYS = 30;

/** Forma mínima de R2 que usa el backup (no dependemos de @cloudflare/workers-types). */
export interface BackupBucket {
  put(key: string, value: string, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  delete(keys: string | string[]): Promise<void>;
  list(options?: { prefix?: string; cursor?: string }): Promise<{ objects: { key: string }[]; truncated: boolean; cursor?: string }>;
}

export type BackupFile = {
  version: number;
  created_at: number;
  day: string;
  tables: Record<(typeof BACKUP_TABLES)[number], Record<string, unknown>[]>;
};

export const backupKey = (day: string) => `${BACKUP_PREFIX}${day}.json`;

export async function exportTables(db: D1DatabaseLike, now: number): Promise<BackupFile> {
  const tables = {} as BackupFile["tables"];
  for (const t of BACKUP_TABLES) {
    tables[t] = (await db.prepare(`SELECT * FROM ${t}`).bind().all<Record<string, unknown>>()).results;
  }
  return { version: BACKUP_FORMAT_VERSION, created_at: now, day: artDay(now), tables };
}

/** Se conserva un respaldo si tiene ≤ 30 días o es del día 1 del mes ("el primero de cada mes"). */
export function shouldKeep(day: string, today: string): boolean {
  if (day.endsWith("-01")) return true;
  const age = (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 86_400_000;
  return !(age > BACKUP_RETENTION_DAYS);
}

/** Borra los respaldos vencidos. Ignora claves que no tengan la forma `backups/YYYY-MM-DD.json`. */
export async function pruneBackups(bucket: BackupBucket, today: string): Promise<string[]> {
  const doomed: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: BACKUP_PREFIX, cursor });
    for (const o of page.objects) {
      const m = /^backups\/(\d{4}-\d{2}-\d{2})\.json$/.exec(o.key);
      if (m && !shouldKeep(m[1]!, today)) doomed.push(o.key);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  for (let i = 0; i < doomed.length; i += 1000) await bucket.delete(doomed.slice(i, i + 1000));
  return doomed;
}

export type BackupResult = { key: string; bytes: number; rows: Record<string, number>; pruned: number };

/** Exporta las tablas de negocio a `backups/YYYY-MM-DD.json` en R2, deja un `event_log` (solo conteos) y poda los vencidos. */
export async function runBackup(env: { DB: D1DatabaseLike; MEDIA: unknown }, now: number): Promise<BackupResult> {
  const bucket = env.MEDIA as BackupBucket;
  const file = await exportTables(env.DB, now);
  const body = JSON.stringify(file);
  const key = backupKey(file.day);
  await bucket.put(key, body, { httpMetadata: { contentType: "application/json" } });
  const pruned = await pruneBackups(bucket, file.day);
  const rows = Object.fromEntries(BACKUP_TABLES.map((t) => [t, file.tables[t].length]));
  await env.DB.prepare("INSERT INTO event_log (id, ts, actor, type, severity, data) VALUES (?, ?, 'cron', 'backup.done', 'info', ?)")
    .bind(ulid(now), now, JSON.stringify({ key, rows, pruned: pruned.length }))
    .run();
  return { key, bytes: body.length, rows, pruned: pruned.length };
}
