// Simulador de updates (sucesor de spikes/telegram/src/sim.ts).
// Cada fixture es una secuencia de updates de Telegram que entra por el Worker real (`worker.fetch`)
// con secret válido y chat permitido. Después se reproduce la cola `q-updates` con el consumidor real
// (`handleBatch`). La Bot API está stubeada: se registran los métodos llamados.
//
// El consumidor es el real (`handleBatch` -> dispatcher -> handlers). Proveedores de chat y voz son fakes
// (`setRuntimeOverride`); la Bot API esta stubeada y R2/D1 son los del pool de Workers.

import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker from "../../src/index";
import type { Env } from "../../src/env";
import { handleBatch, type QueueMessageLike } from "../../src/queues";
import { handleAlbumFlush, setAgentEntry } from "../../src/jobs/album-flush";
import { D1ConversationStore } from "../../src/actions/conversation-store";
import { d1ToolHost } from "../../src/actions/pending";
import { albumEntry, setRuntimeOverride } from "../../src/runtime";
import { FakeChatProvider, FakeSttProvider, copy, copyAcciones } from "@veki/core";
import { createStubBotApi, type BotApiError } from "./stub-bot-api";
import mediaSingle from "./fixtures/media-single.json";
import mediaAlbums from "./fixtures/media-albums.json";
import textVoice from "./fixtures/text-voice.json";
import callbacks from "./fixtures/callback.json";

// Valores inventados solo para el simulador.
const SECRET = "sim-secret-123";
const CHAT_ID = 1001;
const db = (env as unknown as { DB: Env["DB"] }).DB;
const r2 = (env as unknown as { MEDIA: R2Bucket }).MEDIA;
const TABLES = ["updates", "event_log", "media", "inbox_groups", "conversations", "pending_actions", "fairs"];
const AGENT_REPLY = "Dale, ya lo vi";

type Sent = { type: string; update_id: number; update: unknown };
type SimCase = {
  id: string;
  description: string;
  updates: Record<string, unknown>[];
  botApi?: Record<string, BotApiError>;
  expect: { rows: { update_id: number; kind: "message" | "callback_query" }[] };
  deferred: { owner: string; reply?: string; note: string };
};

/** Acciones pendientes que los callbacks de los fixtures esperan encontrar (ids inventados). */
const seeds: Record<string, () => Promise<void>> = {
  "callback-pa-yes": () => seedFeria("fake-action-1"),
  "callback-pa-yes-double-tap": () => seedFeria("fake-action-2"),
};
async function seedFeria(id: string) {
  const now = Date.now();
  await db
    .prepare("INSERT INTO pending_actions (id, chat_id, tool, args, preview, status, created_at, expires_at) VALUES (?, ?, 'crear_feria', ?, 'vista previa', 'pending', ?, ?)")
    .bind(id, CHAT_ID, JSON.stringify({ nombre: "Feria del Parque", lugar: "Plaza", inicio: "2027-01-10T10:00", fin: "2027-01-10T18:00" }), now, now + 3_600_000)
    .run();
}

const cases: SimCase[] = [
  ...(mediaSingle as unknown as SimCase[]),
  ...(mediaAlbums as unknown as SimCase[]),
  ...(textVoice as unknown as SimCase[]),
  ...(callbacks as unknown as SimCase[]),
];

// Los nombres de test van en ASCII (como el resto de tests del bot): el header MF-Vitest-Source no admite acentos.
const ascii = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\x20-\x7e]/g, "?");

