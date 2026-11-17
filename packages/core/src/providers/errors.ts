export type ProviderErrorKind = "rate_limit" | "unavailable" | "bad_output" | "fatal";

/** Error taxonomy of 02 §4.6. Never sleeps: callers use `retryAfterS` (queue retry). */
export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly retryAfterS?: number;
  readonly status?: number;
  constructor(kind: ProviderErrorKind, message: string, opts: { retryAfterS?: number; status?: number } = {}) {
    super(message);
    this.name = "ProviderError";
    this.kind = kind;
    this.retryAfterS = opts.retryAfterS;
    this.status = opts.status;
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
  try {
    detail = (await res.text()).slice(0, 200);
  } catch {
    /* ignore */
  }
  const msg = `${label}: HTTP ${res.status} ${detail}`.trim();
  const retryAfterS = parseRetryAfter(res.headers);
  if (res.status === 429) return new ProviderError("rate_limit", msg, { retryAfterS, status: 429 });
  if (res.status === 408 || res.status >= 500) return new ProviderError("unavailable", msg, { retryAfterS, status: res.status });
  return new ProviderError("fatal", msg, { status: res.status });
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
