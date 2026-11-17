import { describe, expect, it } from "vitest";
import {
  applyDraftUpdate,
  copyResolucion,
  emptyState,
  runAgent,
  searchProducts,
  shouldRequireTool,
  type AgentState,
  type PendingActionInput,
  type SearchItem,
  type ToolHost,
  type ToolName,
} from "../../src";
import { FakeChatProvider, ProviderError } from "../../src/providers";
import { call, say, turn } from "./helpers";

type CatalogEntry = SearchItem & {
  precio: string;
  variantes: { id: string; diseno: string; talle: string; color: string; stock: number | null }[];
};

const CATALOG: CatalogEntry[] = [
  {
    id: "prod-rinonera-girasol",
    name: "Riñonera Girasol",
    category: "riñoneras",
    precio: "$12.000",
    variants: [{ design: "", size: "", color: "" }],
    variantes: [{ id: "var-rinonera-base", diseno: "", talle: "", color: "", stock: 5 }],
  },
  {
    id: "prod-neceser-lunares",
    name: "Neceser Lunares",
    category: "neceseres",
    precio: "$8.000",
    variants: [
      { design: "", size: "", color: "Rosa" },
      { design: "", size: "", color: "Azul" },
    ],
    variantes: [
      { id: "var-neceser-rosa", diseno: "", talle: "", color: "Rosa", stock: 5 },
      { id: "var-neceser-azul", diseno: "", talle: "", color: "Azul", stock: 4 },
    ],
  },
  {
    id: "prod-neceser-flores",
    name: "Neceser Flores",
    category: "neceseres",
    precio: "$9.000",
    variants: [{ design: "Flores", size: "", color: "Verde" }],
    variantes: [{ id: "var-neceser-flores", diseno: "Flores", talle: "", color: "Verde", stock: 3 }],
  },
];

class CatalogFakeHost implements ToolHost {
  readonly pending: PendingActionInput[] = [];
  readonly reads: { name: ToolName; args: Record<string, unknown> }[] = [];

  async createPendingAction(input: PendingActionInput) {
    this.pending.push(input);
    return { id: `pa${this.pending.length}` };
  }

  async read(name: ToolName, args: Record<string, unknown>) {
    this.reads.push({ name, args });
    if (name === "buscar_productos") {
      const hits = searchProducts(String(args.consulta ?? ""), CATALOG);
      return hits.map((h) => ({
        id: h.id,
        nombre: h.name,
        categoria: h.category,
        precio: h.precio,
        estado: "active",
        variantes: h.variantes,
      }));
    }
    if (name === "ver_producto") {
      const p = CATALOG.find((c) => c.id === args.producto_id);
      return p ? { id: p.id, nombre: p.name, precio: p.precio } : "No encuentro ese producto.";
    }
    return "ok";
  }
}

