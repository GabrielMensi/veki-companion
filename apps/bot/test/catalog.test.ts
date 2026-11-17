import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { copyAcciones, copyCatalogo, emptyState, InMemoryConversationStore, paData, type Draft } from "@veki/core";
import { executeAction } from "../src/actions/execute";
import { activeSnooze, snoozeKey, snoozeUntil } from "../src/actions/executors-catalog";
import { createPendingAction } from "../src/actions/pending";
import { undoAction } from "../src/actions/undo";
import type { Env } from "../src/env";
import { handleCallback, type TelegramApi } from "../src/handlers/callback";
import { catalogRead } from "../src/tools/catalog";

// Todo inventado: nombres, ids y chats de prueba.
const db = (env as unknown as { DB: Env["DB"] }).DB;
const e = { DB: db, ALLOWED_CHAT_IDS: "1001:owner", TELEGRAM_BOT_TOKEN: "t" } as unknown as Env;
const CHAT = 1001;
const T0 = 1_800_000_000_000;

const all = async <T>(sql: string, ...b: unknown[]) => (await db.prepare(sql).bind(...b).all<T>()).results;
const one = async <T>(sql: string, ...b: unknown[]) => (await db.prepare(sql).bind(...b).first<T>())!;
const mk = (tool: string, args: Record<string, unknown>, now = T0) => createPendingAction(e, { chatId: CHAT, tool: tool as never, args, preview: "vista previa" }, now);
const run = async (tool: string, args: Record<string, unknown>, now = T0) => executeAction((await mk(tool, args, now)).id, CHAT, { db, now });

async function seedMedia(...ids: string[]) {
  for (const id of ids) {
    await db.prepare("INSERT INTO media (id, r2_key, kind, mime, status, created_at) VALUES (?, ?, 'photo', 'image/jpeg', 'inbox', 1)").bind(id, `orig/${id}.jpg`).run();
  }
}
const draft = (over: Partial<Draft["campos"]> = {}, media_ids = ["m1", "m2", "m3"]): Draft => ({
  tipo: "producto",
  campos: { name: "Riñonera Girasol", price_ars: 12500, category: "riñoneras", description: "Con cierre", ...over },
  media_ids,
});

beforeEach(async () => {
  for (const t of ["event_log", "pending_actions", "media", "variants", "products", "site_state"]) await db.prepare(`DELETE FROM ${t}`).run();
  await db.prepare("DELETE FROM settings WHERE key LIKE 'snooze:%'").run();
});

describe("crear_producto", () => {
  it("alta completa: producto + variante por defecto + fotos attached con position", async () => {
    await seedMedia("m1", "m2", "m3");
    const r = await run("crear_producto", { draft: draft() });
    expect(r.kind).toBe("executed");
    if (r.kind === "executed") expect(r.message).toBe(copyAcciones.productoCreado("Riñonera Girasol"));

    const p = await one<{ id: string; slug: string; price_ars: number; status: string }>("SELECT * FROM products");
    expect(p).toMatchObject({ slug: "rinonera-girasol", price_ars: 12500, status: "active" });
    const vs = await all<{ design: string; size: string; color: string; stock: number | null; status: string }>("SELECT * FROM variants WHERE product_id=?", p.id);
    expect(vs).toEqual([expect.objectContaining({ design: "", size: "", color: "", stock: null, status: "active" })]);
    const ms = await all<{ id: string; position: number; status: string; product_id: string }>("SELECT id, position, status, product_id FROM media ORDER BY position");
    expect(ms.map((m) => [m.id, m.position, m.status, m.product_id])).toEqual([["m1", 0, "attached", p.id], ["m2", 1, "attached", p.id], ["m3", 2, "attached", p.id]]);
    expect(await all("SELECT id FROM event_log WHERE type='action.executed'")).toHaveLength(1);
    expect((await one<{ dirty_since: number }>("SELECT dirty_since FROM site_state")).dirty_since).toBe(T0);
  });

  it("precio 'consultar' queda NULL; el slug repetido suma -2 y -3", async () => {
    await seedMedia("m1", "m2", "m3");
    await run("crear_producto", { draft: draft({ price_ars: "consultar" }, ["m1"]) });
    await run("crear_producto", { draft: draft({ name: "RIÑONERA girasol" }, ["m2"]) }, T0 + 1);
    await run("crear_producto", { draft: draft({}, ["m3"]) }, T0 + 2);
    const rows = await all<{ slug: string; price_ars: number | null }>("SELECT slug, price_ars FROM products ORDER BY created_at");
    expect(rows.map((r) => r.slug)).toEqual(["rinonera-girasol", "rinonera-girasol-2", "rinonera-girasol-3"]);
    expect(rows[0]!.price_ars).toBeNull();
  });

  it("Deshacer restaura: sin producto, sin variante y fotos de nuevo en inbox", async () => {
    await seedMedia("m1", "m2");
    const before = await all("SELECT * FROM media ORDER BY id");
    const { id } = await mk("crear_producto", { draft: draft({}, ["m1", "m2"]) });
    await executeAction(id, CHAT, { db, now: T0 });
    expect((await undoAction(db, id, { chatId: CHAT, actor: "owner", now: T0 + 1 })).kind).toBe("undone");
    expect(await all("SELECT id FROM products")).toHaveLength(0);
    expect(await all("SELECT id FROM variants")).toHaveLength(0);
    expect(await all("SELECT * FROM media ORDER BY id")).toEqual(before);
  });

  it("borrador incompleto o foto ya usada: se rechaza y no queda nada abierto", async () => {
    await seedMedia("m1");
    const sin = await run("crear_producto", { draft: draft({ category: undefined }) });
    expect(sin).toEqual({ kind: "rejected", message: copyCatalogo.borradorIncompleto });
    const fantasma = await run("crear_producto", { draft: draft({}, ["m1", "zzz"]) }, T0 + 1);
    expect(fantasma).toEqual({ kind: "rejected", message: copyCatalogo.fotoNoDisponible });
    expect(await all("SELECT id FROM products")).toHaveLength(0);
    expect(await all("SELECT id FROM pending_actions WHERE status='pending'")).toHaveLength(0);
    expect((await one<{ status: string }>("SELECT status FROM media WHERE id='m1'")).status).toBe("inbox");
  });
});

