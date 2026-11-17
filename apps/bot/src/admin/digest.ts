import { copyAdmin } from "@veki/core";
import { artDay } from "../cron";
import type { Env } from "../env";
import { adminWarning, loadChatSettings } from "../provider-ports";

export type DigestData = Parameters<typeof copyAdmin.resumenDiario>[0];

/** Junta los números del día (docs/02 §6.1). Solo conteos y nombres de modelo: nada de contenido. */
export async function buildDigest(env: Env, now: number): Promise<DigestData> {
  const db = env.DB;
  const since = now - 86_400_000;
  const day = artDay(now);
  const count = async (sql: string, ...b: unknown[]) => (await db.prepare(sql).bind(...b).first<{ n: number }>())?.n ?? 0;
  const settings = await loadChatSettings(db);
  const usage = await db
    .prepare("SELECT provider_model, tokens_in + tokens_out AS t FROM provider_usage WHERE day = ? AND (requests > 0 OR errors > 0) ORDER BY provider_model")
    .bind(day)
    .all<{ provider_model: string; t: number }>();
  const site = await db.prepare("SELECT builds_day, builds_today FROM site_state WHERE id = 1").bind().first<{ builds_day: string | null; builds_today: number }>();
  const paused = await db
    .prepare("SELECT type FROM nudge_policy WHERE paused_until IS NOT NULL AND paused_until > ? ORDER BY type")
    .bind(now)
    .all<{ type: string }>();
  return {
    acciones: await count("SELECT COUNT(*) AS n FROM pending_actions WHERE status IN ('executed','undone') AND executed_at >= ?", since),
    errores: await count("SELECT COUNT(*) AS n FROM event_log WHERE severity = 'error' AND ts >= ?", since),
    uso: usage.results.map((u) => ({ modelo: u.provider_model, usados: u.t, tope: settings.dailyTokenBudget })),
    builds: site?.builds_day === day ? site.builds_today : 0,
    ignorados: await count("SELECT COUNT(*) AS n FROM nudges WHERE status = 'ignored' AND due_at >= ?", since),
    pausados: paused.results.map((p) => p.type),
  };
}

/** Resumen diario al chat de Gabriel (cron `0 9 * * *`, 06:00 ART). Sin chat admin configurado, no envía. */
export async function sendDailyDigest(env: Env, now: number, send: (text: string) => Promise<void> = adminWarning(env)): Promise<string> {
  const text = copyAdmin.resumenDiario(await buildDigest(env, now));
  await send(text);
  return text;
}
