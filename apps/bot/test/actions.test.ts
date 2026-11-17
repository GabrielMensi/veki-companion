import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { copy, copyAcciones, emptyState, InMemoryConversationStore, paData, paUndoData, type ConversationStore } from "@veki/core";
import { D1ConversationStore, isVersionConflict, updateState } from "../src/actions/conversation-store";
import { executeAction } from "../src/actions/execute";
import { ActionError } from "../src/actions/executors";
import { ACTION_TTL_MS, createPendingAction } from "../src/actions/pending";
import { undoAction } from "../src/actions/undo";
import type { Env } from "../src/env";
import { handleCallback, parseCallbackData, type TelegramApi } from "../src/handlers/callback";

// Todo inventado: nombres, ids y chats de prueba.
const db = (env as unknown as { DB: Env["DB"] }).DB;
const e = { DB: db, ALLOWED_CHAT_IDS: "1001:owner", TELEGRAM_BOT_TOKEN: "t" } as unknown as Env;
const CHAT = 1001;
const T0 = 1_800_000_000_000;

class FakeTg implements TelegramApi {
  sent: { chatId: number; text: string; buttons?: { etiqueta: string; valor: string }[] }[] = [];
  cleared: number[] = [];
  answered: string[] = [];
  async answerCallback(id: string) { this.answered.push(id); }
  async send(chatId: number, text: string, buttons?: { etiqueta: string; valor: string }[]) { this.sent.push({ chatId, text, buttons }); }
  async clearButtons(_c: number, m: number) { this.cleared.push(m); }
}

const all = async <T>(sql: string, ...b: unknown[]) => (await db.prepare(sql).bind(...b).all<T>()).results;
const one = async <T>(sql: string, ...b: unknown[]) => (await db.prepare(sql).bind(...b).first<T>())!;
const click = (tg: FakeTg, store: ConversationStore, data: string, now = T0, messageId = 55) =>
  handleCallback(e, { id: "cb1", data, message: { message_id: messageId, chat: { id: CHAT } } }, { tg, store, now });

async function seedProduct() {
  await db.prepare("INSERT INTO products (id, slug, name, category, description, price_ars, status, featured, created_at, updated_at) VALUES ('p1','rinonera-girasol','Riñonera Girasol','riñoneras','linda',12500,'active',0,1,1)").run();
  await db.prepare("INSERT INTO variants (id, product_id, design, size, color, price_ars, stock, status, updated_at) VALUES ('v1','p1','','','',NULL,3,'active',1)").run();
}
const mkAction = (tool: string, args: Record<string, unknown>, now = T0) =>
  createPendingAction(e, { chatId: CHAT, tool: tool as never, args, preview: "vista previa" }, now);

beforeEach(async () => {
  for (const t of ["event_log", "pending_actions", "conversations", "variants", "products", "fairs", "site_state"]) {
    await db.prepare(`DELETE FROM ${t}`).run();
  }
});

describe("createPendingAction", () => {
  it("inserts a pending row that expires in 24 h", async () => {
    const { id } = await mkAction("cancelar_feria", { feria_id: "f1" });
    const row = await one<{ status: string; expires_at: number; created_at: number }>("SELECT * FROM pending_actions WHERE id=?", id);
    expect(row.status).toBe("pending");
    expect(row.expires_at - row.created_at).toBe(ACTION_TTL_MS);
  });

  it("supersedes: the previous action becomes cancelled, the new one stays pending", async () => {
    const a = await mkAction("editar_producto", { producto_id: "p1", cambios: { name: "A" } });
    const b = await createPendingAction(e, { chatId: CHAT, tool: "editar_producto", args: {}, preview: "x", supersedes: a.id }, T0 + 1);
    expect((await one<{ status: string }>("SELECT status FROM pending_actions WHERE id=?", a.id)).status).toBe("cancelled");
    expect((await one<{ status: string }>("SELECT status FROM pending_actions WHERE id=?", b.id)).status).toBe("pending");
  });

  it("supersedes never touches an already executed action", async () => {
    await seedProduct();
    const a = await mkAction("editar_producto", { producto_id: "p1", cambios: { name: "Nueva" } });
    await executeAction(a.id, CHAT, { db, now: T0 });
    await createPendingAction(e, { chatId: CHAT, tool: "editar_producto", args: {}, preview: "x", supersedes: a.id }, T0 + 1);
    expect((await one<{ status: string }>("SELECT status FROM pending_actions WHERE id=?", a.id)).status).toBe("executed");
  });
});

