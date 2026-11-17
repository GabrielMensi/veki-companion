// Criterios de aceptacion 1, 3, 4 y 5 de la Etapa 1 (docs/03 seccion 3) como guiones de conversacion.
// Pipeline real (webhook -> cola -> agente -> callbacks -> D1/R2); chat y voz con scripts (`FakeChatProvider`).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeChatProvider, copyAcciones } from "@veki/core";
import { ediccionHastaVistaPrevia, NOMBRE, altaHastaVistaPrevia } from "./flows";
import { OWNER, STRANGER, count, questions, resetDb, responder, row, rows, startWorld, tool, type World } from "./harness";
import { RINONERA, SAY } from "./spec";

let world: World | undefined;
beforeEach(resetDb);
afterEach(() => world?.stop());

const productRow = (id: string) => row<Record<string, unknown>>("SELECT * FROM products WHERE id = ?", id);

describe("criterio 1: fotos + audio -> como mucho 3 preguntas -> vista previa -> Si crea el producto", () => {
  it.each([1, 3, 5])("%i foto(s) y un audio: una pregunta por vez y vista previa con nombre y precio correctos", async (n) => {
    world = await altaHastaVistaPrevia(n);
    const w = world;

    // Preguntas: a lo sumo 3, y cada mensaje tiene una sola (docs/02 3.1).
    const toUser = w.sent();
    const asked = toUser.filter((m) => questions(m.text) > 0);
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.length).toBeLessThanOrEqual(3);
    for (const m of toUser) expect(questions(m.text)).toBeLessThanOrEqual(1);

    // El audio pasa por STT y entra como texto; el audio no se guarda.
    expect(w.stt.calls).toHaveLength(1);
    expect(await count("media", "kind != 'photo'")).toBe(0);
    expect(await count("media", "status = 'inbox'")).toBe(n);

    // Vista previa: nombre y precio correctos, con Si / Cambiar / Cancelar.
    const preview = w.last();
    expect(preview.text).toContain(`${NOMBRE} — $12.500`);
    expect(preview.text).toContain(`Fotos: ${n}`);
    expect(preview.buttons.map((b) => b.text)).toEqual(["Sí", "Cambiar", "Cancelar"]);
    // Nada se escribio todavia en el catalogo.
    expect(await count("products")).toBe(0);
    expect(await count("pending_actions", "status = 'pending' AND tool = 'crear_producto'")).toBe(1);
  });

  it("Si: crea producto + variante por defecto + fotos adjuntas en orden, y marca el sitio como sucio", async () => {
    world = await altaHastaVistaPrevia(3);
    const w = world;
    await w.tap("Sí");

    const products = await rows<{ id: string; slug: string; name: string; category: string; price_ars: number; status: string }>("SELECT * FROM products");
    expect(products).toHaveLength(1);
    expect(products[0]).toMatchObject({ slug: "neceser-de-lona-floreado", name: NOMBRE, category: "neceseres", price_ars: 12500, status: "active" });
    const pid = products[0]!.id;

    const variants = await rows<{ design: string; size: string; color: string; status: string; price_ars: number | null }>("SELECT * FROM variants WHERE product_id = ?", pid);
    expect(variants).toEqual([expect.objectContaining({ design: "", size: "", color: "", status: "active", price_ars: null })]);

    const photos = await rows<{ position: number; status: string }>("SELECT position, status FROM media WHERE product_id = ? ORDER BY position", pid);
    expect(photos.map((p) => [p.position, p.status])).toEqual([[0, "attached"], [1, "attached"], [2, "attached"]]);
    expect(await count("media", "status = 'inbox'")).toBe(0);

    expect((await row<{ dirty_since: number | null }>("SELECT dirty_since FROM site_state WHERE id = 1"))?.dirty_since).toEqual(expect.any(Number));
    expect(await count("event_log", "type = 'action.executed'")).toBe(1);
    expect(w.last().text).toBe(copyAcciones.productoCreado(NOMBRE));
    expect(w.last().buttons.map((b) => b.text)).toEqual(["Deshacer"]);
    // El borrador se cerro: la conversacion no queda con un alta a medias.
    const conv = await row<{ state: string }>("SELECT state FROM conversations WHERE chat_id = ?", OWNER);
    expect(JSON.parse(conv!.state).draft).toBeNull();
  });
});

