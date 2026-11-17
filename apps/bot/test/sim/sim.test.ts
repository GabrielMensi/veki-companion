// Simulador de updates (sucesor de spikes/telegram/src/sim.ts).
// Cada fixture es una secuencia de updates de Telegram que entra por el Worker real (`worker.fetch`)
// con secret válido y chat permitido. Después se reproduce la cola `q-updates` con el consumidor real
// (`handleBatch`). La Bot API está stubeada: se registran los métodos llamados.
//
// Lo que se afirma hoy: respuesta HTTP, filas en `updates` (D1), mensajes encolados, dedupe y que el
// consumidor confirma cada mensaje. Las aserciones más profundas (respuestas, descargas a R2, flush de
// álbumes, ejecución de acciones) quedan como `it.todo` hasta que su tarea dueña las complete.

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../../src/index";
import type { Env } from "../../src/env";
import { handleBatch, type QueueMessageLike } from "../../src/queues";
import { createStubBotApi, type BotApiError } from "./stub-bot-api";
import mediaSingle from "./fixtures/media-single.json";
import mediaAlbums from "./fixtures/media-albums.json";
import textVoice from "./fixtures/text-voice.json";
import callbacks from "./fixtures/callback.json";

// Valores inventados solo para el simulador.
const SECRET = "sim-secret-123";
const CHAT_ID = 1001;
const db = (env as unknown as { DB: Env["DB"] }).DB;

type Sent = { type: string; update_id: number; update: unknown };
type SimCase = {
  id: string;
  description: string;
  updates: Record<string, unknown>[];
  botApi?: Record<string, BotApiError>;
  expect: { rows: { update_id: number; kind: "message" | "callback_query" }[] };
  deferred: { owner: string; reply?: string; note: string };
};

const cases: SimCase[] = [
  ...(mediaSingle as unknown as SimCase[]),
  ...(mediaAlbums as unknown as SimCase[]),
  ...(textVoice as unknown as SimCase[]),
  ...(callbacks as unknown as SimCase[]),
];

// Los nombres de test van en ASCII (como el resto de tests del bot): el header MF-Vitest-Source no admite acentos.
const ascii = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\x20-\x7e]/g, "?");

function makeEnv(sent: Sent[]): Env {
  return {
    DB: db,
    MEDIA: null,
    Q_UPDATES: { send: async (m) => void sent.push(m as Sent) },
    Q_JOBS: { send: async () => {} },
    TELEGRAM_BOT_TOKEN: "sim-token",
    TG_WEBHOOK_SECRET: SECRET,
    ALLOWED_CHAT_IDS: `${CHAT_ID}:owner`,
  };
}

function post(body: unknown) {
  return new Request("https://bot.test/tg/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": SECRET },
    body: JSON.stringify(body),
  });
}

async function count(table: string, where = "1=1") {
  return (await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).first<{ n: number }>())!.n;
}

/** Corre un caso completo: webhook por cada update, luego el consumidor sobre lo encolado. */
async function simulate(c: SimCase) {
  await db.prepare("DELETE FROM updates").run();
  await db.prepare("DELETE FROM event_log").run();

  const sent: Sent[] = [];
  const testEnv = makeEnv(sent);
  const botApi = createStubBotApi({ errors: c.botApi });
  const restore = botApi.install();
  try {
    const statuses: number[] = [];
    for (const update of c.updates) statuses.push((await worker.fetch(post(update), testEnv)).status);
    const webhook = {
      statuses,
      sent: [...sent],
      botCalls: botApi.calls.length,
      accessDenied: await count("event_log", "type='access.denied'"),
      rows: (await db.prepare("SELECT update_id, chat_id, kind, status FROM updates ORDER BY update_id").all<{
        update_id: number;
        chat_id: number;
        kind: string;
        status: string;
      }>()).results,
    };

    const acked: number[] = [];
    const retried: number[] = [];
    const messages: QueueMessageLike[] = sent.map((body, i) => ({
      body,
      attempts: 1,
      ack: () => void acked.push(i),
      retry: () => void retried.push(i),
    }));
    await handleBatch({ queue: "q-updates", messages }, testEnv);
    const consumer = {
      acked: acked.length,
      retried: retried.length,
      unknownType: await count("event_log", "type='queue.unknown_type'"),
    };
    return { webhook, consumer, unexpectedHosts: botApi.unexpected, botCalls: botApi.calls };
  } finally {
    restore();
  }
}

