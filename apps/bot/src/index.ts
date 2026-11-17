import type { Env } from "./env";
import { handleBatch, type MessageBatchLike } from "./queues";
import { handleWebhook } from "./webhook";

export const APP_NAME = "@veki/bot";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/tg/webhook") {
      if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
      return handleWebhook(request, env);
    }
    return new Response("not found", { status: 404 });
  },
  async queue(batch: MessageBatchLike, env: Env): Promise<void> {
    await handleBatch(batch, env);
  },
};
