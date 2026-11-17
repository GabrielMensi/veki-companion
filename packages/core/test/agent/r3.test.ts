import { describe, expect, it } from "vitest";
import { FakeChatProvider } from "../../src/providers";
import { MAX_HISTORY, MAX_LLM_CALLS, emptyState, runAgent, trimHistory, type AgentState, type HistoryItem } from "../../src";
import { call, FakeHost, say, turn } from "./helpers";

const hist = (n: number): HistoryItem[] =>
  Array.from({ length: n }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `m${i}` }) as HistoryItem);

describe("R3: recorte de historial", () => {
  it("por defecto se reenvían y guardan solo los últimos 6 mensajes", async () => {
    expect(MAX_HISTORY).toBe(6);
    const lens: number[] = [];
    const chat = new FakeChatProvider([(r) => (lens.push(r.messages.length), say("ok"))]);
    const res = await runAgent({ chat, host: new FakeHost() }, { state: emptyState(), history: hist(12), input: { chatId: 1, text: "nuevo" } });
    // 6 del historial + el mensaje nuevo
    expect(lens).toEqual([6 + 1]);
    expect((chat.requests[0]!.messages[0] as { content: string }).content).toBe("m6");
    expect(res.history).toHaveLength(6);
    expect(res.history.at(-1)).toEqual({ role: "assistant", content: "ok" });
  });

  it("el largo es configurable", async () => {
    const lens: number[] = [];
    const chat = new FakeChatProvider([(r) => (lens.push(r.messages.length), say("ok"))]);
    await runAgent({ chat, host: new FakeHost(), historyLength: 2 }, { state: emptyState(), history: hist(12), input: { chatId: 1, text: "x" } });
    expect(lens).toEqual([2 + 1]);
    expect(trimHistory(hist(10), 4)).toHaveLength(4);
  });

  it("con una acción pendiente, el system lleva su resumen aunque el historial la haya perdido", async () => {
    const preview = "Voy a cargar Riñonera Girasol a $12.500. ¿Confirmás?";
    const history = [...hist(2), { role: "assistant", content: preview } as HistoryItem];
    const state: AgentState = { ...emptyState(), awaiting: { kind: "edit", pending_action_id: "pa1" } };
    const chat = new FakeChatProvider([say("ok")]);
    await runAgent({ chat, host: new FakeHost(), historyLength: 1 }, { state, history: [...history, ...hist(0)], input: { chatId: 1, text: "cambiá el precio" } });
    expect(chat.requests[0]!.system).toContain(`Acción pendiente: ${preview}`);
    const noPending = new FakeChatProvider([say("ok")]);
    await runAgent({ chat: noPending, host: new FakeHost() }, { state: emptyState(), history, input: { chatId: 1, text: "hola" } });
    expect(noPending.requests[0]!.system).not.toContain("Acción pendiente");
  });
});

describe("R3: tope de llamadas por update", () => {
  it("el tope por defecto es 3 y se puede configurar", async () => {
    expect(MAX_LLM_CALLS).toBe(3);
    const loop = turn(call("buscar_productos", { consulta: "x" }));
    const a = new FakeChatProvider([loop]);
    await runAgent({ chat: a, host: new FakeHost() }, { state: emptyState(), history: [], input: { chatId: 1, text: "x" } });
    expect(a.requests).toHaveLength(3);
    const b = new FakeChatProvider([loop]);
    await runAgent({ chat: b, host: new FakeHost(), maxLlmCalls: 2 }, { state: emptyState(), history: [], input: { chatId: 1, text: "x" } });
    expect(b.requests).toHaveLength(2);
  });
});
