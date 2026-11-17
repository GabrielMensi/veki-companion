import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProviderError } from "@veki/core";
import type { Env } from "../src/env";
import { buildChatChain } from "../src/runtime";
import { handleBatch, type Handler, type QueueMessageLike } from "../src/queues";

// Todo inventado: token, ids y respuestas del proveedor.
const db = (env as unknown as { DB: Env["DB"] }).DB;
const CHAT = 777;
const mkEnv = (extra: Partial<Env> = {}) =>
  ({ DB: db, MEDIA: null, Q_UPDATES: { send: async () => {} }, Q_JOBS: { send: async () => {} }, TELEGRAM_BOT_TOKEN: "t", TG_WEBHOOK_SECRET: "s", ALLOWED_CHAT_IDS: `${CHAT}:owner,9:admin`, GROQ_API_KEY: "k", ...extra }) as Env;

const realFetch = globalThis.fetch;
type Call = { url: string; body: any };
let calls: Call[] = [];
const stubFetch = (groq: () => Response) => {
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : null });
    return url.includes("groq.com") ? groq() : Response.json({ ok: true, result: { message_id: 1 } });
  }) as typeof fetch;
};

beforeEach(async () => {
  for (const t of ["provider_usage", "provider_state", "updates"]) await db.prepare(`DELETE FROM ${t}`).run();
  await db.prepare("DELETE FROM settings").run();
});
afterEach(() => void (globalThis.fetch = realFetch));

const groqOk = () =>
  Response.json({ choices: [{ message: { content: "hola" } }], usage: { prompt_tokens: 12, completion_tokens: 3 } });

describe("buildChatChain (R3)", () => {
  it("builds the Groq chain from settings and passes limits to the agent", async () => {
    await db.prepare("INSERT INTO settings (key, value) VALUES ('chat.models', '[\"groq:openai/gpt-oss-20b\"]'), ('chat.history_length', '4'), ('chat.tool_call_cap', '2')").run();
    stubFetch(groqOk);
    const chat = buildChatChain(mkEnv());
    expect(await chat.agentLimits!()).toEqual({ maxLlmCalls: 2, historyLength: 4 });
    const r = await chat.complete({ system: "s", messages: [{ role: "user", content: "hola" }] });
    expect(r.text).toBe("hola");
    expect(calls[0]!.body.model).toBe("openai/gpt-oss-20b");
    const u = await db.prepare("SELECT provider_model m, tokens_in i, tokens_out o FROM provider_usage").first();
    expect(u).toEqual({ m: "groq:openai/gpt-oss-20b", i: 12, o: 3 });
  });

  it("without settings rows: default chain 120b first and default limits", async () => {
    stubFetch(groqOk);
    const chat = buildChatChain(mkEnv());
    expect(await chat.agentLimits!()).toEqual({ maxLlmCalls: 3, historyLength: 6 });
    await chat.complete({ system: "s", messages: [{ role: "user", content: "hola" }] });
    expect(calls[0]!.body.model).toBe("openai/gpt-oss-120b");
  });

  it("a missing key fails only that call", async () => {
    stubFetch(groqOk);
    const chat = buildChatChain(mkEnv({ GROQ_API_KEY: undefined }));
    await expect(chat.complete({ system: "s", messages: [] })).rejects.toThrow();
  });
});

