import { handleCron } from "./cron";
import type { Env } from "./env";
import { handlePublic, type PublicEnv } from "./public";
import { handleBatch, type MessageBatchLike } from "./queues";
import { handleWebhook } from "./webhook";

/** Forma mínima del evento `scheduled` de Workers (sin depender de @cloudflare/workers-types). */
export interface ScheduledControllerLike {
  cron: string;
  scheduledTime?: number;
}
export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/tg/webhook") {
      if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
      return handleWebhook(request, env);
    }
    if (url.pathname.startsWith("/public/")) {
      const res = await handlePublic(request, env as unknown as PublicEnv);
      if (res) return res;
    }
    return new Response("not found", { status: 404 });
  },
  async scheduled(controller: ScheduledControllerLike, env: Env, ctx: ExecutionContextLike): Promise<void> {
    ctx.waitUntil(handleCron(controller.cron, env, controller.scheduledTime ?? Date.now()));
  },
  async queue(batch: MessageBatchLike, env: Env): Promise<void> {
    await handleBatch(batch, env);
  },
};
