/**
 * Registro del webhook de Telegram (docs/02-diseno.md §6.3, ops/DEPLOY.md). MANUAL: no corre en CI ni en el Worker.
 *
 * Nunca imprime el token, el secret ni la URL completa de la API de Telegram (esa URL lleva el token):
 * todo lo que sale por consola pasa por `redact`. Los errores también.
 *
 * Variables (de entorno; nunca como argumentos):
 *   TELEGRAM_BOT_TOKEN   token de BotFather
 *   TG_WEBHOOK_SECRET    mismo valor que el secret del Worker (`openssl rand -hex 32`)
 *   WORKER_URL           https://<worker>.workers.dev (sin ruta)
 *
 * Uso (desde apps/bot):
 *   npm run webhook:set -- --dry-run   muestra lo que enviaría; no llama a la red (es el default)
 *   npm run webhook:set -- --apply     setWebhook + getWebhookInfo
 *   npm run webhook:set -- --info      solo getWebhookInfo
 *   npm run webhook:set -- --delete    deleteWebhook (el bot deja de recibir updates)
 *
 * Las partes puras (parseo, validación, armado de requests, enmascarado) se exportan y se prueban en
 * test/set-webhook.test.ts con un `fetch` inyectado.
 */

export type Mode = "dry-run" | "apply" | "info" | "delete";

export interface SetWebhookEnv {
  TELEGRAM_BOT_TOKEN?: string;
  TG_WEBHOOK_SECRET?: string;
  WORKER_URL?: string;
}

/** Forma mínima de fetch que usamos (el `fetch` global la cumple; los tests inyectan una falsa). */
export interface FetchLike {
  (input: string, init: { method: string; headers: Record<string, string>; body: string }): Promise<{
    status: number;
    json(): Promise<unknown>;
  }>;
}

export interface PlannedRequest {
  method: "setWebhook" | "getWebhookInfo" | "deleteWebhook";
  body: Record<string, unknown>;
}

export interface Config {
  token: string;
  /** Solo para dry-run y apply. */
  secret: string | null;
  /** https://<worker>/tg/webhook. Solo para dry-run y apply. */
  webhookUrl: string | null;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export const MASK = "***";
export const API_BASE = "https://api.telegram.org";
export const ALLOWED_UPDATES = ["message", "callback_query"];
const TOKEN_RE = /^\d+:[A-Za-z0-9_-]+$/;
const SECRET_RE = /^[A-Za-z0-9_-]{1,256}$/;
const FLAGS = ["--dry-run", "--apply", "--info", "--delete"] as const;

/** Parsea los flags. Sin flag = dry-run. No repite el argumento desconocido (podría ser un token pegado por error). */
export function parseArgs(argv: readonly string[]): Result<Mode> {
  const seen = new Set<string>();
  for (const arg of argv) {
    if (!(FLAGS as readonly string[]).includes(arg)) {
      return { ok: false, error: "argumento desconocido (no se muestra por seguridad). Usá --dry-run, --apply, --info o --delete" };
    }
    seen.add(arg);
  }
  if (seen.size > 1) return { ok: false, error: "elegí un solo modo: --dry-run, --apply, --info o --delete" };
  switch ([...seen][0]) {
    case "--apply":
      return { ok: true, value: "apply" };
    case "--info":
      return { ok: true, value: "info" };
    case "--delete":
      return { ok: true, value: "delete" };
    default:
      return { ok: true, value: "dry-run" };
  }
}

/** WORKER_URL: https, sin credenciales, sin ruta, query ni fragmento. Devuelve solo el origen. */
export function normalizeWorkerUrl(raw: string | undefined): Result<string> {
  if (!raw || !raw.trim()) return { ok: false, error: "WORKER_URL está vacía" };
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, error: "WORKER_URL no es una URL válida" };
  }
  if (url.protocol !== "https:") return { ok: false, error: "WORKER_URL tiene que ser https" };
  if (url.username || url.password) return { ok: false, error: "WORKER_URL no puede llevar credenciales" };
  if (url.pathname !== "/" && url.pathname !== "") {
    return { ok: false, error: "WORKER_URL no puede tener ruta: usá solo https://<worker>.workers.dev" };
  }
  if (url.search || url.hash) return { ok: false, error: "WORKER_URL no puede tener query ni fragmento" };
  return { ok: true, value: url.origin };
}