describe("handleBatch rate-limit handling (R3)", () => {
  const run = async (err: unknown, attempts: number) => {
    stubFetch(groqOk);
    const retries: (number | undefined)[] = [];
    let acked = 0;
    const m: QueueMessageLike = {
      body: { type: "update", update_id: 5, update: { message: { chat: { id: CHAT } } } }, attempts,
      ack: () => void acked++, retry: (o) => void retries.push(o?.delaySeconds),
    };
    const router: Record<string, Handler> = { update: async () => { throw err; } };
    await handleBatch({ queue: "q-updates", messages: [m] }, mkEnv(), router);
    return { retries, acked, sends: calls.filter((c) => c.url.includes("sendMessage")) };
  };

  it("rate limit: retries after retry-after and sends the friendly message once", async () => {
    const err = new ProviderError("rate_limit", "x", { retryAfterS: 120 });
    const first = await run(err, 1);
    expect(first.retries).toEqual([120]);
    expect(first.acked).toBe(0);
    expect(first.sends).toHaveLength(1);
    expect(first.sends[0]!.body.chat_id).toBe(CHAT);
    expect(first.sends[0]!.body.text).toContain("te aviso en un ratito");
    const second = await run(err, 2);
    expect(second.retries).toEqual([120]);
    expect(second.sends).toHaveLength(0);
  });

  it("other errors keep the generic backoff and send nothing", async () => {
    const r = await run(new Error("boom"), 2);
    expect(r.retries).toEqual([60]);
    expect(r.sends).toHaveLength(0);
  });

  const runJob = async (body: Record<string, unknown>, attempts: number, router?: Record<string, Handler>) => {
    stubFetch(groqOk);
    const retries: (number | undefined)[] = [];
    const m: QueueMessageLike = { body, attempts, ack: () => {}, retry: (o) => void retries.push(o?.delaySeconds) };
    const r = router ?? { [String(body.type)]: async () => { throw new ProviderError("rate_limit", "x", { retryAfterS: 90 }); } };
    await handleBatch({ queue: "q-jobs", messages: [m] }, mkEnv(), r);
    return { retries, sends: calls.filter((c) => c.url.includes("sendMessage")) };
  };

  it("job carrying chat_id: friendly message once, none on the retry (no double send)", async () => {
    const first = await runJob({ type: "content.generate", chat_id: CHAT }, 1);
    expect(first.retries).toEqual([90]);
    expect(first.sends).toHaveLength(1);
    expect(first.sends[0]!.body.chat_id).toBe(CHAT);
    expect(first.sends[0]!.body.text).toContain("te aviso en un ratito");
    const second = await runJob({ type: "content.generate", chat_id: CHAT }, 2);
    expect(second.retries).toEqual([90]);
    expect(second.sends).toHaveLength(0);
  });

  it("album.flush resolves the chat from inbox_groups, sends once and not on the retry", async () => {
    await db.prepare("DELETE FROM inbox_groups").run();
    await db.prepare("INSERT INTO inbox_groups (media_group_id, chat_id, item_count, first_at, last_at, status) VALUES ('g-busy', ?, 1, 1, 1, 'open')").bind(CHAT).run();
    const first = await runJob({ type: "album.flush", gid: "g-busy" }, 1);
    expect(first.sends).toHaveLength(1);
    expect(first.sends[0]!.body.chat_id).toBe(CHAT);
    expect((await runJob({ type: "album.flush", gid: "g-busy" }, 2)).sends).toHaveLength(0);
  });

  it("real album.flush handler: all models rate-limited -> one friendly message, group reopened for the retry", async () => {
    const { handlers } = await import("../src/queues");
    const { setAgentEntry } = await import("../src/jobs/album-flush");
    await db.prepare("DELETE FROM inbox_groups").run();
    await db.prepare("INSERT INTO inbox_groups (media_group_id, chat_id, item_count, first_at, last_at, status) VALUES ('g-real', ?, 1, 1, 1, 'open')").bind(CHAT).run();
    setAgentEntry(async () => { throw new ProviderError("rate_limit", "x", { retryAfterS: 45 }); });
    try {
      const first = await runJob({ type: "album.flush", gid: "g-real" }, 1, handlers);
      expect(first.retries).toEqual([45]);
      expect(first.sends).toHaveLength(1);
      expect(first.sends[0]!.body.chat_id).toBe(CHAT);
      const second = await runJob({ type: "album.flush", gid: "g-real" }, 2, handlers);
      expect(second.retries).toEqual([45]);
      expect(second.sends).toHaveLength(0);
    } finally {
      setAgentEntry(null);
    }
  });

  it("job without any resolvable chat sends nothing but still retries", async () => {
    const r = await runJob({ type: "content.generate" }, 1);
    expect(r.retries).toEqual([90]);
    expect(r.sends).toHaveLength(0);
    const unknownGroup = await runJob({ type: "album.flush", gid: "no-such-group" }, 1);
    expect(unknownGroup.sends).toHaveLength(0);
  });
});
