import { ProviderError, isProviderError } from "./errors";
import type {
  ChainEntry, ChatProvider, ChatRequest, ChatResult, ProviderStateStore, SttProvider, SttResult, Usage, UsageSink,
} from "./types";
import { GroqChat } from "./groq-chat";
import { GeminiChat } from "./gemini-chat";
import { GroqStt } from "./groq-stt";
import { WorkersAiStt } from "./workersai-stt";

export type ChainDeps = {
  state: ProviderStateStore;
  usage: UsageSink;
  now?: () => number;
  /** Consecutive `unavailable` failures that open the breaker (02 §4.2: 3). */
  failureThreshold?: number;
  /** Cooldown after the breaker opens (02 §4.2: 10 min). */
  cooldownMs?: number;
  /** Cooldown for a 429 without `retry-after`. */
  defaultRateLimitS?: number;
  onFallback?: (info: { from: string; error: ProviderError }) => void;
};

/** Argentina day (UTC-3, no DST), for `provider_usage.day`. */
export function dayKey(nowMs: number): string {
  return new Date(nowMs - 3 * 3600_000).toISOString().slice(0, 10);
}

export async function runChain<P, R>(
  entries: ChainEntry<P>[],
  deps: ChainDeps,
  call: (p: P) => Promise<R>,
  measure: (r: R) => Usage,
): Promise<{ value: R; providerModel: string }> {
  const now = deps.now ?? Date.now;
  const threshold = deps.failureThreshold ?? 3;
  const cooldownMs = deps.cooldownMs ?? 10 * 60_000;
  const defaultRl = deps.defaultRateLimitS ?? 60;
  let last: ProviderError | undefined;
  let soonestRetryS: number | undefined;
  const note = (s: number | undefined) => {
    if (s !== undefined) soonestRetryS = soonestRetryS === undefined ? s : Math.min(soonestRetryS, s);
  };

  for (const { id, provider } of entries) {
    const st = await deps.state.get(id);
    const t0 = now();
    if (st.cooldownUntil !== null && st.cooldownUntil > t0) {
      note(Math.ceil((st.cooldownUntil - t0) / 1000));
      continue;
    }
    const base = { day: dayKey(t0), providerModel: id, requests: 1, tokensIn: 0, tokensOut: 0, audioS: 0 };
    try {
      const value = await call(provider);
      const u = measure(value);
      await deps.state.set(id, { consecutiveFailures: 0, cooldownUntil: null });
      await deps.usage.record({ ...base, tokensIn: u.tokensIn, tokensOut: u.tokensOut, audioS: Math.round(u.audioS ?? 0), errors: 0 });
      return { value, providerModel: id };
    } catch (e) {
      const err = isProviderError(e) ? e : new ProviderError("fatal", `${id}: ${(e as Error).message}`);
      await deps.usage.record({ ...base, errors: 1 });
      const failures = st.consecutiveFailures + 1;
      let cooldownUntil: number | null = st.cooldownUntil;
      if (err.kind === "rate_limit") {
        const s = err.retryAfterS ?? defaultRl;
        cooldownUntil = now() + s * 1000;
        note(s);
      } else if (err.kind === "fatal" || (err.kind === "unavailable" && failures >= threshold)) {
        cooldownUntil = now() + cooldownMs;
        note(Math.ceil(cooldownMs / 1000));
      } else if (err.kind === "unavailable") {
        note(err.retryAfterS);
      }
      await deps.state.set(id, { consecutiveFailures: err.kind === "bad_output" ? st.consecutiveFailures : failures, cooldownUntil });
      deps.onFallback?.({ from: id, error: err });
      last = err;
    }
  }
  const msg = last ? `all providers failed; last: ${last.message}` : "all providers are in cooldown";
  throw new ProviderError(last?.kind ?? "unavailable", msg, { retryAfterS: soonestRetryS });
}

export class ChatChain implements ChatProvider {
  lastProviderModel?: string;
  constructor(private entries: ChainEntry<ChatProvider>[], private deps: ChainDeps) {}
  async complete(req: ChatRequest): Promise<ChatResult> {
    const { value, providerModel } = await runChain(this.entries, this.deps, (p) => p.complete(req), (r) => r.usage);
    this.lastProviderModel = providerModel;
    return value;
  }
}

export class SttChain implements SttProvider {
  lastProviderModel?: string;
  constructor(private entries: ChainEntry<SttProvider>[], private deps: ChainDeps) {}
  async transcribe(audio: ArrayBuffer, mime: string): Promise<SttResult> {
    const { value, providerModel } = await runChain(
      this.entries, this.deps, (p) => p.transcribe(audio, mime), (r) => ({ tokensIn: 0, tokensOut: 0, audioS: r.audioS }),
    );
    this.lastProviderModel = providerModel;
    return value;
  }
}

export type ProviderCreds = {
  groqApiKey?: string;
  geminiApiKey?: string;
  cfAccountId?: string;
  cfApiToken?: string;
  fetch?: typeof fetch;
};

/** Splits "groq:openai/gpt-oss-120b" into provider and model. */
export function parseProviderId(id: string): { provider: string; model: string } {
  const i = id.indexOf(":");
  if (i <= 0 || i === id.length - 1) throw new Error(`invalid provider id: ${id}`);
  return { provider: id.slice(0, i), model: id.slice(i + 1) };
}

export function createChatProvider(id: string, c: ProviderCreds): ChatProvider {
  const { provider, model } = parseProviderId(id);
  if (provider === "groq" && c.groqApiKey) return new GroqChat({ apiKey: c.groqApiKey, model, fetch: c.fetch });
  if (provider === "gemini" && c.geminiApiKey) return new GeminiChat({ apiKey: c.geminiApiKey, model, fetch: c.fetch });
  throw new Error(`unsupported chat provider or missing credentials: ${provider}`);
}

export function createSttProvider(id: string, c: ProviderCreds): SttProvider {
  const { provider, model } = parseProviderId(id);
  if (provider === "groq" && c.groqApiKey) return new GroqStt({ apiKey: c.groqApiKey, model, fetch: c.fetch });
  if (provider === "workersai" && c.cfAccountId && c.cfApiToken) {
    return new WorkersAiStt({ accountId: c.cfAccountId, apiToken: c.cfApiToken, model, fetch: c.fetch });
  }
  throw new Error(`unsupported stt provider or missing credentials: ${provider}`);
}
