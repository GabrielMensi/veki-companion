import type { Env } from "./env";
import { parseAllowlist } from "./env";
import { logEvent } from "./queues";

const enc = new TextEncoder();

/** Comparacion en tiempo constante (comparamos digests SHA-256 para igualar largos). */
async function safeEqual(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  const x = new Uint8Array(da);
  const y = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

interface TgUpdate {
  update_id?: unknown;
  message?: { chat?: { id?: unknown } };
  callback_query?: { from?: { id?: unknown }; message?: { chat?: { id?: unknown } } };
}

function classify(u: TgUpdate): { kind: "message" | "callback_query"; chatId: number } | null {
  if (u.message) {
    const id = u.message.chat?.id;
    return typeof id === "number" ? { kind: "message", chatId: id } : null;
  }
  if (u.callback_query) {
    const id = u.callback_query.message?.chat?.id ?? u.callback_query.from?.id;
    return typeof id === "number" ? { kind: "callback_query", chatId: id } : null;
  }
  return null;
}

/** POST /tg/webhook. 401 solo si el secret es invalido; con secret valido siempre 200 (Telegram no reintenta). */
export async function handleWebhook(request: Request, env: Env): Promise<Response> {
  const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
  // Cierra por defecto: sin secret configurado o sin header, nadie pasa.
  if (!env.TG_WEBHOOK_SECRET || !secret || !(await safeEqual(secret, env.TG_WEBHOOK_SECRET))) {
    return new Response("unauthorized", { status: 401 });
  }

  let update: TgUpdate;
  try {
    update = (await request.json()) as TgUpdate;
  } catch {
    return new Response("ok");
  }
  if (!update || typeof update.update_id !== "number") return new Response("ok");

  const info = classify(update);
  if (!info) return new Response("ok"); // tipos que no atendemos (allowed_updates deberia filtrarlos)

  if (!parseAllowlist(env.ALLOWED_CHAT_IDS).has(info.chatId)) {
    await logEvent(env, "access.denied", "warn", { kind: info.kind }); // sin contenido ni identificadores
    return new Response("ok");
  }

  const ins = await env.DB.prepare("INSERT OR IGNORE INTO updates (update_id, chat_id, kind, status, received_at) VALUES (?, ?, ?, 'queued', ?)")
    .bind(update.update_id, info.chatId, info.kind, Date.now())
    .run();
  if (ins.meta.changes === 0) return new Response("ok"); // reintento de Telegram: ya lo tenemos

  try {
    await env.Q_UPDATES.send({ type: "update", update_id: update.update_id, update });
  } catch {
    // Que Telegram reintente: sin la fila, el reintento no se toma por duplicado.
    await env.DB.prepare("DELETE FROM updates WHERE update_id=?").bind(update.update_id).run();
    return new Response("retry", { status: 500 });
  }
  return new Response("ok");
}