describe("criterio 3: cambiar el precio y deshacer", () => {
  it('cambiale el precio a quince mil -> vista previa -> Si -> precio actualizado y sitio sucio', async () => {
    world = await ediccionHastaVistaPrevia();
    const w = world;
    // La vista previa llego con botones y todavia no cambio nada.
    expect(w.last().buttons.map((b) => b.text)).toEqual(["Sí", "Cambiar", "Cancelar"]);
    expect(w.last().text).toContain("$15.000");
    expect(w.last().text).not.toMatch(new RegExp(`${RINONERA.id}|producto_id|cambios|[{}]`));
    expect((await productRow(RINONERA.id))!.price_ars).toBe(12000);

    await w.tap("Sí");
    expect((await productRow(RINONERA.id))!.price_ars).toBe(15000);
    expect(w.last().text).toBe(copyAcciones.productoEditado(RINONERA.name));
    expect((await row<{ dirty_since: number | null }>("SELECT dirty_since FROM site_state WHERE id = 1"))?.dirty_since).toEqual(expect.any(Number));
  });

  it('Deshace lo ultimo -> vista previa -> Si -> vuelve exactamente la fila anterior', async () => {
    world = await ediccionHastaVistaPrevia([
      // Turno 3: pide deshacer lo ultimo.
      () => tool("deshacer"),
    ]);
    const w = world;
    const original = await productRow(RINONERA.id); // 12000, todavia sin editar
    await w.tap("Sí");
    expect((await productRow(RINONERA.id))!.price_ars).toBe(15000);

    await w.text(SAY.deshacer);
    expect(w.last().buttons.map((b) => b.text)).toEqual(["Sí", "Cambiar", "Cancelar"]);
    expect((await productRow(RINONERA.id))!.price_ars).toBe(15000); // la vista previa todavia no deshace
    await w.tap("Sí");

    expect(await productRow(RINONERA.id)).toEqual(original); // snapshot completo, incluido updated_at
    expect(w.last().text).toBe(copyAcciones.deshecho);
    expect(await count("event_log", "type = 'action.undone'")).toBe(1);
  });

  it("el boton Deshacer del mensaje de exito tambien restaura la fila anterior (una sola vez)", async () => {
    world = await ediccionHastaVistaPrevia();
    const w = world;
    const original = await productRow(RINONERA.id);
    await w.tap("Sí");
    await w.tap("Deshacer");
    expect(await productRow(RINONERA.id)).toEqual(original);
    expect(w.last().text).toBe(copyAcciones.deshecho);
    await w.tapData(w.sent().flatMap((m) => m.buttons).find((b) => b.text === "Deshacer")!.callback_data); // segundo toque
    expect(await productRow(RINONERA.id)).toEqual(original);
    expect(await count("event_log", "type = 'action.undone'")).toBe(1);
  });
});

describe("criterio 4: tocar Si dos veces deja un solo cambio", () => {
  const flows: [string, () => Promise<World>, () => Promise<void>][] = [
    [
      "alta de producto",
      () => altaHastaVistaPrevia(2),
      async () => {
        expect(await count("products")).toBe(1);
        expect(await count("variants")).toBe(1);
      },
    ],
    [
      "cambio de precio",
      () => ediccionHastaVistaPrevia(),
      async () => expect((await productRow(RINONERA.id))!.price_ars).toBe(15000),
    ],
  ];

  for (const [name, build, check] of flows) {
    for (const concurrent of [false, true]) {
      it(`${name}: dos toques ${concurrent ? "a la vez" : "seguidos"} -> una ejecucion en event_log`, async () => {
        world = await build();
        const w = world;
        const yes = w.last().buttons.find((b) => b.text === "Sí")!.callback_data;
        const sentBefore = w.sent().length;

        await w.tapData(yes, OWNER, 2, concurrent);

        await check();
        expect(await count("event_log", "type = 'action.executed'")).toBe(1);
        expect(await count("pending_actions", "status = 'executed'")).toBe(1);
        expect(w.calls("answerCallbackQuery")).toHaveLength(2); // los dos toques cortan el relojito...
        expect(w.sent().length - sentBefore).toBe(1); // ...pero solo hay un mensaje de exito
      });
    }
  }
});

describe("criterio 5: un chat fuera de la allowlist no recibe respuesta", () => {
  it("texto, audio, foto y botones de un chat ajeno: sin respuesta, sin agente y con access.denied", async () => {
    const chat = new FakeChatProvider([() => responder("no deberia llegar")]);
    world = startWorld({ chat });
    const w = world;

    expect(await w.text("hola", STRANGER)).toBe(200); // Telegram no reintenta
    await w.voice(STRANGER);
    await w.photos(1, STRANGER);
    await w.tapData("pa:cualquiera:yes", STRANGER);

    expect(w.botApi.calls).toEqual([]); // ni siquiera un answerCallbackQuery
    expect(chat.requests).toHaveLength(0);
    expect(w.stt.calls).toHaveLength(0);
    expect(await count("event_log", "type = 'access.denied'")).toBe(4);
    expect(await count("updates")).toBe(0);
    expect(await count("media")).toBe(0);
    // El registro no guarda lo que escribio ni su id de chat.
    const logged = JSON.stringify(await rows("SELECT data FROM event_log WHERE type = 'access.denied'"));
    expect(logged).not.toContain("hola");
    expect(logged).not.toContain(String(STRANGER));
  });

  it("la usuaria permitida sigue siendo atendida en el mismo despliegue", async () => {
    const chat = new FakeChatProvider([() => responder("Hola 🙂")]);
    world = startWorld({ chat });
    await world.text("hola", STRANGER);
    await world.text("hola");
    expect(world.sent(STRANGER)).toEqual([]);
    expect(world.sent().map((m) => m.text)).toEqual(["Hola 🙂"]);
    expect(await count("event_log", "type = 'access.denied'")).toBe(1);
  });
});
