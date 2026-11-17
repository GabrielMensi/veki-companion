// Guiones de diseno de la Etapa 1 (docs/02 3.1, 3.3, 3.4, 4.6): aclarar variantes, "Cambiar" en la vista previa,
// dos malentendidos seguidos y un turno con Groq limitado. Pipeline real; chat y voz con scripts.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeChatProvider, ProviderError, copy, copyAcciones, copyAdminEscalacion, copyPresupuesto, type ChatResult } from "@veki/core";
import { ediccionHastaVistaPrevia } from "./flows";
import { ADMIN, OWNER, count, lastToolJson, resetDb, responder, row, rows, seedCatalog, startWorld, tool, questions, type World } from "./harness";
import { NECESER, RINONERA, SAY } from "./spec";

let world: World | undefined;
beforeEach(resetDb);
afterEach(() => world?.stop());

const stock = async (id: string) => (await row<{ stock: number }>("SELECT stock FROM variants WHERE id = ?", id))!.stock;
const price = async (id: string) => (await row<{ price_ars: number }>("SELECT price_ars FROM products WHERE id = ?", id))!.price_ars;

describe("vendi 2 neceseres con 2 variantes: pregunta cual y no toca nada hasta saberlo", () => {
  const venta = () =>
    new FakeChatProvider([
      // Turno 1: busca y, al ver dos variantes, pregunta con botones (no escribe).
      () => tool("buscar_productos", { consulta: "neceser" }),
      () => responder("¿Cuál vendiste?", [{ etiqueta: "Rosa", valor: "rosa" }, { etiqueta: "Azul", valor: "azul" }]),
      // Turno 2 ("la rosa"): vuelve a buscar para tener el id de la variante y propone la baja de stock.
      () => tool("buscar_productos", { consulta: "neceser" }),
      (req) => {
        const rosa = lastToolJson(req)[0].variantes.find((v: { color: string }) => v.color === "Rosa");
        return tool("cambiar_stock", { variante_id: rosa.id, delta: -2, motivo: "venta" });
      },
    ]);

  it("el modelo ve las dos variantes, ella recibe una sola pregunta con un boton por variante y no hay acciones", async () => {
    await seedCatalog([NECESER]);
    world = startWorld({ chat: venta() });
    await world.text(SAY.vendi);

    const seen = JSON.stringify(lastToolJson(world.chat.requests[1]!));
    expect(seen).toContain("Rosa");
    expect(seen).toContain("Azul");
    const out = world.sent();
    expect(out).toHaveLength(1);
    expect(questions(out[0]!.text)).toBe(1);
    expect(out[0]!.buttons.map((b) => b.text)).toEqual(["Rosa", "Azul"]);
    expect(await count("pending_actions")).toBe(0);
    expect(await stock("var-neceser-rosa")).toBe(5);
    expect(await stock("var-neceser-azul")).toBe(4);
  });

  it("al contestar 'la rosa' sale la vista previa y con Si baja solo el stock de esa variante", async () => {
    await seedCatalog([NECESER]);
    world = startWorld({ chat: venta() });
    await world.text(SAY.vendi);
    await world.text(SAY.laRosa);
    expect(world.last().buttons.map((b) => b.text)).toEqual(["Sí", "Cambiar", "Cancelar"]);
    expect(await stock("var-neceser-rosa")).toBe(5); // la vista previa todavia no escribe

    await world.tap("Sí");
    expect(await stock("var-neceser-rosa")).toBe(3);
    expect(await stock("var-neceser-azul")).toBe(4);
    expect(world.last().text).toBe(copyAcciones.stockActualizado(NECESER.name, 3));
  });
});

describe('"Cambiar" en la vista previa', () => {
  const nuevoPrecio = () => (): ChatResult => tool("editar_producto", { producto_id: RINONERA.id, cambios: { price_ars: 20000 } });

  it("pregunta que cambiar, la accion nueva reemplaza a la anterior y solo la nueva se ejecuta", async () => {
    world = await ediccionHastaVistaPrevia([nuevoPrecio()]);
    const w = world;
    const first = await row<{ id: string }>("SELECT id FROM pending_actions WHERE status = 'pending'");
    const oldYes = w.last().buttons.find((b) => b.text === "Sí")!.callback_data;

    await w.tap("Cambiar");
    expect(w.last().text).toBe(copy.cambiarPregunta);
    expect(w.calls("editMessageReplyMarkup")).toHaveLength(1); // se le sacan los botones a la vista previa vieja
    expect(await row("SELECT status FROM pending_actions WHERE id = ?", first!.id)).toEqual({ status: "pending" }); // sigue vigente hasta que llegue el cambio

    await w.text(SAY.cambiarOtroPrecio);
    // El modelo recibio la consigna de cambio en el system prompt de esa llamada.
    expect(w.chat.requests.at(-1)!.system).toContain("cambiar la acción anterior");
    const all = await rows<{ id: string; status: string }>("SELECT id, status FROM pending_actions ORDER BY id");
    expect(all.map((a) => a.status)).toEqual(["cancelled", "pending"]);
    expect(all[0]!.id).toBe(first!.id);
    expect(w.last().text).toContain("20000");

    // El "Si" viejo ya no hace nada; el nuevo cambia el precio una sola vez.
    await w.tapData(oldYes);
    expect(await price(RINONERA.id)).toBe(12000);
    await w.tap("Sí");
    expect(await price(RINONERA.id)).toBe(20000);
    expect(await count("event_log", "type = 'action.executed'")).toBe(1);
  });
});