beforeEach(async () => {
  await db.prepare("DELETE FROM updates").run();
  await db.prepare("DELETE FROM event_log").run();
});

describe("simulador: stub de la Bot API", () => {
  it("registra metodos y payloads, y devuelve errores configurados", async () => {
    const stub = createStubBotApi({ errors: { getFile: { error_code: 400, description: "Bad Request: file is too big" } } });
    const ok = await stub.fetch("https://api.telegram.org/bottest-token/sendMessage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT_ID, text: "hola" }),
    });
    expect((await ok.json()) as { ok: boolean }).toMatchObject({ ok: true });
    const bad = await stub.fetch("https://api.telegram.org/bottest-token/getFile?file_id=x");
    expect(bad.status).toBe(400);
    expect(stub.calls).toEqual([
      { method: "sendMessage", payload: { chat_id: CHAT_ID, text: "hola" } },
      { method: "getFile", payload: { file_id: "x" } },
    ]);
    expect(stub.unexpected).toEqual([]);
  });

  it("marca como inesperada cualquier llamada fuera de la Bot API", async () => {
    const stub = createStubBotApi();
    await stub.fetch("https://hooks.test/deploy");
    expect(stub.unexpected).toEqual(["hooks.test"]);
    expect(stub.calls).toEqual([]);
  });
});

describe("simulador: fixtures de updates", () => {
  for (const c of cases) {
    describe(c.id, () => {
      it(ascii(`webhook: 200 por update, filas en updates y mensajes encolados (${c.description})`), async () => {
        const run = await simulate(c);
        expect(run.webhook.statuses).toEqual(c.updates.map(() => 200));
        expect(run.webhook.accessDenied).toBe(0);
        // El webhook responde sin llamar a la Bot API: las respuestas salen desde el consumidor.
        expect(run.webhook.botCalls).toBe(0);
        expect(run.unexpectedHosts).toEqual([]);

        // Filas en D1: una por update_id distinto, en cola, del chat permitido.
        const expectedIds = [...new Set(c.expect.rows.map((r) => r.update_id))].sort((a, b) => a - b);
        expect(run.webhook.rows).toEqual(
          c.expect.rows
            .slice()
            .sort((a, b) => a.update_id - b.update_id)
            .map((r) => ({ update_id: r.update_id, chat_id: CHAT_ID, kind: r.kind, status: "queued" })),
        );
        // Un mensaje por update_id distinto (los reenvíos se deduplican en el webhook).
        expect(run.webhook.sent.map((m) => m.update_id).sort((a, b) => a - b)).toEqual(expectedIds);
        expect(run.webhook.sent.every((m) => m.type === "update")).toBe(true);
      });

      it("consumidor: confirma cada mensaje encolado sin reintentos ni tipos desconocidos", async () => {
        const run = await simulate(c);
        expect(run.consumer.acked).toBe(run.webhook.sent.length);
        expect(run.consumer.retried).toBe(0);
        expect(run.consumer.unknownType).toBe(0);
      });
    });
  }
});

// Aserciones profundas, pendientes de su tarea dueña (campo `deferred.owner` de cada fixture):
//  - T16: texto y voz llegan al agente y producen respuesta (router de `update` en queues.ts sigue stub).
//  - T17: medios (R2, `media`, álbumes con `album.flush`, getFile 400, tope de 20 MB, tipo no soportado).
//  - T18: acciones pendientes (`pa:<id>:yes`, doble toque, vencimiento, cancelar).
// Cuando una tarea complete su parte, convertir el `it.todo` en `it` con la aserción real.
describe("simulador: aserciones pendientes", () => {
  for (const c of cases) {
    const reply = c.deferred.reply ? ` · respuesta ~ /${c.deferred.reply}/` : "";
    it.todo(ascii(`${c.id} [${c.deferred.owner}]: ${c.deferred.note}${reply}`));
  }
});