describe("callbacks: confirmar", () => {
  it("double Si (sequential and concurrent) executes once", async () => {
    await seedProduct();
    const tg = new FakeTg();
    const store = new InMemoryConversationStore();
    const a = await mkAction("cambiar_stock", { variante_id: "v1", delta: -1, motivo: "venta" });
    await Promise.all([click(tg, store, paData(a.id, "yes")), click(tg, store, paData(a.id, "yes"))]);
    await click(tg, store, paData(a.id, "yes"));
    expect((await one<{ stock: number }>("SELECT stock FROM variants WHERE id='v1'")).stock).toBe(2); // 3 - 1, una sola vez
    expect(await all("SELECT id FROM event_log WHERE type='action.executed'")).toHaveLength(1);
    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0]!.text).toBe(copyAcciones.stockActualizado("Riñonera Girasol", 2));
    expect(tg.sent[0]!.buttons).toEqual([{ etiqueta: "Deshacer", valor: paUndoData(a.id) }]);
  });

  it("execution writes event_log and sets site_state.dirty_since (keeping the oldest mark)", async () => {
    await seedProduct();
    await db.prepare("INSERT INTO site_state (id, dirty_since) VALUES (1, 5)").run();
    const a = await mkAction("editar_producto", { producto_id: "p1", cambios: { price_ars: 15000 } });
    await executeAction(a.id, CHAT, { db, now: T0 });
    const log = await one<{ actor: string; entity: string; entity_id: string; data: string }>("SELECT * FROM event_log WHERE type='action.executed'");
    expect(log).toMatchObject({ actor: "owner", entity: "product", entity_id: "p1" });
    expect(JSON.parse(log.data)).toEqual({ tool: "editar_producto", action_id: a.id });
    expect((await one<{ dirty_since: number }>("SELECT dirty_since FROM site_state WHERE id=1")).dirty_since).toBe(5);
  });

  it("creates site_state when missing", async () => {
    await seedProduct();
    const a = await mkAction("editar_producto", { producto_id: "p1", cambios: { price_ars: 15000 } });
    await executeAction(a.id, CHAT, { db, now: T0 });
    expect((await one<{ dirty_since: number }>("SELECT dirty_since FROM site_state WHERE id=1")).dirty_since).toBe(T0);
  });

  it("expired button -> copy.vencido and status expired, nothing executed", async () => {
    await seedProduct();
    const tg = new FakeTg();
    const a = await mkAction("editar_producto", { producto_id: "p1", cambios: { name: "X" } });
    await click(tg, new InMemoryConversationStore(), paData(a.id, "yes"), T0 + ACTION_TTL_MS + 1);
    expect(tg.sent.map((s) => s.text)).toEqual([copy.vencido]);
    expect((await one<{ status: string }>("SELECT status FROM pending_actions WHERE id=?", a.id)).status).toBe("expired");
    expect((await one<{ name: string }>("SELECT name FROM products WHERE id='p1'")).name).toBe("Riñonera Girasol");
    expect(await all("SELECT id FROM event_log")).toHaveLength(0);
  });

  it("button of another chat or unknown id does nothing", async () => {
    const tg = new FakeTg();
    const a = await createPendingAction(e, { chatId: 999, tool: "cancelar_feria", args: { feria_id: "f" }, preview: "x" }, T0);
    await click(tg, new InMemoryConversationStore(), paData(a.id, "yes"));
    await click(tg, new InMemoryConversationStore(), paData("nope", "yes"));
    expect(tg.sent).toEqual([]);
    expect((await one<{ status: string }>("SELECT status FROM pending_actions WHERE id=?", a.id)).status).toBe("pending");
  });

  it("a tool without executor yet keeps the action pending and says so", async () => {
    const tg = new FakeTg();
    const a = await mkAction("pedir_contenido", { tipo: "flyer", plantilla: "feria" });
    await click(tg, new InMemoryConversationStore(), paData(a.id, "yes"));
    expect(tg.sent[0]!.text).toBe(copyAcciones.todaviaNo);
    expect((await one<{ status: string }>("SELECT status FROM pending_actions WHERE id=?", a.id)).status).toBe("pending");
  });

  it("an impossible action is cancelled with a friendly message (no negative stock)", async () => {
    await seedProduct();
    const tg = new FakeTg();
    const a = await mkAction("cambiar_stock", { variante_id: "v1", delta: -10, motivo: "venta" });
    await click(tg, new InMemoryConversationStore(), paData(a.id, "yes"));
    expect(tg.sent[0]!.text).toBe(copyAcciones.stockNegativo);
    expect((await one<{ status: string }>("SELECT status FROM pending_actions WHERE id=?", a.id)).status).toBe("cancelled");
    expect((await one<{ stock: number }>("SELECT stock FROM variants WHERE id='v1'")).stock).toBe(3);
  });

  it("a failing write rolls everything back and releases the action for retry", async () => {
    await seedProduct();
    const a = await mkAction("editar_producto", { producto_id: "p1", cambios: { name: "Cambiado" } });
    const bad = {
      editar_producto: async ({ db: d, now }: { db: Env["DB"]; now: number }) => ({
        statements: [
          d.prepare("UPDATE products SET name='Cambiado' WHERE id='p1'"),
          d.prepare("INSERT INTO products (id, slug, name, category, status, featured, created_at, updated_at) VALUES ('p9','rinonera-girasol','dup','c','active',0,?,?)").bind(now, now), // slug duplicado
        ],
        inverse: [],
        message: "x",
        public: true,
      }),
    };
    await expect(executeAction(a.id, CHAT, { db, now: T0, executors: bad as never })).rejects.toThrow();
    expect((await one<{ name: string }>("SELECT name FROM products WHERE id='p1'")).name).toBe("Riñonera Girasol");
    expect((await one<{ status: string; executed_at: number | null }>("SELECT * FROM pending_actions WHERE id=?", a.id))).toMatchObject({ status: "pending", executed_at: null });
    expect(await all("SELECT id FROM event_log")).toHaveLength(0);
    // y el reintento (ejecutor real) sí funciona
    expect((await executeAction(a.id, CHAT, { db, now: T0 + 1 })).kind).toBe("executed");
  });

  it("ActionError is exported for T19 executors", () => {
    expect(new ActionError("x").userMessage).toBe("x");
  });
});

