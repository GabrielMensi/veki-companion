import { copyAdmin } from "@veki/core";
import { undoAction } from "../actions/undo";
import { getAction } from "../actions/pending";
import { artDay, rebuildIfDirty } from "../cron";
import { parseAllowlist, type D1DatabaseLike, type Env } from "../env";

/** Clave en `settings` con el interruptor de `/pausa` (JSON booleano). El despachador de nudges (T17) la lee. */
export const NUDGES_PAUSED_KEY = "nudges_paused";

/** Comandos de admin (docs/02 §3.5, §6.2). */
export const ADMIN_COMMANDS = ["estado", "log", "deshacer", "reconstruir", "pausa", "avisos"] as const;

export function isAdminChat(env: Pick<Env, "ALLOWED_CHAT_IDS">, chatId: number): boolean {
  return parseAllowlist(env.ALLOWED_CHAT_IDS).get(chatId) === "admin";
}

/** `/cmd@bot arg1 arg2` → `{ cmd, args }`. `null` si no empieza con `/`. */
export function parseCommand(text: string): { cmd: string; args: string[] } | null {
  const t = text.trim();
  if (!t.startsWith("/")) return null;
  const [head, ...args] = t.split(/\s+/);
  return { cmd: head!.slice(1).split("@")[0]!.toLowerCase(), args };
}

const n = async (db: D1DatabaseLike, sql: string, ...binds: unknown[]): Promise<number> =>
  (await db.prepare(sql).bind(...binds).first<{ n: number }>())?.n ?? 0;

export async function isNudgesPaused(db: D1DatabaseLike): Promise<boolean> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(NUDGES_PAUSED_KEY).first<{ value: string }>();
  return row?.value === "true";
}

async function estado(env: Env, now: number): Promise<string> {
  const db = env.DB;
  const site = await db.prepare("SELECT dirty_since, builds_day, builds_today FROM site_state WHERE id = 1").bind().first<{ dirty_since: number | null; builds_day: string | null; builds_today: number }>();
  return copyAdmin.estado({
    pendientes: await n(db, "SELECT COUNT(*) AS n FROM pending_actions WHERE status = 'pending' AND expires_at > ?", now),
    fallidos: await n(db, "SELECT COUNT(*) AS n FROM updates WHERE status = 'failed'"),
    errores24h: await n(db, "SELECT COUNT(*) AS n FROM event_log WHERE severity = 'error' AND ts >= ?", now - 86_400_000),
    sitioPendiente: site?.dirty_since != null,
    avisosPausados: await isNudgesPaused(db),
    buildsHoy: site?.builds_day === artDay(now) ? site.builds_today : 0,
  });
}

/** Una línea por evento: hora ART, severidad, tipo y entidad. Nunca el campo `data`. */
async function log(env: Env, args: string[]): Promise<string> {
  const limit = args[0] === undefined ? 10 : Number(args[0]);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) return copyAdmin.logUso;
  const { results } = await env.DB.prepare("SELECT id, ts, severity, type, entity, entity_id FROM event_log ORDER BY ts DESC, id DESC LIMIT ?")
    .bind(limit)
    .all<{ id: string; ts: number; severity: string; type: string; entity: string | null; entity_id: string | null }>();
  if (results.length === 0) return copyAdmin.logVacio;
  return results
    .map((r) => `${new Date(r.ts - 3 * 3600_000).toISOString().slice(5, 16).replace("T", " ")} [${r.severity}] ${r.type}${r.entity ? ` (${r.entity}${r.entity_id ? ` ${r.entity_id}` : ""})` : ""}`)
    .join("\n");
}

async function deshacer(env: Env, args: string[], now: number): Promise<string> {
  const id = args[0];
  if (!id) return copyAdmin.deshacerUso;
  const action = await getAction(env.DB, id);
  if (!action) return copyAdmin.deshacerNoEncontrada;
  // El admin deshace acciones de cualquier chat (la de ella incluida): se usa el chat dueño de la acción.
  const r = await undoAction(env.DB, id, { chatId: action.chat_id, actor: "admin", now });
  switch (r.kind) {
    case "undone": return copyAdmin.deshacerListo(id);
    case "already": return copyAdmin.deshacerYaEstaba;
    case "expired": return copyAdmin.deshacerVencida;
    case "not_found": return copyAdmin.deshacerNoEncontrada;
    default: return copyAdmin.deshacerImposible;
  }
}

async function reconstruir(env: Env, now: number, fetchFn?: typeof fetch): Promise<string> {
  const r = await rebuildIfDirty(env, now, { force: true, fetchFn });
  if (r.status === "called") return copyAdmin.reconstruirLlamado;
  if (r.status === "failed") return copyAdmin.reconstruirFalla;
  switch (r.reason) {
    case "clean": return copyAdmin.reconstruirSinCambios;
    case "daily_cap": return copyAdmin.reconstruirTope;
    case "no_hook": return copyAdmin.reconstruirSinHook;
    default: return copyAdmin.reconstruirOtro;
  }
}

async function pausa(env: Env, args: string[]): Promise<string> {
  const v = args[0]?.toLowerCase();
  if (v !== "on" && v !== "off") return copyAdmin.pausaUso;
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(NUDGES_PAUSED_KEY, v === "on" ? "true" : "false")
    .run();
  return v === "on" ? copyAdmin.pausaOn : copyAdmin.pausaOff;
}

async function avisos(env: Env, args: string[], now: number): Promise<string> {
  const [tipo, flag] = args;
  if (tipo && flag?.toLowerCase() === "on") {
    const r = await env.DB.prepare("UPDATE nudge_policy SET enabled = 1, ignored_streak = 0, paused_until = NULL WHERE type = ?").bind(tipo).run();
    return r.meta.changes === 1 ? copyAdmin.avisosReactivado(tipo) : copyAdmin.avisosNoExiste(tipo);
  }
  const { results } = await env.DB.prepare("SELECT type, enabled, ignored_streak, paused_until FROM nudge_policy ORDER BY type")
    .all<{ type: string; enabled: number; ignored_streak: number; paused_until: number | null }>();
  if (results.length === 0) return copyAdmin.avisosVacio;
  const lines = results.map((r) => {
    const estado = !r.enabled ? "apagado" : r.paused_until && r.paused_until > now ? `en pausa hasta ${new Date(r.paused_until - 3 * 3600_000).toISOString().slice(0, 10)}` : "activo";
    return `• ${r.type}: ${estado}${r.ignored_streak ? ` (ignorados seguidos: ${r.ignored_streak})` : ""}`;
  });
  return [...lines, copyAdmin.avisosUso].join("\n");
}

export type AdminDeps = { now?: number; fetch?: typeof fetch };

/**
 * Ejecuta un comando de admin y devuelve la respuesta. `null` = no corresponde (el chat no es admin o el texto no
 * empieza con `/`): el llamador sigue con el flujo normal. Un `/algo` desconocido de un admin recibe la ayuda.
 */
export async function handleAdminCommand(env: Env, chatId: number, text: string, deps: AdminDeps = {}): Promise<string | null> {
  if (!isAdminChat(env, chatId)) return null;
  const parsed = parseCommand(text);
  if (!parsed) return null;
  const now = deps.now ?? Date.now();
  switch (parsed.cmd) {
    case "estado": return estado(env, now);
    case "log": return log(env, parsed.args);
    case "deshacer": return deshacer(env, parsed.args, now);
    case "reconstruir": return reconstruir(env, now, deps.fetch);
    case "pausa": return pausa(env, parsed.args);
    case "avisos": return avisos(env, parsed.args, now);
    default: return copyAdmin.comandoDesconocido;
  }
}
