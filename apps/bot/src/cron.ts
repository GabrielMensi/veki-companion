import { ulid } from "@veki/core";
import { scanAlerts } from "./admin/alerts";
import { sendDailyDigest } from "./admin/digest";
import type { Env } from "./env";
import { runBackup } from "./jobs/backup";
import { runPurge } from "./jobs/purge";
import type { D1Like } from "./public";

/** Variables que este módulo necesita. La URL del hook de Pages sale de un secret, nunca del código. */
export interface RebuildEnv {
  DB: D1Like;
  DEPLOY_HOOK_URL?: string;
}

export const CRON_EVERY_15_MIN = "*/15 * * * *";
export const CRON_DAILY = "0 9 * * *";

export type RebuildResult =
  | { status: "called" }
  | { status: "skipped"; reason: "clean" | "window" | "daily_cap" | "no_hook" | "race" }
  | { status: "failed"; error: string };

interface SiteState {
  dirty_since: number | null;
  last_build_at: number | null;
  builds_day: string | null;
  builds_today: number;
}

/** Día de Argentina (UTC-3, sin horario de verano) para el tope diario. */
export function artDay(now: number): string {
  return new Date(now - 3 * 3600_000).toISOString().slice(0, 10);
}

async function numSetting(db: D1Like, key: string, fallback: number): Promise<number> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  const n = row ? Number(JSON.parse(row.value)) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Reconstrucción del sitio (docs/02 §5.4): si hay cambios, pasó la ventana y no se llegó al tope diario,
 * llama al deploy hook una sola vez y limpia `dirty_since`. `force` ("publicalo ya") ignora la ventana, no el tope.
 */
export async function rebuildIfDirty(
  env: RebuildEnv,
  now: number,
  opts: { force?: boolean; fetchFn?: typeof fetch } = {},
): Promise<RebuildResult> {
  const db = env.DB;
  const st = await db
    .prepare("SELECT dirty_since, last_build_at, builds_day, builds_today FROM site_state WHERE id = 1")
    .bind()
    .first<SiteState>();
  if (!st || st.dirty_since === null) return { status: "skipped", reason: "clean" };
  if (!env.DEPLOY_HOOK_URL) return { status: "skipped", reason: "no_hook" };

  const [maxPerDay, minIntervalMin] = await Promise.all([
    numSetting(db, "max_builds_per_day", 12),
    numSetting(db, "min_build_interval_min", 10),
  ]);
  const today = artDay(now);
  const used = st.builds_day === today ? st.builds_today : 0;
  if (used >= maxPerDay) return { status: "skipped", reason: "daily_cap" };
  if (!opts.force && st.last_build_at !== null && now - st.last_build_at < minIntervalMin * 60_000) {
    return { status: "skipped", reason: "window" };
  }

  // Reserva atómica antes de llamar: dos crons solapados no disparan dos builds.
  const claim = await db
    .prepare("UPDATE site_state SET dirty_since = NULL, last_build_at = ?, builds_day = ?, builds_today = ? WHERE id = 1 AND dirty_since = ?")
    .bind(now, today, used + 1, st.dirty_since)
    .run();
  if (claim.meta?.changes === 0) return { status: "skipped", reason: "race" };

  let error: string | null = null;
  try {
    const res = await (opts.fetchFn ?? fetch)(env.DEPLOY_HOOK_URL, { method: "POST" });
    if (!res.ok) error = `status ${res.status}`;
  } catch (e) {
    error = e instanceof Error ? e.message : "fetch failed";
  }
  if (error === null) return { status: "called" };

  // Falló: el cambio sigue pendiente (el intento igual cuenta para el tope) y queda registrado.
  await db
    .prepare("UPDATE site_state SET dirty_since = COALESCE(dirty_since, ?) WHERE id = 1")
    .bind(st.dirty_since)
    .run();
  await db
    .prepare("INSERT INTO event_log (id, ts, actor, type, severity, entity, data) VALUES (?, ?, 'cron', 'site.rebuild_failed', 'warn', 'site_state', ?)")
    .bind(ulid(now), now, JSON.stringify({ error }))
    .run();
  return { status: "failed", error };
}

/**
 * Esqueleto de los 2 crons (docs/02 §3.7). T14 lo engancha en `scheduled`; el resto de los
 * pasos (nudges, timeouts de content_jobs, backup, purgas, resumen) lo agregan sus tareas.
 */
export async function handleCron(cron: string, env: RebuildEnv | Env, now = Date.now()): Promise<void> {
  if (cron === CRON_EVERY_15_MIN) {
    // TODO(T17): despachar nudges vencidos. TODO(T19): timeouts de content_jobs.
    await rebuildIfDirty(env, now);
    // Las alertas también corren cada 15 min (tope de 1 por tipo cada 30 min): un paso que falla se registra y no rompe el cron.
    const full = env as Env;
    if (full.TELEGRAM_BOT_TOKEN !== undefined) {
      try {
        await scanAlerts(full, now);
      } catch (e) {
        await full.DB.prepare("INSERT INTO event_log (id, ts, actor, type, severity, data) VALUES (?, ?, 'cron', 'cron.step_failed', 'error', ?)")
          .bind(ulid(now), now, JSON.stringify({ step: "alerts", error: e instanceof Error ? e.name : "unknown" }))
          .run();
      }
    }
  } else if (cron === CRON_DAILY) {
    // TODO(T17): planificar nudges.
    // T22: cada paso es independiente; uno que falla se registra y no frena a los demás.
    const full = env as Env;
    if (!full.MEDIA) return; // llamada solo con DB (tests de la reconstrucción): no hay nada que respaldar
    for (const [name, step] of [
      ["backup", () => runBackup(full, now)],
      ["purge", () => runPurge(full, now)],
      ["alerts", () => scanAlerts(full, now)],
      ["digest", () => sendDailyDigest(full, now)],
    ] as const) {
      try {
        await step();
      } catch (e) {
        await full.DB.prepare("INSERT INTO event_log (id, ts, actor, type, severity, data) VALUES (?, ?, 'cron', 'cron.step_failed', 'error', ?)")
          .bind(ulid(now), now, JSON.stringify({ step: name, error: e instanceof Error ? e.name : "unknown" }))
          .run();
      }
    }
  }
}
