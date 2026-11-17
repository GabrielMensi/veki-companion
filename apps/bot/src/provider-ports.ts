import {
  copyPresupuesto, isProviderError, resolveChatSettings,
  type BudgetPort, type ChatSettings, type ProviderState, type ProviderStateStore, type UsageDelta, type UsageSink,
} from "@veki/core";
import type { D1DatabaseLike, Env } from "./env";
import { parseAllowlist } from "./env";
import { sendTelegram } from "./handlers/media";

/** `provider_state` (circuit breaker). Times in epoch ms. */
export class D1ProviderStateStore implements ProviderStateStore {
  constructor(private db: D1DatabaseLike) {}
  async get(id: string): Promise<ProviderState> {
    const r = await this.db
      .prepare("SELECT consecutive_failures AS f, cooldown_until AS c FROM provider_state WHERE provider_model = ?")
      .bind(id)
      .first<{ f: number; c: number | null }>();
    return r ? { consecutiveFailures: r.f, cooldownUntil: r.c } : { consecutiveFailures: 0, cooldownUntil: null };
  }
  async set(id: string, s: ProviderState): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO provider_state (provider_model, consecutive_failures, cooldown_until) VALUES (?, ?, ?) " +
          "ON CONFLICT(provider_model) DO UPDATE SET consecutive_failures = excluded.consecutive_failures, cooldown_until = excluded.cooldown_until",
      )
      .bind(id, s.consecutiveFailures, s.cooldownUntil)
      .run();
  }
}

/** `provider_usage`: one UPSERT per call; tokens come from the API response's `usage`. */
export class D1UsageSink implements UsageSink {
  constructor(private db: D1DatabaseLike) {}
  async record(d: UsageDelta): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO provider_usage (day, provider_model, requests, tokens_in, tokens_out, audio_s, errors) VALUES (?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(day, provider_model) DO UPDATE SET requests = requests + excluded.requests, tokens_in = tokens_in + excluded.tokens_in, " +
          "tokens_out = tokens_out + excluded.tokens_out, audio_s = audio_s + excluded.audio_s, errors = errors + excluded.errors",
      )
      .bind(d.day, d.providerModel, d.requests, d.tokensIn, d.tokensOut, d.audioS, d.errors)
      .run();
  }
}

const ALERT_PREFIX = "budget_alert:";

/** Budget port over D1. The "already alerted today" flag lives in `settings` (no migration). */
export class D1BudgetPort implements BudgetPort {
  constructor(
    private db: D1DatabaseLike,
    private budget: number,
    private sendAdmin: (text: string) => Promise<void>,
  ) {}
  async tokensToday(day: string, providerModel: string): Promise<number> {
    const r = await this.db
      .prepare("SELECT tokens_in + tokens_out AS t FROM provider_usage WHERE day = ? AND provider_model = ?")
      .bind(day, providerModel)
      .first<{ t: number }>();
    return r?.t ?? 0;
  }
  async claimAlert(day: string, providerModel: string): Promise<boolean> {
    await this.db.prepare("DELETE FROM settings WHERE key LIKE ? AND key NOT LIKE ?").bind(`${ALERT_PREFIX}%`, `${ALERT_PREFIX}${day}:%`).run();
    const r = await this.db
      .prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)")
      .bind(`${ALERT_PREFIX}${day}:${providerModel}`, "true")
      .run();
    return r.meta.changes > 0;
  }
  async notify(info: { providerModel: string; used: number; budget: number }): Promise<void> {
    await this.sendAdmin(copyPresupuesto.presupuestoAlto(info.providerModel, info.used, info.budget));
  }
}

/** Sends to every `role=admin` chat of ALLOWED_CHAT_IDS. */
export function adminWarning(env: Env, f: typeof fetch = fetch): (text: string) => Promise<void> {
  return async (text) => {
    for (const [chatId, role] of parseAllowlist(env.ALLOWED_CHAT_IDS)) {
      if (role === "admin") await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, text, f);
    }
  };
}

/** Chat settings from the `settings` table, with in-code defaults for missing rows. */
export function loadChatSettings(db: D1DatabaseLike): Promise<ChatSettings> {
  return resolveChatSettings(async (key) => (await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>())?.value);
}

/** Everything `createGroqChatChain` needs from D1 (state, usage, 80 % alert). */
export async function chatChainDeps(env: Env, f: typeof fetch = fetch, now: () => number = Date.now) {
  const settings = await loadChatSettings(env.DB);
  return {
    settings,
    deps: {
      now,
      state: new D1ProviderStateStore(env.DB),
      usage: new D1UsageSink(env.DB),
      budget: new D1BudgetPort(env.DB, settings.dailyTokenBudget, adminWarning(env, f)),
    },
  };
}

/**
 * Queue delay for a failed update: a 429 (or any ProviderError carrying `retryAfterS`) is retried after the
 * provider's `retry-after`, never sooner; anything else uses the generic backoff. Capped at 1 h (queue max 12 h).
 */
export function retryDelayS(err: unknown, attempts: number, fallbackS = Math.min(30 * attempts, 300)): number {
  if (isProviderError(err) && err.retryAfterS !== undefined) return Math.min(Math.max(err.retryAfterS, 1), 3600);
  return fallbackS;
}