function makeEnv(sent: Sent[], jobs: unknown[] = []): Env {
  return {
    DB: db,
    MEDIA: r2,
    Q_UPDATES: { send: async (m) => void sent.push(m as Sent) },
    Q_JOBS: { send: async (m) => void jobs.push(m) },
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
  for (const t of TABLES) await db.prepare(`DELETE FROM ${t}`).run();
  await seeds[c.id]?.();

  const sent: Sent[] = [];
  const jobs: { type?: string; gid?: string }[] = [];
  const testEnv = makeEnv(sent, jobs);
  const chat = new FakeChatProvider([
    () => ({ text: null, toolCalls: [{ id: "c1", name: "responder", arguments: { texto: AGENT_REPLY } }], usage: { tokensIn: 1, tokensOut: 1 } }),
  ]);
  const stt = new FakeSttProvider([{ text: "quiero cargar una riñonera", lowConfidence: false }]);
  setRuntimeOverride((e) => ({ chat, stt, store: new D1ConversationStore(e.DB), host: d1ToolHost(e) }));
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
    // Los `album.flush` encolados se corren con la hora adelantada (pasado el debounce de 2 s).
    const flushes: string[] = [];
    for (const j of jobs.filter((j) => j.type === "album.flush")) {
      flushes.push(await handleAlbumFlush({ gid: j.gid }, testEnv, Date.now() + 60_000));
    }
    const consumer = {
      acked: acked.length,
      retried: retried.length,
      unknownType: await count("event_log", "type='queue.unknown_type'"),
    };
    return { webhook, consumer, flushes, chat, stt, unexpectedHosts: botApi.unexpected, botCalls: botApi.calls };
  } finally {
    restore();
    setRuntimeOverride(null);
  }
}

beforeEach(async () => {
  for (const t of TABLES) await db.prepare(`DELETE FROM ${t}`).run();
});
afterEach(() => setRuntimeOverride(null));

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

type Run = Awaited<ReturnType<typeof simulate>>;
const sentTexts = (run: Run) => run.botCalls.filter((c) => c.method === "sendMessage").map((c) => String(c.payload.text));
const methods = (run: Run, m: string) => run.botCalls.filter((c) => c.method === m);
// Lo ultimo que dijo la usuaria en cada llamada al LLM (la primera del turno).
const agentTexts = (run: Run) => run.chat.requests.map((r) => [...r.messages].reverse().find((m) => m.role === "user")!.content as string);
const mediaRows = async () => (await db.prepare("SELECT id, r2_key, kind, status FROM media ORDER BY created_at, id").all<{ id: string; r2_key: string; kind: string; status: string }>()).results;
const inR2 = async (rows: { r2_key: string }[]) => Promise.all(rows.map(async (r) => (await r2.head(r.r2_key)) !== null));

/** Foto/video suelto: un archivo en R2, una fila `media` en inbox y un unico turno del agente con su id. */
async function expectSingleStored(run: Run, kind: "photo" | "video") {
  const rows = await mediaRows();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ kind, status: "inbox" });
  expect(await inR2(rows)).toEqual([true]);
  expect(run.chat.requests).toHaveLength(1);
  expect(agentTexts(run)[0]).toContain(rows[0]!.id);
  expect(sentTexts(run)).toEqual([AGENT_REPLY]);
}

/** Album: todas las piezas en `media`, un solo flush entrega y el agente recibe UN evento con todos los ids. */
async function expectAlbumDelivered(run: Run, members: number) {
  const rows = await mediaRows();
  expect(rows).toHaveLength(members);
  expect(await inR2(rows)).toEqual(rows.map(() => true));
  expect(run.flushes.filter((f) => f === "delivered")).toHaveLength(1); // un solo flush gana
  expect(run.chat.requests).toHaveLength(1);
  for (const r of rows) expect(agentTexts(run)[0]).toContain(r.id);
  expect(sentTexts(run)).toEqual([AGENT_REPLY]); // no hay una respuesta por pieza
}

/** Demasiado pesado: no se guarda nada, responde pidiendo un clip y el agente no interviene. */
async function expectTooBig(run: Run) {
  expect(await mediaRows()).toHaveLength(0);
  expect(methods(run, "downloadFile")).toHaveLength(0);
  expect(sentTexts(run)).toHaveLength(1);
  expect(sentTexts(run)[0]).toMatch(/clip|cortito/);
  expect(run.chat.requests).toHaveLength(0);
}

