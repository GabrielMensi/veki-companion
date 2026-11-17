import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { FakeChatProvider, FakeSttProvider, copy, copyAcciones, emptyState, type AgentOutput } from "@veki/core";
import { D1ConversationStore } from "../src/actions/conversation-store";
import { d1ToolHost } from "../src/actions/pending";
import type { Env } from "../src/env";
import { classifyUpdate, handleUpdateMessage, type DispatchDeps } from "../src/handlers/dispatch";
import type { DbBatch, MediaDeps } from "../src/handlers/media";
import { handleAlbumFlush } from "../src/jobs/album-flush";
import { handleBatch, type QueueMessageLike } from "../src/queues";
import { setRuntimeOverride } from "../src/runtime";

// Todo inventado: ids, token y bytes. Sin red: Telegram, R2 y los proveedores son fakes.
const e = env as unknown as { DB: DbBatch; MEDIA: R2Bucket };
const CHAT = 4242;
const REPLY = "Dale, lo vi";
const TABLES = ["updates", "event_log", "media", "inbox_groups", "conversations", "pending_actions", "fairs"];
const count = async (t: string, where = "1=1") => (await e.DB.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE ${where}`).first<{ n: number }>())!.n;

const chatReply = (texto: string) => ({ text: null, toolCalls: [{ id: "c1", name: "responder", arguments: { texto } }], usage: { tokensIn: 1, tokensOut: 1 } });

function setup(opts: { chat?: FakeChatProvider } = {}) {
  const sent: { chatId: number; out: AgentOutput }[] = [];
  const jobs: unknown[] = [];
  const chat = opts.chat ?? new FakeChatProvider([() => chatReply(REPLY)]);
  const stt = new FakeSttProvider([{ text: "quiero cargar una riñonera", lowConfidence: false }]);
  setRuntimeOverride((en) => ({ chat, stt, store: new D1ConversationStore(en.DB), host: d1ToolHost(en) }));
  const downloads: string[] = [];
  const fakeFetch = (async (input: RequestInfo | URL) => {
    const u = String(input);
    if (u.includes("/getFile")) return new Response(JSON.stringify({ ok: true, result: { file_path: "f/x.bin" } }));
    return new Response(new Uint8Array([1, 2, 3]));
  }) as typeof fetch;
  const media: MediaDeps = {
    db: e.DB, r2: e.MEDIA as unknown as MediaDeps["r2"], jobs: { send: async (m) => void jobs.push(m) }, token: "t", fetch: fakeFetch,
    send: async (chatId, texto) => void sent.push({ chatId, out: { texto } }),
  };
  const deps: DispatchDeps = {
    send: async (chatId, out) => void sent.push({ chatId, out }),
    download: async (id) => (downloads.push(id), { bytes: new Uint8Array([1, 2]).buffer, mime: "audio/ogg" }),
    media,
    callback: { tg: { answerCallback: async () => {}, send: async (chatId, text) => void sent.push({ chatId, out: { texto: text } }), clearButtons: async () => {} }, store: new D1ConversationStore(e.DB) },
  };
  const testEnv = { DB: e.DB, MEDIA: e.MEDIA, Q_UPDATES: { send: async () => {} }, Q_JOBS: { send: async (m: unknown) => void jobs.push(m) }, TELEGRAM_BOT_TOKEN: "t", TG_WEBHOOK_SECRET: "s", ALLOWED_CHAT_IDS: `${CHAT}:owner` } as unknown as Env;
  return { sent, jobs, chat, stt, downloads, deps, env: testEnv };
}

const msg = (extra: Record<string, unknown>) => ({ message: { message_id: 1, date: 0, chat: { id: CHAT, type: "private" }, from: { id: CHAT }, ...extra } });
const photo = (id: string, extra: Record<string, unknown> = {}) =>
  msg({ photo: [{ file_id: `${id}-s`, file_unique_id: `${id}-us`, width: 90, height: 90 }, { file_id: `${id}-b`, file_unique_id: `${id}-ub`, width: 800, height: 800, file_size: 3 }], ...extra });

beforeEach(async () => {
  for (const t of TABLES) await e.DB.prepare(`DELETE FROM ${t}`).run();
  setRuntimeOverride(null);
});

describe("classifyUpdate", () => {
  it.each([
    ["callback", { callback_query: { id: "1", data: "pa:x:yes" } }],
    ["text", msg({ text: "hola" })],
    ["voice", msg({ voice: { file_id: "v", file_unique_id: "u", duration: 1 } })],
    ["media", photo("p1")],
    ["media", msg({ video: { file_id: "v", file_unique_id: "u", duration: 1 } })],
    ["media", msg({ video_note: { file_id: "v", file_unique_id: "u", length: 240 } })],
    ["media", msg({ animation: { file_id: "v", file_unique_id: "u" } })],
    ["media", msg({ document: { file_id: "d", file_unique_id: "u", mime_type: "video/mp4" } })],
    ["unsupported", msg({ document: { file_id: "d", file_unique_id: "u", mime_type: "application/pdf" } })],
    ["unsupported", msg({ sticker: { file_id: "s" } })],
    ["unsupported", msg({ location: { latitude: 1, longitude: 2 } })],
    ["ignored", { edited_message: { text: "x" } }],
    ["ignored", {}],
  ])("%s", (kind, update) => expect(classifyUpdate(update as never)).toBe(kind));
});

describe("handleUpdateMessage: cada tipo llega a su handler", () => {
  it("texto -> agente -> respuesta", async () => {
    const s = setup();
    await handleUpdateMessage({ update_id: 1, update: msg({ text: "  hola  " }) }, s.env, s.deps);
    expect(s.chat.requests).toHaveLength(1);
    expect(s.chat.requests[0]!.messages[0]).toEqual({ role: "user", content: "hola" });
    expect(s.sent).toEqual([{ chatId: CHAT, out: expect.objectContaining({ texto: REPLY }) }]);
  });

  it("voz -> descarga + STT -> agente", async () => {
    const s = setup();
    await handleUpdateMessage({ update_id: 2, update: msg({ voice: { file_id: "vv", mime_type: "audio/ogg" } }) }, s.env, s.deps);
    expect(s.downloads).toEqual(["vv"]);
    expect(s.stt.calls).toHaveLength(1);
    expect(s.chat.requests[0]!.messages[0]).toMatchObject({ role: "user", content: "quiero cargar una riñonera" });
    expect(s.sent.map((x) => x.out.texto)).toEqual([REPLY]);
  });

  it("callback_query -> handler de acciones pendientes", async () => {
    const s = setup();
    const now = Date.now();
    await e.DB.prepare("INSERT INTO pending_actions (id, chat_id, tool, args, preview, status, created_at, expires_at) VALUES ('pa1', ?, 'crear_feria', ?, 'v', 'pending', ?, ?)")
      .bind(CHAT, JSON.stringify({ nombre: "Feria Sol", lugar: "Plaza", inicio: "2027-01-10T10:00", fin: "2027-01-10T18:00" }), now, now + 3_600_000).run();
    await handleUpdateMessage({ update_id: 3, update: { callback_query: { id: "cb", data: "pa:pa1:yes", message: { message_id: 9, chat: { id: CHAT } } } } }, s.env, s.deps);
    expect(s.sent.map((x) => x.out.texto)).toEqual([copyAcciones.feriaCreada("Feria Sol")]);
    expect(s.chat.requests).toHaveLength(0);
  });

  it.each([
    ["photo", photo("ph")],
    ["video", msg({ video: { file_id: "vid", file_unique_id: "vid-u", duration: 3, file_size: 3 } })],
    ["document video", msg({ document: { file_id: "doc", file_unique_id: "doc-u", mime_type: "video/mp4", file_size: 3 } })],
    ["video_note", msg({ video_note: { file_id: "vn", file_unique_id: "vn-u", length: 240, file_size: 3 } })],
    ["animation", msg({ animation: { file_id: "an", file_unique_id: "an-u", file_size: 3 } })],
  ])("%s suelto -> media -> agente con su id", async (_n, update) => {
    const s = setup();
    await handleUpdateMessage({ update_id: 4, update }, s.env, s.deps);
    const row = await e.DB.prepare("SELECT id, status FROM media").first<{ id: string; status: string }>();
    expect(row?.status).toBe("inbox");
    expect(s.chat.requests[0]!.messages[0]!.content).toContain(row!.id);
    expect(s.sent.map((x) => x.out.texto)).toEqual([REPLY]);
    expect(s.jobs).toEqual([]); // sin album no hay flush
  });

  it("pieza de album -> media + album.flush, sin turno propio del agente", async () => {
    const s = setup();
    await handleUpdateMessage({ update_id: 5, update: photo("al", { media_group_id: "g1" }) }, s.env, s.deps);
    expect(await count("media")).toBe(1);
    expect(s.jobs).toEqual([{ type: "album.flush", gid: "g1" }]);
    expect(s.chat.requests).toHaveLength(0);
    expect(s.sent).toEqual([]);
  });

  it("el album.flush llega al agente por la entrada registrada (sin setAgentEntry manual)", async () => {
    const s = setup();
    for (const [i, id] of ["a1", "a2"].entries()) {
      await handleUpdateMessage({ update_id: 10 + i, update: photo(id, { media_group_id: "g2" }) }, s.env, s.deps);
    }
    const ids = (await e.DB.prepare("SELECT id FROM media").all<{ id: string }>()).results.map((r) => r.id);
    expect(await handleAlbumFlush({ gid: "g2" }, s.env, Date.now() + 60_000)).toBe("delivered");
    expect(await count("event_log", "type='album.undelivered'")).toBe(0);
    expect(s.chat.requests).toHaveLength(1);
    for (const id of ids) expect(s.chat.requests[0]!.messages[0]!.content).toContain(id);
  });
});

describe("handleUpdateMessage: nada inesperado rompe", () => {
  it.each([
    ["sticker", msg({ sticker: { file_id: "s" } })],
    ["pdf", msg({ document: { file_id: "d", file_unique_id: "u", mime_type: "application/pdf" } })],
    ["ubicacion", msg({ location: { latitude: 1, longitude: 2 } })],
  ])("%s -> texto amable y registro sin contenido", async (_n, update) => {
    const s = setup();
    await handleUpdateMessage({ update_id: 20, update }, s.env, s.deps);
    expect(s.sent.map((x) => x.out.texto)).toEqual([copy.tipoNoSoportado]);
    expect(s.chat.requests).toHaveLength(0);
    const log = await e.DB.prepare("SELECT data FROM event_log WHERE type='update.unsupported'").first<{ data: string }>();
    expect(log?.data).not.toContain("latitude\":1");
  });

  it.each([["editado", { edited_message: { text: "x" } }], ["vacio", {}], ["null", null], ["texto", "hola"]])("%s -> se ignora y queda en el registro", async (_n, update) => {
    const s = setup();
    await handleUpdateMessage({ update_id: 21, update }, s.env, s.deps);
    expect(s.sent).toEqual([]);
    expect(await count("event_log", "type='update.ignored'")).toBe(1);
  });

  it("falla del LLM -> 'algo salio mal', registrado y sin lanzar", async () => {
    const s = setup({ chat: new FakeChatProvider([new Error("boom")]) });
    await handleUpdateMessage({ update_id: 22, update: msg({ text: "hola" }) }, s.env, s.deps);
    expect(s.sent.map((x) => x.out.texto)).toEqual([copy.algoSalioMal]);
    const log = await e.DB.prepare("SELECT data FROM event_log WHERE type='update.error'").first<{ data: string }>();
    expect(JSON.parse(log!.data)).toEqual({ kind: "text", update_id: 22, error: "Error" });
  });

  it("la falla de Telegram al responder no tira el update", async () => {
    const s = setup();
    s.deps.send = async () => { throw new Error("tg down"); };
    await expect(handleUpdateMessage({ update_id: 23, update: msg({ text: "hola" }) }, s.env, s.deps)).resolves.toBeUndefined();
    expect(await count("event_log", "type='telegram.send_failed'")).toBe(1);
  });

  it("un choque de version de la conversacion se propaga para que la cola reintente", async () => {
    const s = setup();
    setRuntimeOverride((en) => ({
      chat: new FakeChatProvider([() => chatReply("x")]), stt: s.stt, host: d1ToolHost(en),
      store: { load: async () => ({ state: emptyState(), history: [], version: 0 }), save: async () => { throw new Error("conversation version conflict (chat 1)"); } } as never,
    }));
    await expect(handleUpdateMessage({ update_id: 24, update: msg({ text: "hola" }) }, s.env, s.deps)).rejects.toThrow(/version conflict/);
  });
});

describe("router de la cola", () => {
  it("marca el update como done tras procesarlo (texto y tipo desconocido)", async () => {
    const s = setup();
    for (const [id, update] of [[30, msg({ text: "hola" })], [31, msg({ sticker: { file_id: "s" } })]] as const) {
      await e.DB.prepare("INSERT INTO updates (update_id, chat_id, kind, status, received_at) VALUES (?, ?, 'message', 'queued', 1)").bind(id, CHAT).run();
      const acked: number[] = [];
      const m: QueueMessageLike = { body: { type: "update", update_id: id, update }, attempts: 1, ack: () => void acked.push(id), retry: () => {} };
      // Sin `deps` el dispatcher usa Telegram real: se stubea fetch para que no salga a la red.
      const real = globalThis.fetch;
      globalThis.fetch = (async () => Response.json({ ok: true, result: { message_id: 1 } })) as typeof fetch;
      try {
        await handleBatch({ queue: "q-updates", messages: [m] }, s.env);
      } finally {
        globalThis.fetch = real;
      }
      expect(acked).toEqual([id]);
    }
    expect(await count("updates", "status='done'")).toBe(2);
  });
});
