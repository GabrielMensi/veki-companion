// Arnes de los escenarios de conversacion (T23). Cada accion de la usuaria entra por el Worker real
// (`worker.fetch` con secret valido), pasa por la cola con el consumidor real (`handleBatch`) y por los handlers
// reales (dispatch, media, album.flush, callbacks, ejecutores). Fakes: chat y voz (scripts), Bot API (stub) y colas.
// D1 y R2 son los del pool de Workers. Todo inventado; sin red.

import { env } from "cloudflare:test";
import { FakeChatProvider, FakeSttProvider, type ChatRequest, type ChatResult } from "@veki/core";
import { D1ConversationStore } from "../../src/actions/conversation-store";
import { d1ToolHost } from "../../src/actions/pending";
import type { Env } from "../../src/env";
import worker from "../../src/index";
import { handleAlbumFlush, setAgentEntry } from "../../src/jobs/album-flush";
import { handleBatch, type QueueMessageLike } from "../../src/queues";
import { albumEntry, setRuntimeOverride } from "../../src/runtime";
import { catalogRead } from "../../src/tools/catalog";
import { createStubBotApi, type BotApiCall } from "../sim/stub-bot-api";
import type { SeedProduct } from "./spec";

export const OWNER = 1001;
export const ADMIN = 9001;
export const STRANGER = 7777;
const SECRET = "scenario-secret-123";

export const db = (env as unknown as { DB: Env["DB"] & { batch: (s: unknown[]) => Promise<unknown> } }).DB;
const r2 = (env as unknown as { MEDIA: R2Bucket }).MEDIA;

// ── Script del "modelo": ayudas para armar llamadas a herramientas ───────────
const usage = { tokensIn: 1, tokensOut: 1 };
export const tool = (name: string, args: Record<string, unknown> = {}, id = "c1"): ChatResult => ({ text: null, toolCalls: [{ id, name, arguments: args }], usage });
export const responder = (texto: string, botones?: { etiqueta: string; valor: string }[]): ChatResult =>
  tool("responder", { texto, ...(botones ? { botones } : {}) });

/** Contenido JSON del ultimo resultado de herramienta que ve el modelo en esta llamada. */
export const lastToolJson = (req: ChatRequest): any => {
  const m = [...req.messages].reverse().find((x) => x.role === "tool");
  if (!m || m.role !== "tool") throw new Error("no hay resultado de herramienta en la llamada");
  return JSON.parse(m.content);
};
/** ids de fotos que trae el evento del album (`media_ids: a, b, c`). */
export const mediaIdsOf = (req: ChatRequest): string[] => {
  const u = [...req.messages].reverse().find((x) => x.role === "user");
  const m = /media_ids: (.*)$/.exec(u && u.role === "user" ? u.content : "");
  if (!m) throw new Error("la llamada no trae media_ids");
  return m[1]!.split(", ");
};

// ── Estado de la base ────────────────────────────────────────────────────────
const TABLES = ["updates", "event_log", "media", "inbox_groups", "conversations", "pending_actions", "fairs", "variants", "products", "site_state"];
export async function resetDb() {
  for (const t of TABLES) await db.prepare(`DELETE FROM ${t}`).run();
  await db.prepare("DELETE FROM settings WHERE key LIKE 'alert_last:%'").run();
}

export async function seedCatalog(products: SeedProduct[]) {
  const now = Date.now() - 86_400_000;
  for (const p of products) {
    await db
      .prepare("INSERT INTO products (id, slug, name, category, description, price_ars, status, featured, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, 'active', 0, ?, ?)")
      .bind(p.id, p.slug, p.name, p.category, p.price_ars, now, now)
      .run();
    for (const v of p.variants) {
      await db
        .prepare("INSERT INTO variants (id, product_id, design, size, color, price_ars, stock, status, updated_at) VALUES (?, ?, ?, ?, ?, NULL, ?, 'active', ?)")
        .bind(v.id, p.id, v.design, v.size, v.color, v.stock, now)
        .run();
    }
  }
}