async function seedProductWithDefault() {
  await seedMedia("m1");
  await run("crear_producto", { draft: draft({}, ["m1"]) });
  const p = await one<{ id: string }>("SELECT id FROM products");
  return p.id;
}

describe("editar_variantes", () => {
  it("agregar variantes con nombre archiva la variante por defecto; Deshacer la devuelve", async () => {
    const pid = await seedProductWithDefault();
    const a = await mk("editar_variantes", { producto_id: pid, agregar: [{ design: "Girasol", color: "Lila", stock: 2 }, { design: "girasol", size: "chica", price_ars: 9000 }] }, T0 + 5);
    expect((await executeAction(a.id, CHAT, { db, now: T0 + 5 })).kind).toBe("executed");
    const vs = await all<{ design: string; size: string; color: string; stock: number | null; price_ars: number | null; status: string }>("SELECT * FROM variants WHERE product_id=? ORDER BY design, size", pid);
    expect(vs.filter((v) => v.status === "active").map((v) => [v.design, v.size, v.color, v.stock, v.price_ars])).toEqual([
      ["Girasol", "", "Lila", 2, null],
      ["girasol", "chica", "", null, 9000],
    ]);
    expect(vs.find((v) => v.design === "" && v.size === "" && v.color === "")!.status).toBe("archived");

    expect((await undoAction(db, a.id, { chatId: CHAT, actor: "owner", now: T0 + 6 })).kind).toBe("undone");
    const after = await all<{ design: string; status: string }>("SELECT design, status FROM variants WHERE product_id=?", pid);
    expect(after).toEqual([{ design: "", status: "active" }]);
  });

  it("la variante por defecto con stock se convierte en la primera con nombre y conserva el stock; Deshacer restaura la fila", async () => {
    const pid = await seedProductWithDefault();
    await db.prepare("UPDATE variants SET stock = 5 WHERE product_id = ?").bind(pid).run();
    const before = await all("SELECT * FROM variants WHERE product_id=? ORDER BY id", pid);
    const a = await mk("editar_variantes", { producto_id: pid, agregar: [{ design: "Girasol", color: "Lila" }, { design: "Luna", stock: 1 }] }, T0 + 5);
    expect((await executeAction(a.id, CHAT, { db, now: T0 + 5 })).kind).toBe("executed");
    const vs = await all<{ id: string; design: string; color: string; stock: number; status: string }>("SELECT * FROM variants WHERE product_id=? ORDER BY design", pid);
    expect(vs.map((v) => [v.design, v.color, v.stock, v.status])).toEqual([["Girasol", "Lila", 5, "active"], ["Luna", "", 1, "active"]]);
    expect(vs[0]!.id).toBe((before[0] as { id: string }).id); // misma fila, no una nueva
    expect((await undoAction(db, a.id, { chatId: CHAT, actor: "owner", now: T0 + 6 })).kind).toBe("undone");
    expect(await all("SELECT * FROM variants WHERE product_id=? ORDER BY id", pid)).toEqual(before);
  });

  it("la variante por defecto con stock 0 se archiva al agregar variantes con nombre", async () => {
    const pid = await seedProductWithDefault();
    await db.prepare("UPDATE variants SET stock = 0 WHERE product_id = ?").bind(pid).run();
    await run("editar_variantes", { producto_id: pid, agregar: [{ design: "Girasol", stock: 2 }] }, T0 + 5);
    const vs = await all<{ design: string; stock: number | null; status: string }>("SELECT design, stock, status FROM variants WHERE product_id=? ORDER BY design", pid);
    expect(vs).toEqual([{ design: "", stock: 0, status: "archived" }, { design: "Girasol", stock: 2, status: "active" }]);
  });

  it("repetir una variante la reactiva sin duplicar; archivar todas deja la de por defecto activa", async () => {
    const pid = await seedProductWithDefault();
    await run("editar_variantes", { producto_id: pid, agregar: [{ design: "girasol" }] }, T0 + 1);
    await run("editar_variantes", { producto_id: pid, agregar: [{ design: "GIRASOL", stock: 4 }] }, T0 + 2);
    const named = await all<{ id: string; stock: number }>("SELECT id, stock FROM variants WHERE product_id=? AND design != ''", pid);
    expect(named).toHaveLength(1);
    expect(named[0]!.stock).toBe(4);
    await run("editar_variantes", { producto_id: pid, archivar: [named[0]!.id] }, T0 + 3);
    const active = await all<{ design: string }>("SELECT design FROM variants WHERE product_id=? AND status='active'", pid);
    expect(active).toEqual([{ design: "" }]);
  });

  it("variante ajena o sin cambios: se rechaza", async () => {
    const pid = await seedProductWithDefault();
    expect((await run("editar_variantes", { producto_id: pid, archivar: ["nope"] }, T0 + 1)).kind).toBe("rejected");
    expect((await run("editar_variantes", { producto_id: pid }, T0 + 2)).kind).toBe("rejected");
    expect((await run("editar_variantes", { producto_id: "nope", agregar: [{}] }, T0 + 3)).kind).toBe("rejected");
  });
});