const deep: Record<string, (run: Run) => Promise<void>> = {
  "text-hola": async (run) => {
    expect(agentTexts(run)).toEqual(["hola"]);
    expect(sentTexts(run)).toEqual([AGENT_REPLY]);
    expect(run.consumer.retried).toBe(0);
  },
  "voice-note": async (run) => {
    expect(methods(run, "downloadFile")).toHaveLength(1);
    expect(run.stt.calls).toHaveLength(1);
    expect(agentTexts(run)).toEqual(["quiero cargar una riñonera"]); // mismo flujo que el texto
    expect(sentTexts(run)).toEqual([AGENT_REPLY]);
    expect(await mediaRows()).toHaveLength(0); // el audio no se guarda
  },
  "callback-pa-yes": async (run) => {
    expect(methods(run, "answerCallbackQuery")).toHaveLength(1);
    expect(sentTexts(run)).toEqual([copyAcciones.feriaCreada("Feria del Parque")]);
    expect(await db.prepare("SELECT status FROM pending_actions WHERE id='fake-action-1'").first()).toEqual({ status: "executed" });
    expect(await count("fairs")).toBe(1);
  },
  "callback-pa-yes-double-tap": async (run) => {
    expect(methods(run, "answerCallbackQuery")).toHaveLength(2);
    expect(sentTexts(run)).toEqual([copyAcciones.feriaCreada("Feria del Parque")]); // el segundo toque no repite nada
    expect(await count("fairs")).toBe(1);
  },
  "album-two-videos": (run) => expectAlbumDelivered(run, 2),
  "album-mixed-photos-video": async (run) => {
    await expectAlbumDelivered(run, 3);
    expect((await mediaRows()).map((r) => r.kind).sort()).toEqual(["photo", "photo", "video"]);
  },
  "album-three-photos-shuffled": async (run) => {
    await expectAlbumDelivered(run, 3); // el reenvio de 1223 no crea una cuarta fila
    expect(await count("inbox_groups", "status='flushed'")).toBe(1);
  },
  "video-5mb": (run) => expectSingleStored(run, "video"),
  "document-video-mp4-5mb": (run) => expectSingleStored(run, "video"), // el document con video/* es video
  "video-note": (run) => expectSingleStored(run, "video"),
  animation: (run) => expectSingleStored(run, "video"),
  "document-video-mp4-over-20mb": expectTooBig,
  "video-over-20mb": expectTooBig,
  "video-size-missing-getfile-too-big": async (run) => {
    expect(methods(run, "getFile")).toHaveLength(1);
    await expectTooBig(run);
  },
  "pdf-document": async (run) => {
    expect(await mediaRows()).toHaveLength(0);
    expect(sentTexts(run)).toEqual([copy.tipoNoSoportado]);
    expect(run.chat.requests).toHaveLength(0);
    expect(run.consumer.retried).toBe(0);
  },
};

describe("simulador: aserciones profundas (consumidor real, proveedores fake)", () => {
  for (const c of cases) {
    it(ascii(`${c.id}: ${c.deferred.note}`), async () => {
      const check = deep[c.id];
      expect(check, `falta la asercion de ${c.id}`).toBeDefined();
      const run = await simulate(c);
      expect(run.consumer.retried).toBe(0);
      await check!(run);
    });
  }
});