describe("callbacks: cancelar y cambiar", () => {
  it("'Cancelar' cancels once and clears the buttons", async () => {
    const tg = new FakeTg();
    const store = new InMemoryConversationStore();
    const a = await mkAction("cancelar_feria", { feria_id: "f1" });
    await click(tg, store, paData(a.id, "no"));
    await click(tg, store, paData(a.id, "no"));
    expect(tg.sent.map((s) => s.text)).toEqual([copyAcciones.cancelado]);
    expect(tg.cleared).toEqual([55]);
    await click(tg, store, paData(a.id, "yes")); // tras cancelar, un "Sí" viejo no ejecuta
    expect(tg.sent).toHaveLength(1);
    expect(await all("SELECT id FROM event_log")).toHaveLength(0);
  });

  it("'Cambiar' -> awaiting edit + question; the next action supersedes (previous cancelled, new pending)", async () => {
    const tg = new FakeTg();
    const store = new D1ConversationStore(db, () => "owner", () => T0);
    const a = await mkAction("editar_producto", { producto_id: "p1", cambios: { price_ars: 100 } });
    await click(tg, store, paData(a.id, "edit"));
    expect(tg.sent.map((s) => s.text)).toEqual([copy.cambiarPregunta]);
    const snap = await store.load(CHAT);
    expect(snap.state.awaiting).toEqual({ kind: "edit", pending_action_id: a.id });
    // el agente crea la nueva con supersedes = awaiting.pending_action_id
    const b = await createPendingAction(
      e,
      { chatId: CHAT, tool: "editar_producto", args: { producto_id: "p1", cambios: { price_ars: 200 } }, preview: "nueva", supersedes: snap.state.awaiting!.pending_action_id },
      T0 + 1,
    );
    expect((await one<{ status: string }>("SELECT status FROM pending_actions WHERE id=?", a.id)).status).toBe("cancelled");
    expect((await one<{ status: string }>("SELECT status FROM pending_actions WHERE id=?", b.id)).status).toBe("pending");
  });

  it("'Cambiar' on an expired action says vencido and does not touch the conversation", async () => {
    const tg = new FakeTg();
    const store = new InMemoryConversationStore();
    const a = await mkAction("cancelar_feria", { feria_id: "f1" });
    await click(tg, store, paData(a.id, "edit"), T0 + ACTION_TTL_MS);
    expect(tg.sent.map((s) => s.text)).toEqual([copy.vencido]);
    expect(store.rows.size).toBe(0);
  });
});

