export type ProviderErrorKind = "rate_limit" | "unavailable" | "bad_output" | "fatal";

/** Error taxonomy of 02 §4.6. Never sleeps: callers use `retryAfterS` (queue retry). */
export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly retryAfterS?: number;
  readonly status?: number;
  /** Código de error del proveedor (p. ej. `tool_use_failed`), solo para diagnóstico: nunca el cuerpo ni textos. */
  readonly code?: string;
  constructor(kind: ProviderErrorKind, message: string, opts: { retryAfterS?: number; status?: number; code?: string } = {}) {
    super(message);
    this.name = "ProviderError";
    this.kind = kind;
    this.retryAfterS = opts.retryAfterS;
    this.status = opts.status;
    this.code = opts.code;
  }
}

export function isProviderError(e: unknown): e is ProviderError {
  return e instanceof ProviderError;
}

/** `retry-after` in seconds (or HTTP date). Returns undefined if absent/invalid. */
export function parseRetryAfter(h: Headers, now: number = Date.now()): number | undefined {
  const raw = h.get("retry-after");
  if (!raw) return undefined;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0) return Math.ceil(n);
  const t = Date.parse(raw);
  return Number.isFinite(t) ? Math.max(0, Math.ceil((t - now) / 1000)) : undefined;
}

/** Maps a non-2xx response to a ProviderError. The body is truncated, so no secrets/PII travel in messages. */
export async function errorFromResponse(res: Response, label: string): Promise<ProviderError> {
  let detail = "";
  let full = "";
  try {
    full = (await res.text()).slice(0, 8000);
    detail = full.slice(0, 200);
  } catch {
    /* ignore */
  }
  const code = errorCodeOf(full);
  const msg = `${label}: HTTP ${res.status} ${detail}`.trim();
  const retryAfterS = parseRetryAfter(res.headers);
  if (res.status === 429) return new ProviderError("rate_limit", msg, { retryAfterS, status: 429 });
  if (res.status === 408 || res.status >= 500) return new ProviderError("unavailable", msg, { retryAfterS, status: res.status });
  // Un 400 porque el MODELO armó mal la llamada a una herramienta no es culpa de la clave ni del pedido: es una mala
  // salida de ese turno. Pasa al siguiente modelo (o se reintenta) sin enfriar a nadie 10 minutos.
  if (res.status === 400 && code === "tool_use_failed") return new ProviderError("bad_output", msg, { status: 400, code });
  return new ProviderError("fatal", msg, { status: res.status, code });
}

/** `error.code` (o `error.type`) del cuerpo, solo si parece un identificador corto. */
function errorCodeOf(body: string): string | undefined {
  try {
    const e = (JSON.parse(body) as { error?: { code?: unknown; type?: unknown } }).error;
    const v = typeof e?.code === "string" ? e.code : typeof e?.type === "string" ? e.type : undefined;
    return v && /^[\w.-]{1,60}$/.test(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/** fetch wrapper: network failures become `unavailable`; non-2xx become classified errors. */
export async function doFetch(
  fetchImpl: typeof fetch,
  label: string,
  url: string,
  init: RequestInit,
): Promise<Response> {
  let res: Response;
  try {
    res = await fetchImpl(url, init);
  } catch (e) {
    throw new ProviderError("unavailable", `${label}: network ${(e as Error).message}`);
  }
  if (!res.ok) throw await errorFromResponse(res, label);
  return res;
}

export async function readJson(res: Response, label: string): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    throw new ProviderError("bad_output", `${label}: response is not valid JSON`);
  }
}
