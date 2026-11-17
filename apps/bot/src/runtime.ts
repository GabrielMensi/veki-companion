import {
  createGroqChatChain,
  createSttProvider,
  type ChatSettings,
  type AgentOutput,
  type ChatProvider,
  type ConversationStore,
  type SttProvider,
  type ToolHost,
} from "@veki/core";
import { alertEscalation } from "./admin/alerts";
import { D1ConversationStore, isVersionConflict } from "./actions/conversation-store";
import { attachMessage, d1ToolHost } from "./actions/pending";
import { parseAllowlist, type Env } from "./env";
import { catalogRead } from "./tools/catalog";
import "./actions/executors-catalog"; // registra los ejecutores de catálogo y de respaldo (T19)
import { albumEventText, setAgentEntry, type AgentEntry } from "./jobs/album-flush";
import { chatChainDeps } from "./provider-ports";
import { logEvent } from "./queues";
import { runTurn, type TurnReply } from "./handlers/text";

/** Cadena de STT por defecto (docs/02 §4.2, D11). El chat usa `buildChatChain` (R3). */
const DEFAULT_STT = "groq:whisper-large-v3";

/** Lo que necesitan los handlers de texto, voz y álbumes. */
export type Runtime = { chat: ChatProvider; stt: SttProvider; store: ConversationStore; host: ToolHost };

/** Proveedor de chat. Se resuelve en cada llamada: sin clave, falla ese turno y no el resto de los updates. */
export function buildChatChain(env: Env): ChatProvider {
  // R3: cadena de modelos de Groq y topes leídos de `settings` (con valores por defecto), una vez por runtime.
  let ready: Promise<{ chain: ChatProvider; settings: ChatSettings }> | undefined;
  const load = () =>
    (ready ??= chatChainDeps(env).then(({ settings, deps }) => ({
      settings,
      chain: createGroqChatChain(settings, { groqApiKey: env.GROQ_API_KEY }, deps),
    })));
  return {
    complete: async (req) => (await load()).chain.complete(req),
    agentLimits: async () => {
      const { settings } = await load();
      return { maxLlmCalls: settings.toolCallCap, historyLength: settings.historyLength };
    },
  };
}

export function buildStt(env: Env): SttProvider {
  return { transcribe: (audio, mime) => createSttProvider(DEFAULT_STT, { groqApiKey: env.GROQ_API_KEY }).transcribe(audio, mime) };
}

export function buildRuntime(env: Env): Runtime {
  const allow = parseAllowlist(env.ALLOWED_CHAT_IDS);
  return {
    chat: buildChatChain(env),
    stt: buildStt(env),
    store: new D1ConversationStore(env.DB, (id) => allow.get(id) ?? "owner"),
    host: d1ToolHost(env, catalogRead(env.DB)),
  };
}

let override: ((env: Env) => Runtime) | null = null;
/** Solo para tests: reemplaza proveedores y host por fakes. */
export const setRuntimeOverride = (fn: ((env: Env) => Runtime) | null) => void (override = fn);
export const getRuntime = (env: Env): Runtime => (override ?? buildRuntime)(env);

/** Envío de texto (con botones) a la usuaria; devuelve el id del mensaje de Telegram. */
export type Sender = (chatId: number, out: AgentOutput) => Promise<number | undefined>;

export function telegramSender(token: string, fetchFn: typeof fetch = fetch): Sender {
  return async (chatId, out) => {
    const res = await fetchFn(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: out.texto,
        ...(out.botones?.length
          ? { reply_markup: { inline_keyboard: [out.botones.map((b) => ({ text: b.etiqueta, callback_data: b.valor }))] } }
          : {}),
      }),
    });
    if (!res.ok) throw new Error("telegram sendMessage failed");
    const body = (await res.json().catch(() => null)) as { result?: { message_id?: number } } | null;
    return body?.result?.message_id;
  };
}

/** Manda la respuesta; si es una vista previa, deja anotado el mensaje para poder quitarle los botones después. */
export async function deliver(env: Env, send: Sender, chatId: number, out: AgentOutput): Promise<void> {
  try {
    const messageId = await send(chatId, out);
    if (out.pendingActionId && typeof messageId === "number") await attachMessage(env.DB, out.pendingActionId, messageId);
  } catch {
    await logEvent(env, "telegram.send_failed", "warn", { chat: "reply" }).catch(() => {});
  }
}

/** Responde un turno ya resuelto. Dos malentendidos seguidos quedan en `event_log` con el `update_id` (sin texto). */
export async function respond(env: Env, send: Sender, chatId: number, reply: TurnReply, updateId?: number): Promise<void> {
  if (reply.escalate) await logEvent(env, "agent.escalate", "warn", { update_id: updateId ?? null });
  await deliver(env, send, chatId, { texto: reply.texto, botones: reply.botones, pendingActionId: reply.pendingActionId });
  // Aviso al admin (tope 1 cada 30 min, solo `update_id` si hay; nunca texto). Cubre updates y el flush de álbumes.
  if (reply.escalate) await alertEscalation(env, updateId);
}

/** Un turno del agente + respuesta. Un error del turno se propaga (reintento); lo de enviar no. */
export async function agentTurn(env: Env, chatId: number, text: string, opts: { updateId?: number; send?: Sender } = {}): Promise<void> {
  const reply = await runTurn(getRuntime(env), { chatId, text });
  await respond(env, opts.send ?? telegramSender(env.TELEGRAM_BOT_TOKEN), chatId, reply, opts.updateId);
}

export { isVersionConflict };

/** Entrada real del agente para el flush de álbumes (docs/02 §2.3). */
export const albumEntry: AgentEntry = async (event, env) => {
  await agentTurn(env, event.chatId, albumEventText(event.media_ids));
};

setAgentEntry(albumEntry);
