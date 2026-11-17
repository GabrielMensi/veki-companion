import { describe, expect, it } from "vitest";
import { FakeChatProvider } from "../../src/providers";
import { copy, emptyState, runAgent, nextMissingField, applyDraftUpdate, type AgentState } from "../../src";
import { call, FakeHost, say, turn } from "./helpers";

const run = (script: ConstructorParameters<typeof FakeChatProvider>[0], state: AgentState = emptyState(), text = "hola") => {
  const chat = new FakeChatProvider(script);
  const host = new FakeHost();
  return { chat, host, p: runAgent({ chat, host }, { state, history: [], input: { chatId: 1, text } }) };
};

describe("nextMissingField", () => {
  it("sigue el orden name → price_ars → category → foto", () => {
    let d = applyDraftUpdate(null, "producto", { name: "Riñonera Girasol" });
    expect(nextMissingField(d)).toBe("price_ars");
    d = applyDraftUpdate(d, "producto", { price_ars: "consultar" });
    expect(nextMissingField(d)).toBe("category");
    d = applyDraftUpdate(d, "producto", { category: "riñoneras" });
    expect(nextMissingField(d)).toBe("media_ids");
    d = applyDraftUpdate(d, "producto", {}, ["m1", "m1"]);
    expect(d.media_ids).toEqual(["m1"]);
    expect(nextMissingField(d)).toBeNull();
  });
});

describe("borrador", () => {
  it("actualiza el borrador y el prompt pide solo el campo que falta", async () => {
    const { chat, p } = run([
      turn(call("actualizar_borrador", { tipo: "producto", campos: { name: "Riñonera Girasol", price_ars: 12500 }, media_ids: ["m1"] })),
      say("¿En qué categoría la ponemos?"),
    ]);
    const res = await p;
    expect(res.output.texto).toBe("¿En qué categoría la ponemos?");
    expect(res.state.draft?.campos.name).toBe("Riñonera Girasol");
    expect(chat.requests).toHaveLength(2);
    // El system de la 2ª llamada trae el estado con UN solo campo faltante.
    const sys = chat.requests[1]!.system;
    expect(sys).toContain("Falta: category");
    expect(sys).not.toContain("Falta: name");
    // Y el resultado de la herramienta también.
    const toolMsg = chat.requests[1]!.messages.find((m) => m.role === "tool");
    expect(toolMsg && "content" in toolMsg && toolMsg.content).toContain("Falta: category");
  });

  it("crear_producto con borrador incompleto no crea acción y dice qué falta", async () => {
    const state: AgentState = { ...emptyState(), draft: applyDraftUpdate(null, "producto", { name: "X" }) };
    const { chat, host, p } = run([turn(call("crear_producto", {})), say("¿Cuánto sale?")], state);
    const res = await p;
    expect(host.pending).toHaveLength(0);
    expect(res.output.texto).toBe("¿Cuánto sale?");
    const toolMsg = chat.requests[1]!.messages.find((m) => m.role === "tool");
    expect(toolMsg && "content" in toolMsg && toolMsg.content).toContain("Falta price_ars");
  });

  it("crear_producto con borrador completo crea una acción pendiente con vista previa y botones", async () => {
    let d = applyDraftUpdate(null, "producto", { name: "Riñonera Girasol", price_ars: 12500, category: "riñoneras" }, ["m1", "m2"]);
    const { host, p } = run([turn(call("crear_producto", {}))], { ...emptyState(), draft: d });
    const res = await p;
    expect(host.pending).toHaveLength(1);
    expect(host.pending[0]!.tool).toBe("crear_producto");
    expect(host.pending[0]!.args).toEqual({ draft: d });
    expect(res.output.pendingActionId).toBe("pa1");
    expect(res.output.texto).toContain("Riñonera Girasol — $12.500");
    expect(res.output.botones?.map((b) => b.valor)).toEqual(["pa:pa1:yes", "pa:pa1:edit", "pa:pa1:no"]);
  });

  it("'Cambiar': la nueva acción reemplaza a la anterior (supersedes)", async () => {
    const state: AgentState = { ...emptyState(), awaiting: { kind: "edit", pending_action_id: "old" } };
    const { host, p } = run([turn(call("cancelar_feria", { feria_id: "f1" }))], state);
    const res = await p;
    expect(host.pending[0]!.supersedes).toBe("old");
    expect(res.state.awaiting).toBeNull();
  });
});

describe("responder", () => {
  it("dos '?' → rechaza y regenera una vez", async () => {
    const { chat, p } = run([say("¿Cómo se llama? ¿Y cuánto sale?"), say("¿Cómo se llama?")]);
    const res = await p;
    expect(res.output.texto).toBe("¿Cómo se llama?");
    expect(res.llmCalls).toBe(2);
    const rejected = chat.requests[1]!.messages.find((m) => m.role === "tool");
    expect(rejected && "content" in rejected && rejected.content).toMatch(/Rechazada/);
  });

  it("si vuelve a fallar tras regenerar, recorta a la primera pregunta (no hay tercera vuelta)", async () => {
    const { p } = run([say("¿Cómo se llama? ¿Y cuánto sale?")]);
    const res = await p;
    expect(res.llmCalls).toBe(2);
    expect(res.output.texto).toBe("¿Cómo se llama?");
    expect(res.misunderstood).toBe(false);
  });

  it("texto > 350 caracteres se rechaza", async () => {
    const { p } = run([say("a".repeat(351)), say("Listo, dale.")]);
    expect((await p).output.texto).toBe("Listo, dale.");
  });
});