describe("deshacer", () => {
  it("restores exactly the previous row (snapshot comparison) via the Deshacer button", async () => {
    await seedProduct();
    const before = await one<Record<string, unknown>>("SELECT * FROM products WHERE id='p1'");
    const tg = new FakeTg();
    const store = new InMemoryConversationStore();
    const a = await mkAction("editar_producto", { producto_id: "p1", cambios: { name: "Otro nombre", price_ars: 1, description: "otra", category: "bolsos", status: "hidden" } });
    await click(tg, store, paData(a.id, "yes"), T0 + 10);
    expect(await one("SELECT * FROM products WHERE id='p1'")).not.toEqual(before);
    await click(tg, store, paUndoData(a.id), T0 + 20);
    expect(await one("SELECT * FROM products WHERE id='p1'")).toEqual(before);
    expect((await one<{ status: string }>("SELECT status FROM pending_actions WHERE id=?", a.id)).status).toBe("undone");
    expect(tg.sent.at(-1)!.text).toBe(copyAcciones.deshecho);
    expect(await all("SELECT id FROM event_log WHERE type='action.undone'")).toHaveLength(1);
    expect((await one<{ dirty_since: number }>("SELECT dirty_since FROM site_state WHERE id=1")).dirty_since).toBe(T0 + 10);
  });

  it("undoing a created fair deletes it; double tap undoes once", async () => {
    const tg = new FakeTg();
    const store = new InMemoryConversationStore();
    const a = await mkAction("crear_feria", { nombre: "Feria del Parque", lugar: "Plaza", inicio: "2027-01-10T10:00", fin: "2027-01-10T18:00" });
    await click(tg, store, paData(a.id, "yes"));
    const fair = await one<{ starts_at: number; ends_at: number; status: string }>("SELECT * FROM fairs");
    expect(fair).toMatchObject({ starts_at: Date.UTC(2027, 0, 10, 13, 0), ends_at: Date.UTC(2027, 0, 10, 21, 0), status: "confirmed" }); // UTC-3
    await Promise.all([click(tg, store, paUndoData(a.id), T0 + 1), click(tg, store, paUndoData(a.id), T0 + 1)]);
    expect(await all("SELECT id FROM fairs")).toHaveLength(0);
    expect(await all("SELECT id FROM event_log WHERE type='action.undone'")).toHaveLength(1);
  });

  it("undo after 24 h answers vencido and keeps the change", async () => {
    await seedProduct();
    const tg = new FakeTg();
    const store = new InMemoryConversationStore();
    const a = await mkAction("editar_producto", { producto_id: "p1", cambios: { name: "Nuevo" } });
    await click(tg, store, paData(a.id, "yes"), T0);
    await click(tg, store, paUndoData(a.id), T0 + ACTION_TTL_MS + 1);
    expect(tg.sent.at(-1)!.text).toBe(copy.vencido);
    expect((await one<{ name: string }>("SELECT name FROM products WHERE id='p1'")).name).toBe("Nuevo");
  });

  it("a pending action cannot be undone", async () => {
    const a = await mkAction("cancelar_feria", { feria_id: "f1" });
    expect((await undoAction(db, a.id, { chatId: CHAT, actor: "owner", now: T0 })).kind).toBe("not_undoable");
  });

  it("tool 'deshacer' (after confirming) undoes the last executed action by default", async () => {
    await seedProduct();
    const tg = new FakeTg();
    const store = new InMemoryConversationStore();
    const before = await one("SELECT * FROM variants WHERE id='v1'");
    const a = await mkAction("cambiar_stock", { variante_id: "v1", fijar: 9, motivo: "reposicion" });
    await click(tg, store, paData(a.id, "yes"), T0 + 1);
    const d = await mkAction("deshacer", {}, T0 + 2);
    await click(tg, store, paData(d.id, "yes"), T0 + 3);
    expect(await one("SELECT * FROM variants WHERE id='v1'")).toEqual(before);
    expect(tg.sent.at(-1)).toMatchObject({ text: copyAcciones.deshecho, buttons: undefined });
    // sin nada que deshacer, avisa
    const d2 = await mkAction("deshacer", {}, T0 + 4);
    await click(tg, store, paData(d2.id, "yes"), T0 + 5);
    expect(tg.sent.at(-1)!.text).toBe(copyAcciones.nadaParaDeshacer);
  });
});

