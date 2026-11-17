import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { BudgetAlertUsageSink, ChatChain, FakeChatProvider, ProviderError, dayKey, type ChatResult } from "@veki/core";
import type { Env } from "../src/env";
import { D1BudgetPort, D1ProviderStateStore, D1UsageSink, adminWarning, loadChatSettings, retryDelayS } from "../src/provider-ports";

const db = (env as unknown as { DB: Env["DB"] }).DB;
const T0 = 1_700_000_000_000;
const ok = (tokensIn: number): ChatResult => ({ text: "A", toolCalls: [], usage: { tokensIn, tokensOut: 0 } });
const req = { system: "s", messages: [{ role: "user" as const, content: "hola" }] };

beforeEach(async () => {
  for (const t of ["provider_usage", "provider_state"]) await db.prepare(`DELETE FROM ${t}`).run();
  await db.prepare("DELETE FROM settings").run();
});

describe("D1 provider ports", () => {
  it("usage UPSERT accumulates per day and model", async () => {
    const u = new D1UsageSink(db);
    const d = { day: "2026-01-01", providerModel: "groq:m", requests: 1, tokensIn: 10, tokensOut: 5, audioS: 0, errors: 0 };
    await u.record(d);
    await u.record({ ...d, tokensIn: 20, errors: 1 });
    const row = await db.prepare("SELECT requests r, tokens_in i, tokens_out o, errors e FROM provider_usage").first();
    expect(row).toEqual({ r: 2, i: 30, o: 10, e: 1 });
  });

  it("provider state round trip", async () => {
    const s = new D1ProviderStateStore(db);
    expect(await s.get("x")).toEqual({ consecutiveFailures: 0, cooldownUntil: null });
    await s.set("x", { consecutiveFailures: 2, cooldownUntil: 99 });
    await s.set("x", { consecutiveFailures: 3, cooldownUntil: null });
    expect(await s.get("x")).toEqual({ consecutiveFailures: 3, cooldownUntil: null });
  });

  it("80% alert reaches the admin chat once per day per model", async () => {
    const sent: { chat: number; text: string }[] = [];
    const f = (async (_u: string, init: RequestInit) => {
      const b = JSON.parse(init.body as string);
      sent.push({ chat: b.chat_id, text: b.text });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const e = { DB: db, TELEGRAM_BOT_TOKEN: "t", ALLOWED_CHAT_IDS: "1:owner,2:admin" } as unknown as Env;
    const sink = new BudgetAlertUsageSink(new D1UsageSink(db), new D1BudgetPort(db, 1000, adminWarning(e, f)), 1000);
    const t = { v: T0 };
    const chain = new ChatChain([{ id: "groq:m", provider: new FakeChatProvider([ok(500)]) }], { state: new D1ProviderStateStore(db), usage: sink, now: () => t.v });
    await chain.complete(req); // 500
    expect(sent).toHaveLength(0);
    await chain.complete(req); // 1000 -> alert
    await chain.complete(req); // 1500 -> same day, no more
    expect(sent).toHaveLength(1);
    expect(sent[0]!.chat).toBe(2);
    expect(sent[0]!.text).toContain("groq:m");
    t.v += 24 * 3600_000;
    expect(dayKey(t.v)).not.toBe(dayKey(T0));
    await chain.complete(req); // new day: 500, below 80% of 1000? 500 < 800
    await chain.complete(req); // 1000 -> alert again
    expect(sent).toHaveLength(2);
  });

  it("settings fall back to defaults and honor rows", async () => {
    expect((await loadChatSettings(db)).dailyTokenBudget).toBe(200_000);
    await db.prepare("INSERT INTO settings (key, value) VALUES ('chat.daily_token_budget', '50000')").run();
    expect((await loadChatSettings(db)).dailyTokenBudget).toBe(50_000);
  });

  it("retryDelayS honors retry-after from a 429 and falls back otherwise", () => {
    expect(retryDelayS(new ProviderError("rate_limit", "x", { retryAfterS: 120 }), 1)).toBe(120);
    expect(retryDelayS(new ProviderError("rate_limit", "x", { retryAfterS: 99999 }), 1)).toBe(3600);
    expect(retryDelayS(new Error("boom"), 2)).toBe(60);
  });
});