describe("tope de 3 llamadas", () => {
  it("3 llamadas sin salida → copy.noEntendi y +1 malentendido", async () => {
    const { chat, p } = run([turn(call("buscar_productos", { consulta: "riñonera" }))]);
    const res = await p;
    expect(chat.requests).toHaveLength(3);
    expect(res.output.texto).toBe(copy.noEntendi);
    expect(res.misunderstood).toBe(true);
    expect(res.state.misunderstandings).toBe(1);
    expect(res.escalate).toBe(false);
  });

  it("2 malentendidos seguidos → atajos y aviso a Gabriel", async () => {
    const state: AgentState = { ...emptyState(), misunderstandings: 1 };
    const res = await run([turn(call("buscar_productos", { consulta: "x" }))], state).p;
    expect(res.output.botones?.map((b) => b.etiqueta)).toEqual(["Cargar producto", "Vendí algo", "Nueva feria", "Pedir flyer"]);
    expect(res.escalate).toBe(true);
    expect(res.state.misunderstandings).toBe(0);
  });

  it("una salida válida reinicia los malentendidos", async () => {
    const res = await run([say("¡Hola!")], { ...emptyState(), misunderstandings: 1 }).p;
    expect(res.state.misunderstandings).toBe(0);
  });

  it("texto suelto sin herramienta se empuja hacia responder", async () => {
    const res = await run([{ text: "hola", toolCalls: [], usage: { tokensIn: 1, tokensOut: 1 } }, say("¡Hola!")]).p;
    expect(res.output.texto).toBe("¡Hola!");
    expect(res.llmCalls).toBe(2);
  });
});

describe("lecturas e historial", () => {
  it("una lectura vuelve al modelo y luego responde; el historial guarda solo texto", async () => {
    const { chat, p } = run([turn(call("buscar_productos", { consulta: "girasol" })), say("Tenés una Riñonera Girasol.")]);
    const res = await p;
    expect(res.history).toEqual([
      { role: "user", content: "hola" },
      { role: "assistant", content: "Tenés una Riñonera Girasol." },
    ]);
    // (el fake guarda la misma lista de mensajes por referencia, que sigue creciendo)
    expect(chat.requests[1]!.messages.some((m) => m.role === "tool" && m.content === "resultado de buscar_productos")).toBe(true);
  });

  it("el historial se recorta a 6 (R3)", async () => {
    const history = Array.from({ length: 20 }, (_, i) => ({ role: (i % 2 ? "assistant" : "user") as "user" | "assistant", content: `m${i}` }));
    const chat = new FakeChatProvider([say("ok")]);
    const res = await runAgent({ chat, host: new FakeHost() }, { state: emptyState(), history, input: { chatId: 1, text: "nuevo" } });
    expect(res.history).toHaveLength(6);
    expect(res.history.at(-1)).toEqual({ role: "assistant", content: "ok" });
  });

  it("si el proveedor falla, la excepción sube (la cola reintenta)", async () => {
    await expect(run([new Error("boom")]).p).rejects.toThrow("boom");
  });
});

describe("orden de herramientas en una misma respuesta", () => {
  it("responder primero y la escritura detrás: la escritura se ejecuta igual y manda la vista previa", async () => {
    const d = applyDraftUpdate(null, "producto", { name: "Riñonera Girasol", price_ars: 12500, category: "riñoneras" }, ["m1"]);
    const { host, p } = run([turn(call("responder", { texto: "Listo, ya lo cargué." }), call("crear_producto", {}))], { ...emptyState(), draft: d });
    const res = await p;
    expect(host.pending).toHaveLength(1);
    expect(res.output.pendingActionId).toBe("pa1");
    expect(res.llmCalls).toBe(1);
  });

  it("responder primero y el borrador detrás: el borrador se guarda", async () => {
    const res = await run([turn(call("responder", { texto: "¿Cómo se llama?" }), call("actualizar_borrador", { tipo: "producto", campos: { price_ars: 12000 } }))]).p;
    expect(res.state.draft?.campos.price_ars).toBe(12000);
    expect(res.output.texto).toBe("¿Cómo se llama?");
  });

  it("responder junto a una lectura se descarta: el modelo tiene que ver el resultado antes", async () => {
    const { chat, p } = run([
      turn(call("responder", { texto: "Tenés una." }), call("buscar_productos", { consulta: "girasol" })),
      say("Tenés una Riñonera Girasol."),
    ]);
    const res = await p;
    expect(res.output.texto).toBe("Tenés una Riñonera Girasol.");
    expect(res.llmCalls).toBe(2);
    expect(chat.requests).toHaveLength(2);
  });
});
