import { describe, expect, it } from "vitest";
import {
  BudgetAlertUsageSink, DEFAULT_CHAT_MODELS, FakeChatProvider, InMemoryStateStore, InMemoryUsageSink, ProviderError, ChatChain,
  dayKey, resolveChatSettings, type BudgetPort, type ChatResult,
} from "../../src/providers";

const req = { system: "s", messages: [{ role: "user" as const, content: "hola" }] };
const ok = (text: string, tokensIn = 100, tokensOut = 0): ChatResult => ({ text, toolCalls: [], usage: { tokensIn, tokensOut } });
const T0 = 1_700_000_000_000;

/** In-memory BudgetPort fed by the same usage stream. */
function memoryBudget() {
  const totals = new Map<string, number>(), claimed = new Set<string>(), alerts: string[] = [];
  const port: BudgetPort = {
    tokensToday: async (d, m) => totals.get(`${d}|${m}`) ?? 0,
    claimAlert: async (d, m) => (claimed.has(`${d}|${m}`) ? false : (claimed.add(`${d}|${m}`), true)),
    notify: async (i) => void alerts.push(i.providerModel),
  };
  const inner = new InMemoryUsageSink();
  const origin = inner.record.bind(inner);
  inner.record = async (d) => {
    await origin(d);
    totals.set(`${d.day}|${d.providerModel}`, (totals.get(`${d.day}|${d.providerModel}`) ?? 0) + d.tokensIn + d.tokensOut);
  };
  return { port, inner, alerts };
}

describe("chat chain over Groq models (FakeChatProvider)", () => {
  const ids = DEFAULT_CHAT_MODELS;
  const mk = (a: FakeChatProvider, b: FakeChatProvider, c: FakeChatProvider, t = { v: T0 }) => {
    const state = new InMemoryStateStore(), usage = new InMemoryUsageSink();
    const chain = new ChatChain(ids.map((id, i) => ({ id, provider: [a, b, c][i]! })), { state, usage, now: () => t.v });
    return { chain, state, usage, t };
  };

  it("default chain is gpt-oss-120b -> gpt-oss-20b -> qwen3.8-27b, all Groq (no Gemini)", () => {
    expect(ids).toEqual(["groq:openai/gpt-oss-120b", "groq:openai/gpt-oss-20b", "groq:qwen/qwen3.8-27b"]);
  });

  it("fallback order: 429 on the first goes to the second, then the third", async () => {
    const a = new FakeChatProvider([new ProviderError("rate_limit", "x", { retryAfterS: 30 })]);
    const b = new FakeChatProvider([new ProviderError("rate_limit", "x", { retryAfterS: 30 })]);
    const c = new FakeChatProvider([ok("C")]);
    const { chain } = mk(a, b, c);
    expect((await chain.complete(req)).text).toBe("C");
    expect([a.requests.length, b.requests.length, c.requests.length]).toEqual([1, 1, 1]);
    expect(chain.lastProviderModel).toBe(ids[2]);
  });

  it("cooldown: a 429 with retry-after skips that model until it expires", async () => {
    const a = new FakeChatProvider([new ProviderError("rate_limit", "x", { retryAfterS: 60 }), ok("A")]);
    const b = new FakeChatProvider([ok("B")]);
    const { chain, t } = mk(a, b, new FakeChatProvider([ok("C")]));
    expect((await chain.complete(req)).text).toBe("B");
    t.v += 30_000;
    expect((await chain.complete(req)).text).toBe("B");
    expect(a.requests).toHaveLength(1);
    t.v += 31_000;
    expect((await chain.complete(req)).text).toBe("A");
  });

  it("all models rate limited: throws rate_limit carrying the soonest retry-after (queue retries, user sees no error)", async () => {
    const rl = (s: number) => new FakeChatProvider([new ProviderError("rate_limit", "x", { retryAfterS: s })]);
    const { chain } = mk(rl(120), rl(45), rl(300));
    await expect(chain.complete(req)).rejects.toMatchObject({ kind: "rate_limit", retryAfterS: 45 });
  });
});

describe("80% daily budget alert", () => {
  const run = async (budget: number, calls: { t: number; model?: number }[]) => {
    const { port, inner, alerts } = memoryBudget();
    const t = { v: T0 };
    const sink = new BudgetAlertUsageSink(inner, port, budget);
    const p = new FakeChatProvider([ok("A", 400)]);
    const chain = new ChatChain([{ id: "groq:m", provider: p }], { state: new InMemoryStateStore(), usage: sink, now: () => t.v });
    for (const c of calls) {
      t.v = c.t;
      await chain.complete(req);
    }
    return { alerts, inner };
  };

  it("does not fire below 80%", async () => {
    expect((await run(1000, [{ t: T0 }])).alerts).toEqual([]); // 400 < 800
  });

  it("fires once when crossing 80% and not again the same day", async () => {
    const { alerts } = await run(1000, [{ t: T0 }, { t: T0 }, { t: T0 }, { t: T0 }]); // 400,800,1200,1600
    expect(alerts).toEqual(["groq:m"]);
  });

  it("fires again on the next day (Argentina day key)", async () => {
    const next = T0 + 24 * 3600_000;
    expect(dayKey(next)).not.toBe(dayKey(T0));
    const { alerts } = await run(800, [{ t: T0 }, { t: T0 }, { t: next }, { t: next }]);
    expect(alerts).toEqual(["groq:m", "groq:m"]);
  });

  it("an alert failure never breaks the turn", async () => {
    const { port, inner } = memoryBudget();
    port.notify = async () => { throw new Error("telegram down"); };
    const sink = new BudgetAlertUsageSink(inner, port, 100);
    const chain = new ChatChain([{ id: "groq:m", provider: new FakeChatProvider([ok("A", 400)]) }], { state: new InMemoryStateStore(), usage: sink });
    expect((await chain.complete(req)).text).toBe("A");
  });
});

describe("resolveChatSettings", () => {
  it("missing rows use the in-code defaults", async () => {
    expect(await resolveChatSettings(async () => undefined)).toEqual({
      models: DEFAULT_CHAT_MODELS, dailyTokenBudget: 200_000, historyLength: 6, toolCallCap: 3,
    });
  });
  it("reads overrides and ignores invalid values (incl. non-Groq models)", async () => {
    const rows: Record<string, string> = {
      "chat.models": '["groq:openai/gpt-oss-20b"]', "chat.daily_token_budget": "100000", "chat.history_length": "nope", "chat.tool_call_cap": "-1",
    };
    const s = await resolveChatSettings(async (k) => rows[k]);
    expect(s).toMatchObject({ models: ["groq:openai/gpt-oss-20b"], dailyTokenBudget: 100_000, historyLength: 6, toolCallCap: 3 });
    expect((await resolveChatSettings(async (k) => (k === "chat.models" ? '["gemini:x"]' : undefined))).models).toEqual(DEFAULT_CHAT_MODELS);
  });
});