/** Token de BotFather: `id:clave`. El error no lo repite. */
export function validateToken(raw: string): Result<string> {
  const token = raw.trim();
  if (!TOKEN_RE.test(token)) return { ok: false, error: "TELEGRAM_BOT_TOKEN no tiene el formato de BotFather (id:clave)" };
  return { ok: true, value: token };
}

/** Telegram acepta 1 a 256 caracteres A-Z a-z 0-9 _ -. */
export function validateSecret(raw: string): Result<string> {
  const secret = raw.trim();
  if (!SECRET_RE.test(secret)) {
    return {
      ok: false,
      error: "TG_WEBHOOK_SECRET solo admite A-Z, a-z, 0-9, _ y - (1 a 256 caracteres). Generalo con: openssl rand -hex 32",
    };
  }
  return { ok: true, value: secret };
}

/** Valida las variables que necesita cada modo. Dry-run y apply necesitan secret y WORKER_URL; info y delete no. */
export function resolveConfig(mode: Mode, env: SetWebhookEnv): Result<Config> {
  const needsWebhook = mode === "dry-run" || mode === "apply";
  const missing: string[] = [];
  if (!env.TELEGRAM_BOT_TOKEN?.trim()) missing.push("TELEGRAM_BOT_TOKEN");
  if (needsWebhook && !env.TG_WEBHOOK_SECRET?.trim()) missing.push("TG_WEBHOOK_SECRET");
  if (needsWebhook && !env.WORKER_URL?.trim()) missing.push("WORKER_URL");
  if (missing.length > 0) return { ok: false, error: `faltan variables de entorno: ${missing.join(", ")}` };

  const token = validateToken(env.TELEGRAM_BOT_TOKEN ?? "");
  if (!token.ok) return token;
  if (!needsWebhook) return { ok: true, value: { token: token.value, secret: null, webhookUrl: null } };

  const secret = validateSecret(env.TG_WEBHOOK_SECRET ?? "");
  if (!secret.ok) return secret;
  const origin = normalizeWorkerUrl(env.WORKER_URL);
  if (!origin.ok) return origin;
  return { ok: true, value: { token: token.value, secret: secret.value, webhookUrl: `${origin.value}/tg/webhook` } };
}

/** Requests de la Bot API que corresponden a cada modo, en orden. Sin token: el token va en la URL al enviar. */
export function buildRequests(mode: Mode, cfg: Config): PlannedRequest[] {
  switch (mode) {
    case "dry-run":
    case "apply":
      return [
        {
          method: "setWebhook",
          body: {
            url: cfg.webhookUrl,
            secret_token: cfg.secret,
            allowed_updates: ALLOWED_UPDATES,
            drop_pending_updates: true,
          },
        },
        { method: "getWebhookInfo", body: {} },
      ];
    case "info":
      return [{ method: "getWebhookInfo", body: {} }];
    case "delete":
      return [{ method: "deleteWebhook", body: { drop_pending_updates: false } }];
  }
}

/** Enmascara: el token en cualquier `bot<id>:<clave>` y cada secret literal. */
export function redact(text: string, secrets: ReadonlyArray<string | null | undefined> = []): string {
  let out = text.replace(/bot\d+:[A-Za-z0-9_-]+/g, `bot${MASK}`);
  for (const s of secrets) {
    if (s) out = out.split(s).join(MASK);
  }
  return out;
}

/** Líneas para mostrar un request sin token ni secret. */
export function describeRequest(req: PlannedRequest, secret: string | null): string[] {
  return [`POST ${API_BASE}/bot${MASK}/${req.method}`, `  cuerpo: ${redact(JSON.stringify(req.body), [secret])}`];
}

export function telegramUrl(token: string, method: string): string {
  return `${API_BASE}/bot${token}/${method}`;
}

interface TgEnvelope {
  ok?: unknown;
  result?: unknown;
  error_code?: unknown;
  description?: unknown;
}

/** Envía un request. Todo error sale redactado. */
export async function sendRequest(
  fetchFn: FetchLike,
  cfg: Config,
  req: PlannedRequest,
): Promise<unknown> {
  const secrets = [cfg.token, cfg.secret];
  try {
    const res = await fetchFn(telegramUrl(cfg.token, req.method), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req.body),
    });
    const data = (await res.json().catch(() => null)) as TgEnvelope | null;
    if (!data || typeof data !== "object") throw new Error(`${req.method}: respuesta inesperada (HTTP ${res.status})`);
    if (data.ok !== true) {
      const code = typeof data.error_code === "number" ? data.error_code : res.status;
      const desc = typeof data.description === "string" ? data.description : "sin descripción";
      throw new Error(`${req.method}: error ${code}: ${desc}`);
    }
    return data.result;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(redact(msg, secrets));
  }
}

