import { describe, expect, it, vi } from "vitest";
import {
  ChatChain, FakeChatProvider, FakeSttProvider, GeminiChat, GroqChat, GroqStt, InMemoryStateStore, InMemoryUsageSink,
  ProviderError, SttChain, WorkersAiStt, createChatProvider, dayKey, parseProviderId,
} from "../../src/providers";
import type { ChatRequest, ChatResult } from "../../src/providers";

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });
const stub = (...rs: (Response | Error)[]) => {
  const f = vi.fn(async () => {
    const r = rs.length > 1 ? rs.shift()! : rs[0]!;
    if (r instanceof Error) throw r;
    return r.clone();
  });
  return f as unknown as typeof fetch & ReturnType<typeof vi.fn>;
};
const req: ChatRequest = { system: "sys", messages: [{ role: "user", content: "hola" }] };
const groqOk = (content: string | null, extra: object = {}) =>
  json({ choices: [{ message: { content, ...extra } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });

describe("GroqChat", () => {
  it("200: parses text and usage, sends key and tools", async () => {
    const f = stub(groqOk("hola!"));
    const r = await new GroqChat({ apiKey: "k", model: "m", fetch: f }).complete({
      ...req, tools: [{ name: "t", description: "d", parameters: { type: "object" } }],
    });
    expect(r).toMatchObject({ text: "hola!", toolCalls: [], usage: { tokensIn: 10, tokensOut: 5 } });
    const [url, init] = (f as any).mock.calls[0];
    expect(url).toContain("groq.com");
    expect(init.headers.authorization).toBe("Bearer k");
    expect(JSON.parse(init.body).tools[0].function.name).toBe("t");
  });

  it("parses tool calls", async () => {
    const f = stub(groqOk(null, { tool_calls: [{ id: "c1", function: { name: "t", arguments: '{"a":1}' } }] }));
    const r = await new GroqChat({ apiKey: "k", model: "m", fetch: f }).complete(req);
    expect(r.toolCalls).toEqual([{ id: "c1", name: "t", arguments: { a: 1 } }]);
  });

  it("json mode: sends response_format and parses", async () => {
    const f = stub(groqOk('{"x":1}'));
    const r = await new GroqChat({ apiKey: "k", model: "m", fetch: f }).complete({ ...req, json: { type: "object" } });
    expect(r.json).toEqual({ x: 1 });
    expect(JSON.parse((f as any).mock.calls[0][1].body).response_format.type).toBe("json_schema");
  });

  it("json mode: invalid JSON output -> bad_output", async () => {
    const f = stub(groqOk("not json"));
    await expect(new GroqChat({ apiKey: "k", model: "m", fetch: f }).complete({ ...req, json: {} })).rejects.toMatchObject({ kind: "bad_output" });
  });

  it("invalid JSON body -> bad_output", async () => {
    const f = stub(new Response("<html>", { status: 200 }));
    await expect(new GroqChat({ apiKey: "k", model: "m", fetch: f }).complete(req)).rejects.toMatchObject({ kind: "bad_output" });
  });

  it("429 with retry-after -> rate_limit with retryAfterS, no sleeping", async () => {
    const f = stub(new Response("{}", { status: 429, headers: { "retry-after": "17" } }));
    const t0 = Date.now();
    await expect(new GroqChat({ apiKey: "k", model: "m", fetch: f }).complete(req)).rejects.toMatchObject({ kind: "rate_limit", retryAfterS: 17 });
    expect(Date.now() - t0).toBeLessThan(500);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("503 -> unavailable; 401 -> fatal; network error -> unavailable", async () => {
    const c = (r: Response | Error) => new GroqChat({ apiKey: "k", model: "m", fetch: stub(r) }).complete(req);
    await expect(c(new Response("x", { status: 503 }))).rejects.toMatchObject({ kind: "unavailable", status: 503 });
    await expect(c(new Response("x", { status: 401 }))).rejects.toMatchObject({ kind: "fatal" });
    await expect(c(new TypeError("boom"))).rejects.toMatchObject({ kind: "unavailable" });
  });

  it("400 tool_use_failed (el modelo armó mal la herramienta) -> bad_output con status y código, no fatal", async () => {
    const body = { error: { message: "x".repeat(400), type: "invalid_request_error", code: "tool_use_failed" } };
    const f = stub(new Response(JSON.stringify(body), { status: 400 }));
    await expect(new GroqChat({ apiKey: "k", model: "m", fetch: f }).complete(req)).rejects.toMatchObject({ kind: "bad_output", status: 400, code: "tool_use_failed" });
  });

  it("otro 400 sigue siendo fatal y conserva el código", async () => {
    const f = stub(new Response(JSON.stringify({ error: { code: "invalid_api_key" } }), { status: 400 }));
    await expect(new GroqChat({ apiKey: "k", model: "m", fetch: f }).complete(req)).rejects.toMatchObject({ kind: "fatal", status: 400, code: "invalid_api_key" });
  });

  it("error messages never contain the api key", async () => {
    const f = stub(new Response("nope", { status: 500 }));
    const e = (await new GroqChat({ apiKey: "SECRET-KEY", model: "m", fetch: f }).complete(req).catch((x) => x)) as Error;
    expect(e.message).not.toContain("SECRET-KEY");
  });
});

describe("GeminiChat", () => {
  it("200: maps system, tools and parses text", async () => {
    const f = stub(json({ candidates: [{ content: { parts: [{ text: "ok" }] } }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 } }));
    const r = await new GeminiChat({ apiKey: "k", model: "g", fetch: f }).complete({
      ...req, tools: [{ name: "t", description: "d", parameters: { type: "object" } }],
    });
    expect(r).toMatchObject({ text: "ok", usage: { tokensIn: 3, tokensOut: 2 } });
    const body = JSON.parse((f as any).mock.calls[0][1].body);
    expect(body.systemInstruction.parts[0].text).toBe("sys");
    expect(body.tools[0].functionDeclarations[0].name).toBe("t");
  });
  it("503 -> unavailable, function call parsed", async () => {
    await expect(new GeminiChat({ apiKey: "k", model: "g", fetch: stub(new Response("x", { status: 503 })) }).complete(req)).rejects.toMatchObject({ kind: "unavailable" });
    const f = stub(json({ candidates: [{ content: { parts: [{ functionCall: { name: "t", args: { a: 1 } } }] } }] }));
    const r = await new GeminiChat({ apiKey: "k", model: "g", fetch: f }).complete(req);
    expect(r.toolCalls[0]).toMatchObject({ name: "t", arguments: { a: 1 } });
  });
});

describe("STT providers", () => {
  const audio = new Uint8Array([1, 2, 3]).buffer;
  it("Groq 200 flags low confidence from segments", async () => {
    const ok = stub(json({ text: " hola ", duration: 3.2, segments: [{ avg_logprob: -0.2, no_speech_prob: 0.01 }] }));
    expect(await new GroqStt({ apiKey: "k", model: "whisper-large-v3", fetch: ok }).transcribe(audio, "audio/ogg")).toEqual({ text: "hola", lowConfidence: false, audioS: 3.2 });
    const low = stub(json({ text: "eh", segments: [{ avg_logprob: -1.5 }] }));
    expect((await new GroqStt({ apiKey: "k", model: "m", fetch: low }).transcribe(audio, "audio/ogg")).lowConfidence).toBe(true);
  });
  it("Groq 429 retry-after and 503", async () => {
    const t = (r: Response) => new GroqStt({ apiKey: "k", model: "m", fetch: stub(r) }).transcribe(audio, "audio/ogg");
    await expect(t(new Response("", { status: 429, headers: { "retry-after": "5" } }))).rejects.toMatchObject({ kind: "rate_limit", retryAfterS: 5 });
    await expect(t(new Response("", { status: 503 }))).rejects.toMatchObject({ kind: "unavailable" });
  });
  it("WorkersAI 200 and invalid JSON", async () => {
    const o = { accountId: "a", apiToken: "t", model: "@cf/openai/whisper" };
    expect(await new WorkersAiStt({ ...o, fetch: stub(json({ result: { text: "hola" } })) }).transcribe(audio, "audio/ogg")).toMatchObject({ text: "hola" });
    await expect(new WorkersAiStt({ ...o, fetch: stub(new Response("zzz")) }).transcribe(audio, "audio/ogg")).rejects.toMatchObject({ kind: "bad_output" });
  });
});

describe("chain: fallback and cooldown", () => {
  const ok = (text: string): ChatResult => ({ text, toolCalls: [], usage: { tokensIn: 7, tokensOut: 3 } });
  const setup = (a: FakeChatProvider, b: FakeChatProvider, t = { v: 1_700_000_000_000 }) => {
    const state = new InMemoryStateStore(), usage = new InMemoryUsageSink(), fallbacks: string[] = [];
    const chain = new ChatChain([{ id: "a:m", provider: a }, { id: "b:m", provider: b }], {
      state, usage, now: () => t.v, onFallback: (i) => fallbacks.push(`${i.from}/${i.error.kind}`),
    });
    return { chain, state, usage, fallbacks, t };
  };

  it("uses the first provider on success and records usage", async () => {
    const a = new FakeChatProvider([ok("A")]), b = new FakeChatProvider([ok("B")]);
    const { chain, usage } = setup(a, b);
    expect((await chain.complete(req)).text).toBe("A");
    expect(chain.lastProviderModel).toBe("a:m");
    expect(b.requests).toHaveLength(0);
    expect(usage.deltas).toEqual([expect.objectContaining({ providerModel: "a:m", requests: 1, tokensIn: 7, tokensOut: 3, errors: 0 })]);
  });

  it("falls back to the second provider on 503 and reports it", async () => {
    const a = new FakeChatProvider([new ProviderError("unavailable", "x")]), b = new FakeChatProvider([ok("B")]);
    const { chain, fallbacks, usage } = setup(a, b);
    expect((await chain.complete(req)).text).toBe("B");
    expect(fallbacks).toEqual(["a:m/unavailable"]);
    expect(usage.deltas.find((d) => d.providerModel === "a:m")!.errors).toBe(1);
  });

  it("a tool_use_failed on one turn does not put the model in cooldown", async () => {
    const bad = new ProviderError("bad_output", "x", { status: 400, code: "tool_use_failed" });
    const a = new FakeChatProvider([bad]), b = new FakeChatProvider([bad]);
    const { chain, state } = setup(a, b);
    await expect(chain.complete(req)).rejects.toMatchObject({ kind: "bad_output", status: 400, code: "tool_use_failed" });
    expect((await state.get("a:m")).cooldownUntil).toBeNull();
    expect((await state.get("b:m")).cooldownUntil).toBeNull();
  });

  it("falls back on bad_output without opening the breaker", async () => {
    const a = new FakeChatProvider([new ProviderError("bad_output", "x")]), b = new FakeChatProvider([ok("B")]);
    const { chain, state } = setup(a, b);
    await chain.complete(req);
    expect(await state.get("a:m")).toEqual({ consecutiveFailures: 0, cooldownUntil: null });
  });

  it("429 puts the provider in cooldown for retry-after; it is skipped then retried after expiry", async () => {
    const a = new FakeChatProvider([new ProviderError("rate_limit", "x", { retryAfterS: 30 }), ok("A")]), b = new FakeChatProvider([ok("B")]);
    const { chain, t } = setup(a, b);
    expect((await chain.complete(req)).text).toBe("B");
    t.v += 10_000;
    expect((await chain.complete(req)).text).toBe("B");
    expect(a.requests).toHaveLength(1); // skipped during cooldown
    t.v += 21_000;
    expect((await chain.complete(req)).text).toBe("A");
  });

  it("3 consecutive 503s open a 10 min cooldown; success resets the counter", async () => {
    const e = new ProviderError("unavailable", "x");
    const a = new FakeChatProvider([e]), b = new FakeChatProvider([ok("B")]);
    const { chain, state, t } = setup(a, b);
    await chain.complete(req);
    await chain.complete(req);
    expect((await state.get("a:m")).cooldownUntil).toBeNull();
    await chain.complete(req);
    expect((await state.get("a:m")).cooldownUntil).toBe(t.v + 600_000);
    await chain.complete(req);
    expect(a.requests).toHaveLength(3);

    const a2 = new FakeChatProvider([e, e, ok("A"), e]);
    const s2 = setup(a2, new FakeChatProvider([ok("B")]));
    for (let i = 0; i < 4; i++) await s2.chain.complete(req);
    expect((await s2.state.get("a:m")).consecutiveFailures).toBe(1);
  });

  it("all failing: throws ProviderError with the soonest retryAfterS; all in cooldown also throws", async () => {
    const a = new FakeChatProvider([new ProviderError("rate_limit", "x", { retryAfterS: 40 })]);
    const b = new FakeChatProvider([new ProviderError("rate_limit", "y", { retryAfterS: 15 })]);
    const { chain, t } = setup(a, b);
    await expect(chain.complete(req)).rejects.toMatchObject({ kind: "rate_limit", retryAfterS: 15 });
    t.v += 5_000;
    await expect(chain.complete(req)).rejects.toMatchObject({ kind: "unavailable", retryAfterS: 10 });
    expect(a.requests).toHaveLength(1);
  });

  it("works end to end with stubbed fetch (Groq 429 -> Gemini 200) and with STT", async () => {
    const groq = new GroqChat({ apiKey: "k", model: "m", fetch: stub(new Response("", { status: 429, headers: { "retry-after": "9" } })) });
    const gem = new GeminiChat({ apiKey: "k", model: "g", fetch: stub(json({ candidates: [{ content: { parts: [{ text: "gem" }] } }] })) });
    const chain = new ChatChain([{ id: "groq:m", provider: groq }, { id: "gemini:g", provider: gem }], { state: new InMemoryStateStore(), usage: new InMemoryUsageSink() });
    expect((await chain.complete(req)).text).toBe("gem");

    const stt = new SttChain(
      [{ id: "groq:w", provider: new FakeSttProvider([new ProviderError("unavailable", "x")]) }, { id: "workersai:w", provider: new FakeSttProvider([{ text: "hola", lowConfidence: false }]) }],
      { state: new InMemoryStateStore(), usage: new InMemoryUsageSink() },
    );
    expect((await stt.transcribe(new ArrayBuffer(2), "audio/ogg")).text).toBe("hola");
  });
});

describe("helpers", () => {
  it("parseProviderId and createChatProvider", () => {
    expect(parseProviderId("groq:openai/gpt-oss-120b")).toEqual({ provider: "groq", model: "openai/gpt-oss-120b" });
    expect(() => parseProviderId("nope")).toThrow();
    expect(() => createChatProvider("groq:m", {})).toThrow();
    expect(createChatProvider("groq:m", { groqApiKey: "k" })).toBeInstanceOf(GroqChat);
  });
  it("dayKey uses Argentina time", () => {
    expect(dayKey(Date.parse("2026-03-02T01:00:00Z"))).toBe("2026-03-01");
  });
});
