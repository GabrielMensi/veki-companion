import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { handleBatch } from "../src/queues";
import type { Env } from "../src/env";

// Valores inventados solo para tests.
const SECRET = "test-secret-123";
const OWNER = 1001;
const STRANGER = 9999;

const db = (env as unknown as { DB: Env["DB"] }).DB;

function makeEnv() {
  const sent: unknown[] = [];
  const testEnv: Env = {
    DB: db,
    MEDIA: null,
    Q_UPDATES: { send: async (m) => void sent.push(m) },
    Q_JOBS: { send: async () => {} },
    TELEGRAM_BOT_TOKEN: "test-token",
    TG_WEBHOOK_SECRET: SECRET,
    ALLOWED_CHAT_IDS: `${OWNER}:owner,2002:admin`,
  };
  return { testEnv, sent };
}

function post(body: unknown, secret: string | null = SECRET) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secret !== null) headers["X-Telegram-Bot-Api-Secret-Token"] = secret;
  return new Request("https://bot.test/tg/webhook", { method: "POST", headers, body: JSON.stringify(body) });
}

const msg = (update_id: number, chat = OWNER) => ({ update_id, message: { message_id: 1, chat: { id: chat }, text: "hola" } });
const cb = (update_id: number, chat = OWNER) => ({ update_id, callback_query: { id: "c1", from: { id: chat }, message: { chat: { id: chat } }, data: "pa:1:yes" } });

async function count(table: string, where = "1=1") {
  return (await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).first<{ n: number }>())!.n;
}

beforeEach(async () => {
  await db.prepare("DELETE FROM updates").run();
  await db.prepare("DELETE FROM event_log").run();
});

describe("webhook de Telegram", () => {
  it("secret invalido o ausente -> 401 sin escrituras ni cola", async () => {
    const { testEnv, sent } = makeEnv();
    for (const s of ["otro", null]) {
      expect((await worker.fetch(post(msg(1), s), testEnv)).status).toBe(401);
    }
    expect((await worker.fetch(post(msg(1, STRANGER), "otro"), testEnv)).status).toBe(401);
    expect(await count("updates")).toBe(0);
    expect(await count("event_log")).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it("sin secret configurado cierra por defecto", async () => {
    const { testEnv } = makeEnv();
    testEnv.TG_WEBHOOK_SECRET = "";
    expect((await worker.fetch(post(msg(1), ""), testEnv)).status).toBe(401);
  });

  it("chat no permitido -> 200, event_log access.denied y nada encolado", async () => {
    const { testEnv, sent } = makeEnv();
    const res = await worker.fetch(post(msg(2, STRANGER)), testEnv);
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(0);
    expect(await count("updates")).toBe(0);
    const row = await db.prepare("SELECT type, severity, data FROM event_log WHERE type='access.denied'").first<{ severity: string; data: string }>();
    expect(row?.severity).toBe("warn");
    expect(row?.data).not.toContain("hola");
    expect(row?.data).not.toContain(String(STRANGER));
  });

  it("mismo update_id dos veces -> un solo mensaje en cola", async () => {
    const { testEnv, sent } = makeEnv();
    expect((await worker.fetch(post(msg(3)), testEnv)).status).toBe(200);
    expect((await worker.fetch(post(msg(3)), testEnv)).status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: "update", update_id: 3 });
    expect(await count("updates", "update_id=3")).toBe(1);
  });

  it("callback_query se encola", async () => {
    const { testEnv, sent } = makeEnv();
    expect((await worker.fetch(post(cb(4)), testEnv)).status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(await count("updates", "update_id=4 AND kind='callback_query'")).toBe(1);
  });

  it("si falla el envio a la cola responde 500 y el reintento vuelve a entrar", async () => {
    const { testEnv, sent } = makeEnv();
    let fail = true;
    testEnv.Q_UPDATES = { send: async (m) => { if (fail) throw new Error("x"); sent.push(m); } };
    expect((await worker.fetch(post(msg(5)), testEnv)).status).toBe(500);
    fail = false;
    expect((await worker.fetch(post(msg(5)), testEnv)).status).toBe(200);
    expect(sent).toHaveLength(1);
  });

  it("cuerpo malformado con secret valido -> 200; metodo/ruta incorrectos", async () => {
    const { testEnv } = makeEnv();
    const bad = new Request("https://bot.test/tg/webhook", { method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": SECRET }, body: "no-json" });
    expect((await worker.fetch(bad, testEnv)).status).toBe(200);
    expect((await worker.fetch(new Request("https://bot.test/tg/webhook"), testEnv)).status).toBe(405);
    expect((await worker.fetch(new Request("https://bot.test/otra"), testEnv)).status).toBe(404);
  });
});

describe("router del consumidor", () => {
  const mk = (body: unknown, attempts = 1) => {
    const r = { acked: false, retried: false };
    return { r, m: { body, attempts, ack: () => void (r.acked = true), retry: () => void (r.retried = true) } };
  };

  it("enruta por type, marca el update como done y confirma", async () => {
    const { testEnv } = makeEnv();
    await worker.fetch(post(msg(6)), testEnv);
    const { r, m } = mk({ type: "update", update_id: 6, update: {} });
    await handleBatch({ queue: "q-updates", messages: [m] }, testEnv);
    expect(r.acked).toBe(true);
    expect((await db.prepare("SELECT status FROM updates WHERE update_id=6").first<{ status: string }>())?.status).toBe("done");
  });

  it("type desconocido: event_log de error y ack", async () => {
    const { testEnv } = makeEnv();
    const { r, m } = mk({ type: "nope" });
    await handleBatch({ queue: "q-jobs", messages: [m] }, testEnv);
    expect(r.acked).toBe(true);
    expect(await count("event_log", "type='queue.unknown_type'")).toBe(1);
  });

  it("handler que falla: retry; al agotar intentos marca failed", async () => {
    const { testEnv } = makeEnv();
    await worker.fetch(post(msg(7)), testEnv);
    const boom = { update: async () => { throw new Error("boom"); } };
    const first = mk({ type: "update", update_id: 7 }, 1);
    await handleBatch({ queue: "q-updates", messages: [first.m] }, testEnv, boom);
    expect(first.r.retried).toBe(true);
    const last = mk({ type: "update", update_id: 7 }, 5);
    await handleBatch({ queue: "q-updates", messages: [last.m] }, testEnv, boom);
    expect(last.r.acked).toBe(true);
    expect((await db.prepare("SELECT status FROM updates WHERE update_id=7").first<{ status: string }>())?.status).toBe("failed");
  });
});