export interface InfoSummary {
  url: string;
  pending_update_count: number;
  last_error_message?: string;
  last_error_date?: number;
  allowed_updates?: string[];
}

/** Solo los campos que pide el runbook. Cualquier otro campo de Telegram se descarta. */
export function summarizeInfo(result: unknown, secrets: ReadonlyArray<string | null | undefined>): InfoSummary {
  const r = (result && typeof result === "object" ? result : {}) as Record<string, unknown>;
  const summary: InfoSummary = {
    url: redact(typeof r.url === "string" ? r.url : "", secrets),
    pending_update_count: typeof r.pending_update_count === "number" ? r.pending_update_count : 0,
  };
  if (typeof r.last_error_message === "string") summary.last_error_message = redact(r.last_error_message, secrets);
  if (typeof r.last_error_date === "number") summary.last_error_date = r.last_error_date;
  if (Array.isArray(r.allowed_updates)) summary.allowed_updates = r.allowed_updates.filter((x): x is string => typeof x === "string");
  return summary;
}

export function formatInfo(s: InfoSummary): string[] {
  const lines = [
    `url: ${s.url || "(vacía: no hay webhook registrado)"}`,
    `pending_update_count: ${s.pending_update_count}`,
    `allowed_updates: ${s.allowed_updates ? s.allowed_updates.join(", ") : "(no informado)"}`,
  ];
  if (s.last_error_message !== undefined) lines.push(`last_error_message: ${s.last_error_message}`);
  if (s.last_error_date !== undefined) {
    lines.push(`last_error_date: ${new Date(s.last_error_date * 1000).toISOString()}`);
  }
  return lines;
}

/**
 * Punto de entrada testeable: parsea, valida, ejecuta y devuelve el código de salida.
 * `log` recibe solo texto ya redactado.
 */
export async function run(
  argv: readonly string[],
  env: SetWebhookEnv,
  fetchFn: FetchLike,
  log: (line: string) => void,
): Promise<number> {
  const mode = parseArgs(argv);
  if (!mode.ok) {
    log(`error: ${mode.error}`);
    return 2;
  }
  const cfg = resolveConfig(mode.value, env);
  if (!cfg.ok) {
    log(`error: ${redact(cfg.error, [env.TELEGRAM_BOT_TOKEN, env.TG_WEBHOOK_SECRET])}`);
    return 2;
  }
  const requests = buildRequests(mode.value, cfg.value);

  if (mode.value === "dry-run") {
    log("DRY-RUN: no se hace ninguna llamada a la red. Lo que se enviaría:");
    for (const req of requests) for (const line of describeRequest(req, cfg.value.secret)) log(line);
    log("Para ejecutarlo de verdad: --apply");
    return 0;
  }

  try {
    let last: unknown = null;
    for (const req of requests) {
      last = await sendRequest(fetchFn, cfg.value, req);
    }
    const secrets = [cfg.value.token, cfg.value.secret];
    if (mode.value === "delete") {
      log("deleteWebhook: ok");
      return 0;
    }
    if (mode.value === "apply") log("setWebhook: ok");
    for (const line of formatInfo(summarizeInfo(last, secrets))) log(line);
    return 0;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`error: ${redact(msg, [cfg.value.token, cfg.value.secret])}`);
    return 1;
  }
}

// Entrada de línea de comandos. Con `vite-node scripts/set-webhook.ts ...`, process.argv es
// [node, <ruta de vite-node>, ...args]: el nombre de este archivo no aparece. Por eso se mira argv[1].
// Los tests (vitest) importan el módulo y no cumplen esta condición, así que no ejecutan nada.
const entryScript = typeof process !== "undefined" && Array.isArray(process.argv) ? (process.argv[1] ?? "") : "";
if (/(vite-node|set-webhook\.ts)$/.test(entryScript)) {
  const argv = process.argv.slice(2);
  run(argv, process.env as SetWebhookEnv, globalThis.fetch as unknown as FetchLike, (line) => console.log(line))
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      console.log("error: fallo inesperado (no se muestra el detalle por seguridad)");
      process.exitCode = 1;
    });
}
