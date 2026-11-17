import { copyPresupuesto, isProviderError, ulid } from "@veki/core";
import type { Env } from "./env";
import { handleUpdateMessage } from "./handlers/dispatch";
import { sendTelegram } from "./handlers/media";
import { handleAlbumFlush } from "./jobs/album-flush";
import { retryDelayS } from "./provider-ports";

/** Mensajes de q-updates y q-jobs. `type` decide el handler. */
export type UpdateMessage = { type: "update"; update_id: number; update: unknown };
export type JobMessage =
  | { type: "vision.rank"; [k: string]: unknown }
  | { type: "content.generate"; [k: string]: unknown }
  | { type: "content.deliver"; [k: string]: unknown }
  | { type: "album.flush"; [k: string]: unknown };
export type QueueMessage = UpdateMessage | JobMessage;

export type Handler = (msg: any, env: Env) => Promise<void>;

// Stubs: T16 (agente), T17 (fotos/albumes) y T18 (acciones pendientes) completan estos handlers.
const stub: Handler = async () => {};

export const handlers: Record<string, Handler> = {
  update: handleUpdateMessage,
  "vision.rank": stub,
  "content.generate": stub,
  "content.deliver": stub,
  "album.flush": async (msg, env) => void (await handleAlbumFlush(msg, env)),
};

export interface QueueMessageLike {
  body: unknown;
  attempts: number;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}
export interface MessageBatchLike {
  queue: string;
  messages: readonly QueueMessageLike[];
}

export const MAX_ATTEMPTS = 5;

export async function logEvent(env: Env, type: string, severity: "info" | "warn" | "error", data: unknown, actor = "bot") {
  await env.DB.prepare("INSERT INTO event_log (id, ts, actor, type, severity, data) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(ulid(), Date.now(), actor, type, severity, JSON.stringify(data))
    .run();
}

/** Chat al que avisar: el del update/callback; en jobs, `chat_id` si lo trae, o el del grupo del álbum (`inbox_groups`). */
async function resolveChatId(body: unknown, env: Env): Promise<number | null> {
  const b = body as {
    update?: { message?: { chat?: { id?: number } }; callback_query?: { message?: { chat?: { id?: number } } } };
    chat_id?: unknown;
    gid?: unknown;
  } | null;
  const fromUpdate = b?.update?.message?.chat?.id ?? b?.update?.callback_query?.message?.chat?.id;
  if (typeof fromUpdate === "number") return fromUpdate;
  if (typeof b?.chat_id === "number") return b.chat_id;
  if (typeof b?.gid === "string") {
    const g = await env.DB.prepare("SELECT chat_id FROM inbox_groups WHERE media_group_id = ?").bind(b.gid).first<{ chat_id: number }>();
    if (typeof g?.chat_id === "number") return g.chat_id;
  }
  return null;
}

async function notifyBusy(body: unknown, env: Env): Promise<void> {
  try {
    const chatId = await resolveChatId(body, env);
    if (chatId === null) return;
    await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, copyPresupuesto.teAvisoEnUnRatito);
  } catch {
    /* el aviso es de cortesía: nunca rompe el reintento */
  }
}

/** Consumidor: enruta cada mensaje por `type`; reintenta con espera, sin dormir dentro del consumidor. */
export async function handleBatch(batch: MessageBatchLike, env: Env, router: Record<string, Handler> = handlers): Promise<void> {
  for (const m of batch.messages) {
    const body = m.body as { type?: string; update_id?: number } | null;
    const handler = body && typeof body.type === "string" ? router[body.type] : undefined;
    if (!handler) {
      await logEvent(env, "queue.unknown_type", "error", { queue: batch.queue, type: body?.type ?? null });
      m.ack();
      continue;
    }
    try {
      await handler(body, env);
      if (body!.type === "update" && typeof body!.update_id === "number") {
        await env.DB.prepare("UPDATE updates SET status='done', processed_at=? WHERE update_id=?").bind(Date.now(), body!.update_id).run();
      }
      m.ack();
    } catch (err) {
      if (m.attempts >= MAX_ATTEMPTS) {
        if (body!.type === "update" && typeof body!.update_id === "number") {
          await env.DB.prepare("UPDATE updates SET status='failed', processed_at=? WHERE update_id=?").bind(Date.now(), body!.update_id).run();
        }
        await logEvent(env, "error", "error", { queue: batch.queue, type: body!.type, attempts: m.attempts });
        m.ack();
      } else {
        // R3: todos los modelos limitados (429 / cooldown) -> reintento con el `retry-after`; ella solo ve el aviso amable, una vez
        // por mensaje (`attempts === 1`), sea update o job.
        if (isProviderError(err) && err.retryAfterS !== undefined && m.attempts === 1) await notifyBusy(body, env);
        m.retry({ delaySeconds: retryDelayS(err, m.attempts) });
      }
    }
  }
}
