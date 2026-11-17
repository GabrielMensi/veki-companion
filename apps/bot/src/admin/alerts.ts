import { copyAdmin, copyAdminEscalacion } from "@veki/core";
import type { D1DatabaseLike } from "../env";
import { adminWarning } from "../provider-ports";
import type { Env } from "../env";

/** Alertas inmediatas (docs/02 §6.1): máximo 1 cada 30 min por tipo. */
export const ALERT_COOLDOWN_MS = 30 * 60_000;
const KEY_PREFIX = "alert_last:";
/** Un proveedor en cooldown por más de 1 h dispara alerta. */
export const PROVIDER_COOLDOWN_ALERT_MS = 60 * 60_000;

export type AlertType = "error" | "render_fallido" | "proveedor_cooldown" | "malentendidos";

/**
 * Reserva el turno de alerta para `type`: un UPSERT condicional (atómico) que solo avanza si pasaron 30 min
 * desde la última. `true` = esta llamada puede enviar. El estado vive en `settings` (sin migración).
 */
export async function claimAlert(db: D1DatabaseLike, type: string, now: number): Promise<boolean> {
  const r = await db
    .prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE CAST(settings.value AS INTEGER) <= ?",
    )
    .bind(`${KEY_PREFIX}${type}`, String(now), now - ALERT_COOLDOWN_MS)
    .run();
  return r.meta.changes === 1;
}

export type AlertSend = (text: string) => Promise<void>;

/** Envía `text` a los chats admin si el tope del tipo lo permite. El texto nunca lleva contenido de mensajes. */
export async function sendAlert(
  env: Env,
  type: AlertType,
  text: string,
  now: number,
  send: AlertSend = adminWarning(env),
): Promise<boolean> {
  if (!(await claimAlert(env.DB, type, now))) return false;
  await send(text);
  return true;
}

/** Revisa `event_log`, `content_jobs` y `provider_state` y dispara las alertas que correspondan. Devuelve los tipos enviados. */
export async function scanAlerts(env: Env, now: number, send?: AlertSend): Promise<AlertType[]> {
  const db = env.DB;
  const sent: AlertType[] = [];
  const since = now - ALERT_COOLDOWN_MS * 2;
  const errors = await db
    .prepare("SELECT COUNT(*) AS n FROM event_log WHERE severity = 'error' AND ts >= ?")
    .bind(since)
    .first<{ n: number }>();
  if (errors && errors.n > 0 && (await sendAlert(env, "error", copyAdmin.alerta.error(errors.n), now, send))) sent.push("error");

  const failed = await db
    .prepare("SELECT COUNT(*) AS n FROM content_jobs WHERE status = 'failed' AND updated_at >= ?")
    .bind(since)
    .first<{ n: number }>();
  if (failed && failed.n > 0 && (await sendAlert(env, "render_fallido", copyAdmin.alerta.renderFallido(failed.n), now, send))) sent.push("render_fallido");

  const cooling = await db
    .prepare("SELECT provider_model FROM provider_state WHERE cooldown_until IS NOT NULL AND cooldown_until - ? > ? ORDER BY cooldown_until DESC LIMIT 1")
    .bind(now, PROVIDER_COOLDOWN_ALERT_MS)
    .first<{ provider_model: string }>();
  if (cooling && (await sendAlert(env, "proveedor_cooldown", copyAdmin.alerta.proveedorEnPausa(cooling.provider_model), now, send))) {
    sent.push("proveedor_cooldown");
  }
  return sent;
}

/**
 * Escalación del agente (docs/02 §3.4): avisa a los chats admin, con el tope de 1 cada 30 min por tipo.
 * Solo lleva el `update_id`, nunca el texto. Un fallo al avisar no rompe el turno (ya quedó en `event_log`).
 */
export async function alertEscalation(env: Env, updateId: number | undefined, now: number = Date.now(), send?: AlertSend): Promise<boolean> {
  try {
    return await sendAlert(env, "malentendidos", copyAdminEscalacion.malentendidos(updateId), now, send);
  } catch {
    return false;
  }
}
