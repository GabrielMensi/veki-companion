import { ChatChain, createChatProvider, type ChainDeps, type ProviderCreds } from "./chain";
import type { ChainEntry, ChatProvider, UsageDelta, UsageSink } from "./types";

/**
 * Chat chain, all on Groq (decision Q5: Gemini stays OUT of chat). Ids verified on
 * https://console.groq.com/docs/models (gpt-oss-120b/20b: production; qwen/qwen3.8-27b: preview).
 * Groq limits are per model and per organization (~8K TPM, ~200K tokens/day each; free plan unverified,
 * https://console.groq.com/docs/rate-limits), so chaining models adds their daily budgets.
 */
export const DEFAULT_CHAT_MODELS = ["groq:openai/gpt-oss-120b", "groq:openai/gpt-oss-20b", "groq:qwen/qwen3.8-27b"];

export const SETTING_KEYS = {
  models: "chat.models",
  dailyTokenBudget: "chat.daily_token_budget",
  historyLength: "chat.history_length",
  toolCallCap: "chat.tool_call_cap",
} as const;

export type ChatSettings = {
  models: string[];
  /** Daily token budget PER MODEL. */
  dailyTokenBudget: number;
  /** History items (user/assistant messages) resent on each call. */
  historyLength: number;
  /** Max LLM calls per update. */
  toolCallCap: number;
};

export const DEFAULT_CHAT_SETTINGS: ChatSettings = {
  models: DEFAULT_CHAT_MODELS,
  dailyTokenBudget: 200_000,
  historyLength: 6,
  toolCallCap: 3,
};

/** Fraction of the daily budget that triggers the admin warning. */
export const BUDGET_ALERT_RATIO = 0.8;

const posInt = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined) return fallback;
  try {
    const n = JSON.parse(raw);
    return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : fallback;
  } catch {
    return fallback;
  }
};

/** Reads the chat settings (JSON values); a missing or invalid row falls back to the in-code default (no migration). */
export async function resolveChatSettings(read: (key: string) => Promise<string | undefined>): Promise<ChatSettings> {
  const d = DEFAULT_CHAT_SETTINGS;
  let models = d.models;
  const rawModels = await read(SETTING_KEYS.models);
  if (rawModels !== undefined) {
    try {
      const m = JSON.parse(rawModels);
      if (Array.isArray(m) && m.length > 0 && m.every((x) => typeof x === "string" && x.startsWith("groq:"))) models = m;
    } catch {
      /* keep default */
    }
  }
  return {
    models,
    dailyTokenBudget: posInt(await read(SETTING_KEYS.dailyTokenBudget), d.dailyTokenBudget),
    historyLength: posInt(await read(SETTING_KEYS.historyLength), d.historyLength),
    toolCallCap: posInt(await read(SETTING_KEYS.toolCallCap), d.toolCallCap),
  };
}

export interface BudgetPort {
  /** Tokens (in + out) already recorded today for this model. */
  tokensToday(day: string, providerModel: string): Promise<number>;
  /** Atomically claims today's alert for a model: true only the first time per day. */
  claimAlert(day: string, providerModel: string): Promise<boolean>;
  /** Warning to the admin chat. */
  notify(info: { providerModel: string; used: number; budget: number }): Promise<void>;
}

/** Wraps a UsageSink: after each recorded call, warns once per day per model at 80% of the daily budget. */
export class BudgetAlertUsageSink implements UsageSink {
  constructor(private inner: UsageSink, private port: BudgetPort, private budget: number) {}
  async record(d: UsageDelta): Promise<void> {
    await this.inner.record(d);
    if (d.tokensIn + d.tokensOut === 0) return;
    try {
      const used = await this.port.tokensToday(d.day, d.providerModel);
      if (used >= this.budget * BUDGET_ALERT_RATIO && (await this.port.claimAlert(d.day, d.providerModel))) {
        await this.port.notify({ providerModel: d.providerModel, used, budget: this.budget });
      }
    } catch {
      /* an alert failure must never fail the user's turn */
    }
  }
}

/** Builds the Groq chat chain from settings. Creds must include `groqApiKey`. */
export function createGroqChatChain(
  settings: ChatSettings,
  creds: ProviderCreds,
  deps: Omit<ChainDeps, "usage"> & { usage: UsageSink; budget?: BudgetPort },
): ChatChain {
  const entries: ChainEntry<ChatProvider>[] = settings.models.map((id) => ({ id, provider: createChatProvider(id, creds) }));
  const usage = deps.budget ? new BudgetAlertUsageSink(deps.usage, deps.budget, settings.dailyTokenBudget) : deps.usage;
  return new ChatChain(entries, { ...deps, usage });
}