describe("agregar_fotos", () => {
  it("suma al final, respeta portada y Deshacer restaura las filas", async () => {
    const pid = await seedProductWithDefault(); // m1 en posición 0
    await seedMedia("m2", "m3");
    const before = await all("SELECT * FROM media ORDER BY id");
    const a = await mk("agregar_fotos", { producto_id: pid, media_ids: ["m2", "m3", "m1"], portada: "m3" }, T0 + 5);
    expect((await executeAction(a.id, CHAT, { db, now: T0 + 5 })).kind).toBe("executed");
    const ms = await all<{ id: string; position: number; status: string }>("SELECT id, position, status FROM media ORDER BY position");
    expect(ms).toEqual([{ id: "m3", position: 0, status: "attached" }, { id: "m1", position: 1, status: "attached" }, { id: "m2", position: 2, status: "attached" }]);
    expect((await undoAction(db, a.id, { chatId: CHAT, actor: "owner", now: T0 + 6 })).kind).toBe("undone");
    expect(await all("SELECT * FROM media ORDER BY id")).toEqual(before);
  });

  it("foto ya adjunta a otro producto o inexistente: se rechaza", async () => {
    const pid = await seedProductWithDefault();
    expect((await run("agregar_fotos", { producto_id: pid, media_ids: ["nope"] }, T0 + 1)).kind).toBe("rejected");
    expect((await run("agregar_fotos", { producto_id: pid, media_ids: ["m1"] }, T0 + 2)).kind).toBe("rejected"); // nada nuevo
  });
});