describe("dos malentendidos seguidos: atajos para ella y alerta para Gabriel", () => {
  const confused = () => new FakeChatProvider([{ text: "mmm", toolCalls: [], usage: { tokensIn: 1, tokensOut: 1 } }]);
  const SECRET = "frase-privada-de-prueba";

  it("primer malentendido: 'no te entendi'; segundo: botones de atajo y aviso al admin sin el texto de ella", async () => {
    world = startWorld({ chat: confused() });
    const w = world;
    await w.text(SECRET);
    expect(w.sent().map((m) => m.text)).toEqual([copy.noEntendi]);
    expect(w.sent(ADMIN)).toEqual([]);

    const secondUpdate = w.msg(OWNER, { text: SECRET });
    await w.post(secondUpdate);
    await w.drain();
    const toUser = w.sent();
    expect(toUser.at(-1)).toMatchObject({ text: copy.atajosTexto });
    expect(toUser.at(-1)!.buttons.map((b) => b.text)).toEqual(["Cargar producto", "Vendí algo", "Nueva feria", "Pedir flyer"]);

    const toAdmin = w.sent(ADMIN);
    expect(toAdmin.map((m) => m.text)).toEqual([copyAdminEscalacion.malentendidos(secondUpdate.update_id)]);
    expect(JSON.stringify([toAdmin, await rows("SELECT data FROM event_log WHERE type = 'agent.escalate'")])).not.toContain(SECRET);
    expect(await count("event_log", "type = 'agent.escalate'")).toBe(1);
    // Nada se escribio y no hay error para nadie.
    expect(await count("pending_actions")).toBe(0);
    expect(await count("event_log", "severity = 'error'")).toBe(0);
  });

  it("un tercer malentendido empieza la cuenta de nuevo (vuelve a 'no te entendi')", async () => {
    world = startWorld({ chat: confused() });
    for (let i = 0; i < 3; i++) await world.text("???");
    expect(world.sent().map((m) => m.text)).toEqual([copy.noEntendi, copy.atajosTexto, copy.noEntendi]);
  });

  // HALLAZGO (T23, reportado al orquestador): los botones de atajo y los de eleccion (`responder.botones`) llevan
  // `callback_data` que no es `pa:<id>:...`; `handleCallback` los ignora (solo corta el relojito), asi que tocarlos
  // no llega al agente. Cuando se arregle, este test deja de fallar y hay que sacar el `.fails`.
  it.fails("tocar un atajo ('Cargar producto') le llega al agente y ella recibe una respuesta", async () => {
    const chat = new FakeChatProvider([
      { text: "mmm", toolCalls: [], usage: { tokensIn: 1, tokensOut: 1 } },
      { text: "mmm", toolCalls: [], usage: { tokensIn: 1, tokensOut: 1 } },
      () => responder("Dale, ¿cómo se llama?"),
    ]);
    world = startWorld({ chat });
    await world.text("???");
    await world.text("???");
    const before = world.sent().length;
    await world.tap("Cargar producto");
    expect(world.sent().length).toBe(before + 1);
  });
});

describe("Groq limitado: ella solo ve 'te aviso en un ratito', sin errores", () => {
  const limited = () =>
    new FakeChatProvider([new ProviderError("rate_limit", "429", { retryAfterS: 30, status: 429 }), () => responder("Listo, acá estoy 🙂")]);

  // HALLAZGO (T23, reportado al orquestador): `handleUpdateMessage` (handlers/dispatch.ts) atrapa TODA excepcion de un turno
  // de texto/voz y contesta `copy.algoSalioMal` sin relanzar; el `ProviderError` con `retryAfterS` nunca llega a `handleBatch`,
  // asi que ella ve "Ups, algo salio mal" y el update no se reintenta. El camino de la cola (aviso + retry) solo esta probado
  // con un router falso (r3-wiring.test.ts). Cuando dispatch relance los ProviderError, este test deja de fallar: sacar el `.fails`.
  it.fails("aviso amable una sola vez, el update se reintenta con el retry-after y despues se responde", async () => {
    world = startWorld({ chat: limited() });
    const w = world;
    const update = w.msg(OWNER, { text: "hola" });
    await w.post(update);
    const { messages } = await w.drain(1);

    expect(w.sent().map((m) => m.text)).toEqual([copyPresupuesto.teAvisoEnUnRatito]);
    expect(w.sent().some((m) => m.text === copy.algoSalioMal)).toBe(false);
    expect(w.retried).toEqual([{ delay: 30 }]);
    expect(w.acked).toBe(0);
    expect(await count("event_log", "severity = 'error'")).toBe(0);
    expect(await row("SELECT status FROM updates WHERE update_id = ?", update.update_id)).toEqual({ status: "queued" });

    // El reintento (intento 2) ya encuentra el modelo disponible: responde y no repite el aviso.
    await w.redeliver(messages, 2);
    expect(w.sent().map((m) => m.text)).toEqual([copyPresupuesto.teAvisoEnUnRatito, "Listo, acá estoy 🙂"]);
    expect(w.acked).toBe(1);
    expect(await row("SELECT status FROM updates WHERE update_id = ?", update.update_id)).toEqual({ status: "done" });
  });
});