describe("resolución server-side en editar_producto y cambiar_stock", () => {
  it("editar_producto por nombre único (sin tildes/mayúsculas) resuelve id en 1 llamada al LLM", async () => {
    const chat = new FakeChatProvider([
      turn(call("editar_producto", { producto: "rinonera girasol", cambios: { price_ars: 15000 } })),
    ]);
    const host = new CatalogFakeHost();
    const res = await runAgent({ chat, host }, { state: emptyState(), history: [], input: { chatId: 1, text: "cambiale el precio a la riñonera girasol a 15000" } });

    expect(res.llmCalls).toBe(1);
    expect(host.pending).toHaveLength(1);
    expect(host.pending[0]!.args).toMatchObject({ producto_id: "prod-rinonera-girasol", cambios: { price_ars: 15000 } });
    expect(res.output.pendingActionId).toBe("pa1");
    expect(res.output.texto).toContain("Riñonera Girasol");
    expect(res.output.texto).toContain("$12.000 → $15.000");
  });

  it("editar_producto ambiguo (varios productos) NO escribe y pide aclaración con botones", async () => {
    const chat = new FakeChatProvider([
      turn(call("editar_producto", { producto: "neceser", cambios: { price_ars: 10000 } })),
      say("¿Cuál neceser querés cambiar?", [
        { etiqueta: "Neceser Lunares", valor: "Neceser Lunares" },
        { etiqueta: "Neceser Flores", valor: "Neceser Flores" },
      ]),
    ]);
    const host = new CatalogFakeHost();
    const res = await runAgent({ chat, host }, { state: emptyState(), history: [], input: { chatId: 1, text: "cambiale el precio al neceser a 10000" } });

    expect(res.llmCalls).toBe(2);
    expect(host.pending).toHaveLength(0);
    expect(res.output.botones?.map((b) => b.etiqueta)).toEqual(["Neceser Lunares", "Neceser Flores"]);
    const toolMsg = chat.requests[1]!.messages.find((m) => m.role === "tool");
    expect(toolMsg && "content" in toolMsg && toolMsg.content).toContain("Varios productos coinciden");
  });

  it("editar_producto sin coincidencias devuelve copy amigable y NO escribe", async () => {
    const chat = new FakeChatProvider([
      turn(call("editar_producto", { producto: "cartuchera", cambios: { price_ars: 5000 } })),
      say(copyResolucion.productoNoEncontrado("cartuchera")),
    ]);
    const host = new CatalogFakeHost();
    const res = await runAgent({ chat, host }, { state: emptyState(), history: [], input: { chatId: 1, text: "precio de cartuchera a 5000" } });

    expect(host.pending).toHaveLength(0);
    const toolMsg = chat.requests[1]!.messages.find((m) => m.role === "tool");
    expect(toolMsg && "content" in toolMsg && toolMsg.content).toBe(copyResolucion.productoNoEncontrado("cartuchera"));
  });

  it("editar_producto sigue aceptando producto_id directo (retrocompatible)", async () => {
    const chat = new FakeChatProvider([
      turn(call("editar_producto", { producto_id: "prod-rinonera-girasol", cambios: { price_ars: 14000 } })),
    ]);
    const host = new CatalogFakeHost();
    const res = await runAgent({ chat, host }, { state: emptyState(), history: [], input: { chatId: 1, text: "ponela a 14000" } });

    expect(res.llmCalls).toBe(1);
    expect(host.pending[0]!.args).toMatchObject({ producto_id: "prod-rinonera-girasol" });
    expect(host.reads.some((r) => r.name === "buscar_productos")).toBe(false);
  });

  it("cambiar_stock con producto + variante única resuelve variante_id en 1 llamada", async () => {
    const chat = new FakeChatProvider([
      turn(call("cambiar_stock", { producto: "neceser lunares", variante: "rosa", delta: -2, motivo: "venta" })),
    ]);
    const host = new CatalogFakeHost();
    const res = await runAgent({ chat, host }, { state: emptyState(), history: [], input: { chatId: 1, text: "vendí 2 neceseres lunares rosa" } });

    expect(res.llmCalls).toBe(1);
    expect(host.pending).toHaveLength(1);
    expect(host.pending[0]!.args).toMatchObject({ variante_id: "var-neceser-rosa", delta: -2, motivo: "venta" });
    expect(res.output.pendingActionId).toBe("pa1");
  });

  it("cambiar_stock con producto de 1 sola variante resuelve sin pedir variante", async () => {
    const chat = new FakeChatProvider([
      turn(call("cambiar_stock", { producto: "riñonera girasol", delta: -1, motivo: "venta" })),
    ]);
    const host = new CatalogFakeHost();
    const res = await runAgent({ chat, host }, { state: emptyState(), history: [], input: { chatId: 1, text: "vendí 1 riñonera girasol" } });

    expect(res.llmCalls).toBe(1);
    expect(host.pending[0]!.args).toMatchObject({ variante_id: "var-rinonera-base" });
  });

  it("cambiar_stock con varias variantes y sin variante indicada NO escribe y pide aclaración", async () => {
    const chat = new FakeChatProvider([
      turn(call("cambiar_stock", { producto: "neceser lunares", delta: -2, motivo: "venta" })),
      say("¿Cuál vendiste?", [
        { etiqueta: "Rosa", valor: "Rosa" },
        { etiqueta: "Azul", valor: "Azul" },
      ]),
    ]);
    const host = new CatalogFakeHost();
    const res = await runAgent({ chat, host }, { state: emptyState(), history: [], input: { chatId: 1, text: "vendí 2 neceseres lunares" } });

    expect(res.llmCalls).toBe(2);
    expect(host.pending).toHaveLength(0);
    const toolMsg = chat.requests[1]!.messages.find((m) => m.role === "tool");
    expect(toolMsg && "content" in toolMsg && toolMsg.content).toContain("varias variantes: Rosa, Azul");
  });

  it("cambiar_stock con variante inexistente NO escribe y devuelve copy amigable", async () => {
    const chat = new FakeChatProvider([
      turn(call("cambiar_stock", { producto: "neceser lunares", variante: "amarillo", delta: -1, motivo: "venta" })),
      say(copyResolucion.varianteNoEncontrada("amarillo", "Neceser Lunares")),
    ]);
    const host = new CatalogFakeHost();
    const res = await runAgent({ chat, host }, { state: emptyState(), history: [], input: { chatId: 1, text: "vendí 1 neceser lunares amarillo" } });

    expect(host.pending).toHaveLength(0);
    const toolMsg = chat.requests[1]!.messages.find((m) => m.role === "tool");
    expect(toolMsg && "content" in toolMsg && toolMsg.content).toBe(copyResolucion.varianteNoEncontrada("amarillo", "Neceser Lunares"));
  });
});