describe("lecturas", () => {
  it("buscar_productos sin tildes/mayusculas y ver_producto con variantes y fotos", async () => {
    const pid = await seedProductWithDefault();
    await run("editar_variantes", { producto_id: pid, agregar: [{ design: "Girasol", color: "Lila", stock: 2, price_ars: 13000 }] }, T0 + 1);
    const read = catalogRead(db);
    const found = (await read("buscar_productos", { consulta: "RINONERA lila" })) as { id: string; precio: string }[];
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ id: pid, precio: "$12.500" });
    expect(await read("buscar_productos", { consulta: "mochila" })).toBe("No encontré productos con eso.");
    const ficha = (await read("ver_producto", { producto_id: pid })) as { nombre: string; variantes: { stock: number; precio: string }[]; fotos: { id: string; posicion: number }[] };
    expect(ficha.nombre).toBe("Riñonera Girasol");
    expect(ficha.variantes).toEqual([expect.objectContaining({ stock: 2, precio: "$13.000" })]);
    expect(ficha.fotos).toEqual([{ id: "m1", tipo: "photo", posicion: 0 }]);
    expect(await read("ver_producto", { producto_id: "nope" })).toBe("No encuentro ese producto.");
  });
});

describe("ejecutores de respaldo: el Si nunca queda mudo", () => {
  class FakeTg implements TelegramApi {
    sent: { text: string; buttons?: unknown[] }[] = [];
    async answerCallback() {}
    async send(_c: number, text: string, buttons?: { etiqueta: string; valor: string }[]) { this.sent.push({ text, buttons }); }
    async clearButtons() {}
  }

  it("pedir_contenido: queda cancelled, avisa 'todavia no', escribe event_log y no ofrece Deshacer", async () => {
    const tg = new FakeTg();
    const { id } = await mk("pedir_contenido", { tipo: "flyer", plantilla: "producto" });
    await handleCallback(e, { id: "cb", data: paData(id, "yes"), message: { message_id: 7, chat: { id: CHAT } } }, { tg, store: new InMemoryConversationStore(), now: T0 });
    expect(tg.sent).toEqual([{ text: copyCatalogo.contenidoTodavia, buttons: undefined }]);
    expect((await one<{ status: string }>("SELECT status FROM pending_actions WHERE id=?", id)).status).toBe("cancelled");
    expect(await all("SELECT id FROM pending_actions WHERE status='pending'")).toHaveLength(0);
    expect(await all("SELECT data FROM event_log WHERE type='content.not_available'")).toHaveLength(1);
    expect(copyCatalogo.contenidoTodavia).not.toMatch(/job|etapa|stage|error/i);
  });

  it("posponer_aviso: guarda snooze:<tipo> con el hasta, confirma en simple y Deshacer lo anula", async () => {
    const tg = new FakeTg();
    const a = await mk("posponer_aviso", { tipo_aviso: "Stock bajo", hasta: "en_3h" });
    await handleCallback(e, { id: "cb", data: paData(a.id, "yes"), message: { message_id: 7, chat: { id: CHAT } } }, { tg, store: new InMemoryConversationStore(), now: T0 });
    expect(tg.sent[0]!.text).toBe(copyCatalogo.avisoAnotado);
    expect(await all("SELECT id FROM pending_actions WHERE status='pending'")).toHaveLength(0);
    const row = await one<{ value: string }>("SELECT value FROM settings WHERE key=?", "snooze:stock_bajo");
    expect(JSON.parse(row.value)).toMatchObject({ until: T0 + 3 * 3_600_000, hasta: "en_3h", action_id: a.id });
    expect(await activeSnooze(db, "stock bajo", T0 + 1000)).toBe(true);
    expect(await activeSnooze(db, "stock bajo", T0 + 4 * 3_600_000)).toBe(false); // venció

    expect((await undoAction(db, a.id, { chatId: CHAT, actor: "owner", now: T0 + 2 })).kind).toBe("undone");
    expect(await activeSnooze(db, "stock bajo", T0 + 1000)).toBe(false);
  });

  it("'nunca' no vence; 'manana' es 09:00 de Argentina del dia siguiente", async () => {
    expect(snoozeUntil("nunca", T0)).toBeNull();
    // T0 = 2027-01-15 08:00 UTC = 05:00 AR → mañana 09:00 AR = 2027-01-16 12:00 UTC
    expect(new Date(snoozeUntil("manana", T0)!).toISOString()).toBe("2027-01-16T12:00:00.000Z");
    const a = await mk("posponer_aviso", { tipo_aviso: "flyer_semanal", hasta: "nunca" });
    await executeAction(a.id, CHAT, { db, now: T0 });
    expect(await activeSnooze(db, "flyer_semanal", T0 + 400 * 86_400_000)).toBe(true);
    expect(snoozeKey("Flyer semanal")).toBe("snooze:flyer_semanal");
  });
});