describe("simulador: escalacion al admin (2 malentendidos seguidos)", () => {
  const ADMIN = 9001;
  const SECRET_TEXT = "texto-privado-de-prueba";
  const confusedChat = () =>
    new FakeChatProvider([
      () => ({ text: null, toolCalls: [{ id: "c1", name: "buscar_productos", arguments: { consulta: "x" } }], usage: { tokensIn: 1, tokensOut: 1 } }),
    ]);
  const textUpdate = (update_id: number) => ({
    update_id,
    message: { message_id: update_id, date: 0, chat: { id: CHAT_ID, type: "private" }, from: { id: CHAT_ID, is_bot: false, first_name: "Prueba" }, text: SECRET_TEXT },
  });

  async function runUpdates(ids: number[]) {
    const sent: Sent[] = [];
    const testEnv = { ...makeEnv(sent), ALLOWED_CHAT_IDS: `${CHAT_ID}:owner,${ADMIN}:admin` } as Env;
    setRuntimeOverride((e) => ({ chat: confusedChat(), stt: new FakeSttProvider([{ text: "x", lowConfidence: false }]), store: new D1ConversationStore(e.DB), host: d1ToolHost(e) }));
    const botApi = createStubBotApi();
    const restore = botApi.install();
    try {
      for (const id of ids) expect((await worker.fetch(post(textUpdate(id)), testEnv)).status).toBe(200);
      await handleBatch(
        { queue: "q-updates", messages: sent.map((body) => ({ body, attempts: 1, ack: () => {}, retry: () => {} }) as QueueMessageLike) },
        testEnv,
      );
      return botApi.calls.filter((c) => c.method === "sendMessage").map((c) => ({ chat: c.payload.chat_id as number, text: String(c.payload.text) }));
    } finally {
      restore();
    }
  }

  beforeEach(async () => {
    await db.prepare("DELETE FROM settings WHERE key LIKE 'alert_last:%'").run();
    await db.prepare("DELETE FROM conversations").run();
  });

  it("el admin recibe un aviso con el update_id y sin el texto de la usuaria", async () => {
    const out = await runUpdates([5001, 5002]);
    const toAdmin = out.filter((m) => m.chat === ADMIN);
    expect(toAdmin).toHaveLength(1);
    expect(toAdmin[0]!.text).toContain("5002");
    expect(toAdmin[0]!.text).not.toContain(SECRET_TEXT);
    // La usuaria ve el "no entendi" y luego los atajos; ningun mensaje de ella va al admin.
    expect(out.filter((m) => m.chat === CHAT_ID).map((m) => m.text)).toEqual([copy.noEntendi, copy.atajosTexto]);
    expect(await count("event_log", "type='agent.escalate'")).toBe(1);
    expect(JSON.stringify((await db.prepare("SELECT data FROM event_log WHERE type='agent.escalate'").first())!)).not.toContain(SECRET_TEXT);
  });

  it("tope de 1 aviso cada 30 min: una segunda escalacion seguida no vuelve a avisar", async () => {
    const out = await runUpdates([5011, 5012, 5013, 5014]);
    expect(await count("event_log", "type='agent.escalate'")).toBe(2);
    expect(out.filter((m) => m.chat === ADMIN)).toHaveLength(1);
  });

  it("sin chat admin configurado la escalacion igual queda en event_log y la usuaria recibe los atajos", async () => {
    const sent: Sent[] = [];
    const testEnv = makeEnv(sent); // solo owner
    setRuntimeOverride((e) => ({ chat: confusedChat(), stt: new FakeSttProvider([{ text: "x", lowConfidence: false }]), store: new D1ConversationStore(e.DB), host: d1ToolHost(e) }));
    const botApi = createStubBotApi();
    const restore = botApi.install();
    try {
      for (const id of [5021, 5022]) await worker.fetch(post(textUpdate(id)), testEnv);
      await handleBatch({ queue: "q-updates", messages: sent.map((body) => ({ body, attempts: 1, ack: () => {}, retry: () => {} }) as QueueMessageLike) }, testEnv);
      const to = botApi.calls.filter((c) => c.method === "sendMessage").map((c) => c.payload.chat_id);
      expect(to.every((c) => c === CHAT_ID)).toBe(true);
      expect(await count("event_log", "type='agent.escalate'")).toBe(1);
    } finally {
      restore();
    }
  });
  it("album.flush: si el agente escala tambien avisa al admin (sin texto, con el mismo tope de 30 min)", async () => {
    setAgentEntry(albumEntry);
    const testEnv = { ...makeEnv([]), ALLOWED_CHAT_IDS: `${CHAT_ID}:owner,${ADMIN}:admin` } as Env;
    setRuntimeOverride((e) => ({ chat: confusedChat(), stt: new FakeSttProvider([{ text: "x", lowConfidence: false }]), store: new D1ConversationStore(e.DB), host: d1ToolHost(e) }));
    const botApi = createStubBotApi();
    const restore = botApi.install();
    try {
      for (const gid of ["ga-1", "ga-2", "ga-3", "ga-4"]) {
        await db.prepare("INSERT INTO inbox_groups (media_group_id, chat_id, item_count, first_at, last_at, status) VALUES (?, ?, 1, 1, 1, 'open')").bind(gid, CHAT_ID).run();
        expect(await handleAlbumFlush({ gid }, testEnv, Date.now() + 60_000)).toBe("delivered");
      }
      const out = botApi.calls.filter((c) => c.method === "sendMessage").map((c) => ({ chat: c.payload.chat_id as number, text: String(c.payload.text) }));
      expect(await count("event_log", "type='agent.escalate'")).toBe(2); // 2 malentendidos por escalacion: turnos 2 y 4
      const toAdmin = out.filter((m) => m.chat === ADMIN);
      expect(toAdmin).toHaveLength(1); // tope: la segunda escalacion no repite
      expect(toAdmin[0]!.text).not.toMatch(/media_ids|foto/);
    } finally {
      restore();
      setAgentEntry(albumEntry);
    }
  });
});