describe("shouldRequireTool y toolChoice en runAgent", () => {
  it("detecta borrador con fotos, llegada de fotos, deshacer, venta y cambio de precio (sin tildes)", () => {
    const withPhotos: AgentState = { ...emptyState(), draft: applyDraftUpdate(null, "producto", {}, ["m1"]) };
    const withoutPhotos: AgentState = { ...emptyState(), draft: applyDraftUpdate(null, "producto", { name: "X" }) };

    expect(shouldRequireTool(withPhotos, "sale 12000")).toBe(true);
    expect(shouldRequireTool(withoutPhotos, "hola")).toBe(false);
    expect(shouldRequireTool(emptyState(), "(sistema) La usuaria mandó 2 fotos. media_ids: m1, m2")).toBe(true);
    expect(shouldRequireTool(emptyState(), "Deshacé lo último")).toBe(true);
    expect(shouldRequireTool(emptyState(), "volver atras")).toBe(true);
    expect(shouldRequireTool(emptyState(), "anular")).toBe(true);
    expect(shouldRequireTool(emptyState(), "vendí 2 neceseres")).toBe(true);
    expect(shouldRequireTool(emptyState(), "vendi uno")).toBe(true);
    expect(shouldRequireTool(emptyState(), "cambiale el precio a 15000")).toBe(true);
    expect(shouldRequireTool(emptyState(), "precio a la riñonera")).toBe(true);
    expect(shouldRequireTool(emptyState(), "hola, cómo estás?")).toBe(false);
    expect(shouldRequireTool(emptyState(), "¿cuánto sale la riñonera?")).toBe(false);
  });

  it("manda toolChoice='required' solo en la 1ª llamada y lo limpia después", async () => {
    const chat = new FakeChatProvider([
      turn(call("editar_producto", { producto: "neceser", cambios: { price_ars: 10000 } })),
      say("¿Cuál neceser?", [{ etiqueta: "Neceser Lunares", valor: "Neceser Lunares" }]),
    ]);
    const host = new CatalogFakeHost();
    await runAgent({ chat, host }, { state: emptyState(), history: [], input: { chatId: 1, text: "cambiale el precio al neceser a 10000" } });

    expect(chat.requests[0]!.toolChoice).toBe("required");
    expect(chat.requests[1]!.toolChoice).toBeUndefined();
  });

  it("si el proveedor rechaza tool_choice (400), cae a auto sin error para la usuaria", async () => {
    const chat = new FakeChatProvider([
      new ProviderError("fatal", "tool_choice is not supported", { status: 400 }),
      turn(call("deshacer", {})),
    ]);
    const host = new CatalogFakeHost();
    const res = await runAgent({ chat, host }, { state: emptyState(), history: [], input: { chatId: 1, text: "deshacé lo último" } });

    expect(res.output.pendingActionId).toBe("pa1");
    expect(chat.requests[0]!.toolChoice).toBe("required");
    expect(chat.requests[1]!.toolChoice).toBeUndefined();
  });
});
