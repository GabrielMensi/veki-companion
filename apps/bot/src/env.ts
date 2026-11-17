// Tipos estructurales minimos de los bindings de Cloudflare que usa el bot.
// (No dependemos de @cloudflare/workers-types para no chocar con los tipos DOM del tsconfig base.)

export interface D1ResultMeta {
  changes: number;
}
export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  run(): Promise<{ meta: D1ResultMeta }>;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
}
export interface D1DatabaseLike {
  prepare(sql: string): D1PreparedStatementLike;
}
export interface QueueProducer<T = unknown> {
  send(message: T, options?: { delaySeconds?: number }): Promise<void>;
}

export interface Env {
  DB: D1DatabaseLike;
  MEDIA: unknown;
  Q_UPDATES: QueueProducer;
  Q_JOBS: QueueProducer;
  /** Secret (`wrangler secret`): token del bot de Telegram. Nunca se loguea. */
  TELEGRAM_BOT_TOKEN: string;
  /** Secret (`wrangler secret` + `setWebhook(secret_token)`): se valida en cada update. */
  TG_WEBHOOK_SECRET: string;
  /** Secret (`wrangler secret`): URL del deploy hook de Pages para reconstruir el sitio. Opcional: sin ella no se reconstruye. */
  DEPLOY_HOOK_URL?: string;
  /** Secret (`wrangler secret`): clave de Groq (chat y voz). Sin ella el agente responde que algo salió mal. */
  GROQ_API_KEY?: string;
  /** Secret (`wrangler secret`): clave de Gemini (respaldo del chat). */
  GEMINI_API_KEY?: string;
  /** Var del Worker: lista `id:rol` separada por comas, p. ej. `111:owner,222:admin`. Un id suelto es `owner`. */
  ALLOWED_CHAT_IDS: string;
}

export type ChatRole = "owner" | "admin";

/** Parsea ALLOWED_CHAT_IDS. Entradas invalidas se ignoran (cierra por defecto). */
export function parseAllowlist(raw: string | undefined): Map<number, ChatRole> {
  const out = new Map<number, ChatRole>();
  for (const part of (raw ?? "").split(",")) {
    const [idRaw, roleRaw] = part.trim().split(":");
    if (!idRaw || !/^-?\d+$/.test(idRaw)) continue;
    const role = (roleRaw ?? "owner").trim();
    if (role !== "owner" && role !== "admin") continue;
    out.set(Number(idRaw), role);
  }
  return out;
}