describe("draft and conversation", () => {
  it("confirming crear_feria clears the matching draft", async () => {
    const store = new D1ConversationStore(db, () => "owner", () => T0);
    const snap = await store.load(CHAT);
    await store.save(CHAT, { state: { ...emptyState(), draft: { tipo: "feria", campos: { name: "F" }, media_ids: [] } }, history: [] }, snap.version);
    const a = await mkAction("crear_feria", { nombre: "F", lugar: "L", inicio: "2027-01-10", fin: "2027-01-11" });
    await executeAction(a.id, CHAT, { db, store, now: T0 });
    expect((await store.load(CHAT)).state.draft).toBeNull();
  });

  it("does not clear a draft of another type", async () => {
    const store = new InMemoryConversationStore();
    store.rows.set(CHAT, { state: { ...emptyState(), draft: { tipo: "producto", campos: { name: "P" }, media_ids: [] } }, history: [], version: 1 });
    const a = await mkAction("crear_feria", { nombre: "F", lugar: "L", inicio: "2027-01-10", fin: "2027-01-11" });
    await executeAction(a.id, CHAT, { db, store, now: T0 });
    expect((await store.load(CHAT)).state.draft?.tipo).toBe("producto");
  });

  it("D1 store: create, update, and stale version is rejected", async () => {
    const s = new D1ConversationStore(db, () => "admin", () => T0);
    expect(await s.load(7)).toEqual({ state: emptyState(), history: [], version: 0 });
    await s.save(7, { state: emptyState(), history: [{ role: "user", content: "hola" }] }, 0);
    const v1 = await s.load(7);
    expect(v1.version).toBe(1);
    expect(v1.history).toEqual([{ role: "user", content: "hola" }]);
    expect((await one<{ role: string }>("SELECT role FROM conversations WHERE chat_id=7")).role).toBe("admin");
    await s.save(7, { state: emptyState(), history: [] }, 1);
    const err = await s.save(7, { state: emptyState(), history: [] }, 1).catch((x) => x);
    expect(isVersionConflict(err)).toBe(true);
    const err0 = await s.save(7, { state: emptyState(), history: [] }, 0).catch((x) => x); // "primera vez" pero la fila ya existe
    expect(isVersionConflict(err0)).toBe(true);
    expect((await s.load(7)).version).toBe(2);
  });

  it("version conflict: updateState reloads and retries, preserving the concurrent writer's changes", async () => {
    const s = new D1ConversationStore(db, () => "owner", () => T0);
    await s.save(8, { state: emptyState(), history: [] }, 0);
    let interfered = false;
    const racy: ConversationStore = {
      load: (c) => s.load(c),
      async save(c, snap, v) {
        if (!interfered) {
          interfered = true; // otro update escribe justo antes que nosotros
          await s.save(c, { state: { ...emptyState(), misunderstandings: 1 }, history: [{ role: "user", content: "hola" }] }, v);
        }
        return s.save(c, snap, v);
      },
    };
    const out = await updateState(racy, 8, (st) => ({ ...st, awaiting: { kind: "edit", pending_action_id: "x" } }));
    expect(out.misunderstandings).toBe(1);
    const final = await s.load(8);
    expect(final.state.awaiting).toEqual({ kind: "edit", pending_action_id: "x" });
    expect(final.state.misunderstandings).toBe(1);
    expect(final.history).toEqual([{ role: "user", content: "hola" }]);
    expect(final.version).toBe(3);
  });

  it("updateState gives up after the attempts and rethrows the conflict", async () => {
    const always: ConversationStore = {
      load: async () => ({ state: emptyState(), history: [], version: 0 }),
      save: async () => { throw new Error("conversation version conflict"); },
    };
    await expect(updateState(always, 1, (s) => s, 3)).rejects.toThrow(/version conflict/);
  });
});

describe("callback_data", () => {
  it("parses pa:<id>:yes|edit|no|undo and ignores others", () => {
    expect(parseCallbackData("pa:01ABC:yes")).toEqual({ id: "01ABC", action: "yes" });
    expect(parseCallbackData("pa:01ABC:undo")).toEqual({ id: "01ABC", action: "undo" });
    expect(parseCallbackData("atajo:producto")).toBeNull();
    expect(parseCallbackData("pa:x:chg")).toBeNull();
    expect(parseCallbackData(undefined)).toBeNull();
  });
});

describe("queue router", () => {
  it("update handler ignores non-callback updates and unknown callback data without touching Telegram", async () => {
    const { handleUpdateMessage } = await import("../src/handlers/callback");
    await expect(handleUpdateMessage({ update: { message: { text: "hola" } } }, e)).resolves.toBeUndefined();
    const { handlers } = await import("../src/queues");
    expect(handlers.update).toBe(handleUpdateMessage);
  });
});
