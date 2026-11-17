import { ulid } from "@veki/core";
import type { Env } from "./env";

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
  update: stub,
  "vision.rank": stub,
  "content.generate": stub,
  "content.deliver": stub,
  "album.flush": stub,
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
    } catch {
      if (m.attempts >= MAX_ATTEMPTS) {
        if (body!.type === "update" && typeof body!.update_id === "number") {
          await env.DB.prepare("UPDATE updates SET status='failed', processed_at=? WHERE update_id=?").bind(Date.now(), body!.update_id).run();
        }
        await logEvent(env, "error", "error", { queue: batch.queue, type: body!.type, attempts: m.attempts });
        m.ack();
      } else {
        m.retry({ delaySeconds: Math.min(30 * m.attempts, 300) });
      }
    }
  }
}