export async function count(table: string, where = "1=1") {
  return (await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).first<{ n: number }>())!.n;
}
export const row = <T = Record<string, unknown>>(sql: string, ...binds: unknown[]) => db.prepare(sql).bind(...binds).first<T>();
export const rows = async <T = Record<string, unknown>>(sql: string, ...binds: unknown[]) => (await db.prepare(sql).bind(...binds).all<T>()).results;

// ── Mundo ────────────────────────────────────────────────────────────────────
export type Sent = { chat: number; text: string; buttons: { text: string; callback_data: string }[] };
type Queued = { type: string; update_id: number; update: unknown };

export type WorldOpts = {
  chat: FakeChatProvider;
  stt?: FakeSttProvider;
  /** `ALLOWED_CHAT_IDS`; por defecto la usuaria (owner) y Gabriel (admin). */
  allow?: string;
};

export function startWorld(opts: WorldOpts) {
  const queued: Queued[] = [];
  const jobs: { type?: string; gid?: string }[] = [];
  const testEnv: Env = {
    DB: db,
    MEDIA: r2,
    Q_UPDATES: { send: async (m) => void queued.push(m as Queued) },
    Q_JOBS: { send: async (m) => void jobs.push(m as { type?: string; gid?: string }) },
    TELEGRAM_BOT_TOKEN: "scenario-token",
    TG_WEBHOOK_SECRET: SECRET,
    ALLOWED_CHAT_IDS: opts.allow ?? `${OWNER}:owner,${ADMIN}:admin`,
  };
  const stt = opts.stt ?? new FakeSttProvider([{ text: "texto de prueba", lowConfidence: false }]);
  setRuntimeOverride((e) => ({ chat: opts.chat, stt, store: new D1ConversationStore(e.DB), host: d1ToolHost(e, catalogRead(e.DB)) }));
  setAgentEntry(albumEntry);
  const botApi = createStubBotApi();
  const restore = botApi.install();

  let nextUpdate = 1;
  let nextMessage = 100;
  let nextPhoto = 1;
  const retried: { delay?: number }[] = [];
  let acked = 0;

  const user = (id: number) => ({ id, is_bot: false, first_name: "Prueba" });
  const msg = (chatId: number, extra: Record<string, unknown>) => ({
    update_id: nextUpdate++,
    message: { message_id: nextMessage++, date: 0, chat: { id: chatId, type: "private" }, from: user(chatId), ...extra },
  });
  const photoMsg = (chatId: number, group?: string) => {
    const n = nextPhoto++;
    return msg(chatId, {
      ...(group ? { media_group_id: group } : {}),
      photo: [
        { file_id: `sc-ph-${n}-s`, file_unique_id: `sc-uph-${n}-s`, width: 90, height: 90, file_size: 800 },
        { file_id: `sc-ph-${n}-l`, file_unique_id: `sc-uph-${n}-l`, width: 1280, height: 960, file_size: 2400 },
      ],
    });
  };

  const post = (body: unknown) =>
    worker.fetch(
      new Request("https://bot.test/tg/webhook", {
        method: "POST",
        headers: { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": SECRET },
        body: JSON.stringify(body),
      }),
      testEnv,
    );

  /** Consumidor de la cola de updates + `album.flush` pendientes (con la hora adelantada, pasado el debounce). */
  async function drain(attempts = 1) {
    const batch = queued.splice(0);
    const messages: QueueMessageLike[] = batch.map((body) => ({
      body,
      attempts,
      ack: () => void acked++,
      retry: (o) => void retried.push({ delay: o?.delaySeconds }),
    }));
    await handleBatch({ queue: "q-updates", messages }, testEnv);
    for (const j of jobs.splice(0).filter((x) => x.type === "album.flush")) await handleAlbumFlush({ gid: j.gid }, testEnv, Date.now() + 60_000);
    return { messages: batch };
  }

  /** Vuelve a entregar mensajes de la cola (reintento tras `retry`), con el numero de intento dado. */
  async function redeliver(bodies: Queued[], attempts: number) {
    const messages: QueueMessageLike[] = bodies.map((body) => ({
      body,
      attempts,
      ack: () => void acked++,
      retry: (o) => void retried.push({ delay: o?.delaySeconds }),
    }));
    await handleBatch({ queue: "q-updates", messages }, testEnv);
  }

  const sentMessages = (): Sent[] =>
    botApi.calls
      .filter((c: BotApiCall) => c.method === "sendMessage")
      .map((c) => ({
        chat: c.payload.chat_id as number,
        text: String(c.payload.text),
        buttons: ((c.payload.reply_markup as { inline_keyboard?: { text: string; callback_data: string }[][] } | undefined)?.inline_keyboard ?? []).flat(),
      }));

  const w = {
    chat: opts.chat,
    stt,
    botApi,
    env: testEnv,
    stop() {
      restore();
      setRuntimeOverride(null);
      setAgentEntry(albumEntry);
    },
    /** Mensajes que salieron para un chat (por defecto, la usuaria). */
    sent: (chat = OWNER) => sentMessages().filter((m) => m.chat === chat),
    last: (chat = OWNER) => w.sent(chat).at(-1)!,
    retried,
    get acked() {
      return acked;
    },
    calls: (method: string) => botApi.calls.filter((c) => c.method === method),

    /** Un update crudo por el webhook (sin consumir la cola). */
    post,
    msg,

    async text(t: string, chatId = OWNER) {
      const status = (await post(msg(chatId, { text: t }))).status;
      await drain();
      return status;
    },
    async voice(chatId = OWNER) {
      await post(msg(chatId, { voice: { file_id: "sc-voice", file_unique_id: "sc-uvoice", duration: 4, mime_type: "audio/ogg", file_size: 9000 } }));
      await drain();
    },
    /** `n` fotos: una sola (suelta) o un album en desorden con un reenvio repetido. */
    async photos(n: number, chatId = OWNER) {
      if (n === 1) {
        await post(photoMsg(chatId));
      } else {
        const group = `sc-album-${nextPhoto}`;
        const updates = Array.from({ length: n }, () => photoMsg(chatId, group));
        for (const u of updates.reverse()) await post(u);
        await post(updates[0]!); // mismo update_id reenviado por Telegram
      }
      await drain();
    },
    /** Toca un boton por su etiqueta en el ultimo mensaje que tiene botones. Devuelve el `callback_data`. */
    async tap(label: string, chatId = OWNER) {
      const withButtons = [...w.sent(chatId)].reverse().find((m) => m.buttons.some((b) => b.text === label));
      if (!withButtons) throw new Error(`no hay un boton "${label}" para tocar`);
      const data = withButtons.buttons.find((b) => b.text === label)!.callback_data;
      await w.tapData(data, chatId);
      return data;
    },
    /** Toca un boton por su `callback_data`. `concurrent`: n toques llegan a la vez. */
    async tapData(data: string, chatId = OWNER, times = 1, concurrent = false) {
      const ups = Array.from({ length: times }, () => ({
        update_id: nextUpdate++,
        callback_query: { id: `sc-cb-${nextUpdate}`, from: user(chatId), message: { message_id: 1, date: 0, chat: { id: chatId, type: "private" }, text: "vista previa" }, chat_instance: "sc", data },
      }));
      for (const u of ups) await post(u);
      if (concurrent) {
        const batch = queued.splice(0);
        await Promise.all(
          batch.map((body) =>
            handleBatch({ queue: "q-updates", messages: [{ body, attempts: 1, ack: () => void acked++, retry: () => {} }] }, testEnv),
          ),
        );
      } else await drain();
    },
    drain,
    redeliver,
  };
  return w;
}
export type World = ReturnType<typeof startWorld>;

/** Cantidad de `?` de un texto. */
export const questions = (t: string) => (t.match(/\?/g) ?? []).length;
