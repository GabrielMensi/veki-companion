import { CH_PREFIX, SC_PREFIX, atajoFrases, copy, copyAcciones, paUndoData, type Boton, type ConversationStore } from "@veki/core";
import { D1ConversationStore, updateState } from "../actions/conversation-store";
import { executeAction, type ExecuteDeps } from "../actions/execute";
import { cancelAction, eventStmt, expireAction, getAction, type LogActor } from "../actions/pending";
import { undoAction } from "../actions/undo";
import type { Env } from "../env";
import { parseAllowlist } from "../env";

/** Lo mínimo de Telegram que usa este handler (inyectable en tests). */
export interface TelegramApi {
  answerCallback(callbackId: string): Promise<void>;
  send(chatId: number, text: string, buttons?: Boton[]): Promise<void>;
  /** Quita los botones del mensaje tocado. */
  clearButtons(chatId: number, messageId: number): Promise<void>;
}

export function telegramApi(botToken: string, fetchFn: typeof fetch = fetch): TelegramApi {
  const call = async (method: string, body: unknown) => {
    const res = await fetchFn(`https://api.telegram.org/bot${botToken}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`telegram ${method} failed (${res.status})`);
  };
  return {
    answerCallback: (id) => call("answerCallbackQuery", { callback_query_id: id }),
    send: (chatId, text, buttons) =>
      call("sendMessage", {
        chat_id: chatId,
        text,
        ...(buttons?.length ? { reply_markup: { inline_keyboard: [buttons.map((b) => ({ text: b.etiqueta, callback_data: b.valor }))] } } : {}),
      }),
    clearButtons: (chatId, messageId) =>
      call("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }),
  };
}

export type CallbackQuery = {
  id: string;
  data?: string;
  from?: { id?: number };
  message?: { message_id?: number; chat?: { id?: number } };
};

export type CallbackDeps = {
  tg: TelegramApi;
  store: ConversationStore;
  now?: number;
  executors?: ExecuteDeps["executors"];
};

export type PaAction = "yes" | "edit" | "no" | "undo";
const DATA = /^pa:([A-Za-z0-9_-]{1,64}):(yes|edit|no|undo)$/;

/** `pa:<id>:yes|edit|no|undo` → partes, o `null` si no es un botón de acciones pendientes. */
export function parseCallbackData(data: string | undefined): { id: string; action: PaAction } | null {
  const m = data ? DATA.exec(data) : null;
  return m ? { id: m[1]!, action: m[2] as PaAction } : null;
}

/**
 * Botones que no son acciones pendientes → texto que entra al agente como si ella lo hubiera escrito, o `null`.
 * `sc:<clave>` (atajo) → frase fija; `ch:<texto>` (elección del agente) → el texto del botón. Ver `copy/es-AR.ts`.
 */
export function agentInputFromCallback(data: string | undefined): string | null {
  if (!data) return null;
  if (data.startsWith(SC_PREFIX)) return atajoFrases[data.slice(SC_PREFIX.length)] ?? null;
  if (data.startsWith(CH_PREFIX)) return data.slice(CH_PREFIX.length).trim() || null;
  return null;
}

export function defaultCallbackDeps(env: Env): CallbackDeps {
  const allow = parseAllowlist(env.ALLOWED_CHAT_IDS);
  return { tg: telegramApi(env.TELEGRAM_BOT_TOKEN), store: new D1ConversationStore(env.DB, (id) => allow.get(id) ?? "owner") };
}

/** Un botón de acción pendiente: Sí / Cambiar / Cancelar / Deshacer. Nunca lanza por fallas de Telegram. */
export async function handleCallback(env: Env, cq: CallbackQuery, deps: CallbackDeps = defaultCallbackDeps(env)): Promise<void> {
  const { tg } = deps;
  const now = deps.now ?? Date.now();
  const parsed = parseCallbackData(cq.data);
  const chatId = cq.message?.chat?.id ?? cq.from?.id;
  const messageId = cq.message?.message_id;
  const quiet = (p: Promise<unknown>) => p.catch(() => {}); // el aviso/limpieza de botones es "mejor esfuerzo"

  const clear0 = () => quiet(tg.clearButtons(chatId as number, messageId as number));
  await quiet(tg.answerCallback(cq.id)); // corta el relojito del botón
  if (!parsed && typeof chatId === "number" && typeof messageId === "number" && agentInputFromCallback(cq.data)) await clear0(); // atajo/elección: quita los botones (evita doble toque); el turno lo corre `dispatch`
  if (!parsed || typeof chatId !== "number") return;

  const actor: LogActor = parseAllowlist(env.ALLOWED_CHAT_IDS).get(chatId) === "admin" ? "admin" : "owner";
  const say = async (text: string, buttons?: Boton[]) => {
    try {
      await tg.send(chatId, text, buttons);
    } catch {
      // La acción ya quedó hecha; sin aviso no se reintenta (reejecutar no hace nada). Queda registro sin textos.
      await quiet(eventStmt(env.DB, { now, actor, type: "telegram.send_failed", entity: "pending_action", entityId: parsed.id }).run());
    }
  };
  const clear = () => (typeof messageId === "number" ? quiet(tg.clearButtons(chatId, messageId)) : Promise.resolve());

  switch (parsed.action) {
    case "yes": {
      const r = await executeAction(parsed.id, chatId, { db: env.DB, store: deps.store, executors: deps.executors, now, actor });
      if (r.kind === "noop") return; // doble toque o reintento: ya se atendió
      await clear();
      if (r.kind === "executed") {
        await say(r.message, r.action.tool === "deshacer" ? undefined : [{ etiqueta: copyAcciones.botonDeshacer, valor: paUndoData(parsed.id) }]);
      } else if (r.kind === "expired") await say(copy.vencido);
      else if (r.kind === "rejected") await say(r.message);
      else await say(copyAcciones.todaviaNo);
      return;
    }
    case "no": {
      if (await cancelAction(env.DB, parsed.id, chatId)) {
        await clear();
        await say(copyAcciones.cancelado);
      } else if (await expireAction(env.DB, parsed.id, now)) {
        await clear();
        await say(copy.vencido);
      }
      return;
    }
    case "edit": {
      const row = await getAction(env.DB, parsed.id);
      if (!row || row.chat_id !== chatId || row.status !== "pending") return;
      if (row.expires_at <= now) {
        if (await expireAction(env.DB, parsed.id, now)) {
          await clear();
          await say(copy.vencido);
        }
        return;
      }
      // La acción vieja pasa a `cancelled` cuando se crea la nueva (`supersedes`); hasta entonces sigue vigente.
      await updateState(deps.store, chatId, (s) => ({ ...s, awaiting: { kind: "edit", pending_action_id: parsed.id } }));
      await clear();
      await say(copy.cambiarPregunta);
      return;
    }
    case "undo": {
      const r = await undoAction(env.DB, parsed.id, { chatId, actor, now });
      if (r.kind === "undone") {
        await clear();
        await say(copyAcciones.deshecho);
      } else if (r.kind === "expired") {
        await clear();
        await say(copy.vencido);
      } else if (r.kind === "already") await clear();
      else if (r.kind === "not_undoable") await say(copyAcciones.noSePuedeDeshacer);
      return;
    }
  }
}

/**
 * Ruta de la cola para `type: "update"`. Hoy solo atiende `callback_query`; los mensajes (texto, voz, fotos) los
 * enchufan T16/T17 en este mismo punto (ver PR de T18).
 */
export async function handleUpdateMessage(msg: { update?: unknown }, env: Env): Promise<void> {
  const cq = (msg.update as { callback_query?: CallbackQuery } | undefined)?.callback_query;
  if (cq) await handleCallback(env, cq);
}
