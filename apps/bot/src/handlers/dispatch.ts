import { copy, isProviderError } from "@veki/core";
import { handleAdminCommand } from "../admin/commands";
import type { Env } from "../env";
import { isVersionConflict } from "../actions/conversation-store";
import { logEvent } from "../queues";
import { albumEventText } from "../jobs/album-flush";
import { deliver, getRuntime, respond, telegramSender, type Sender } from "../runtime";
import { agentInputFromCallback, handleCallback, type CallbackDeps, type CallbackQuery } from "./callback";
import { extractMedia, handleMediaMessage, type MediaDeps, type TgMessage } from "./media";
import { runTurn } from "./text";
import { handleVoice, telegramDownloader, type AudioDownloader } from "./voice";

type TgUpdateMessage = TgMessage & {
  text?: string;
  voice?: { file_id: string; mime_type?: string };
};
type TgUpdate = { callback_query?: CallbackQuery; message?: TgUpdateMessage; [k: string]: unknown };

/** Piezas inyectables (tests); por defecto salen de `Env` y del runtime. */
export type DispatchDeps = {
  send?: Sender;
  download?: AudioDownloader;
  media?: MediaDeps;
  callback?: CallbackDeps;
};

export type UpdateKind = "callback" | "text" | "voice" | "media" | "unsupported" | "ignored";

export function classifyUpdate(u: TgUpdate): UpdateKind {
  if (u.callback_query) return "callback";
  const m = u.message;
  if (!m || typeof m.chat?.id !== "number") return "ignored";
  if (typeof m.text === "string" && m.text.trim()) return "text";
  if (m.voice?.file_id) return "voice";
  if (extractMedia(m)) return "media";
  return "unsupported";
}

/**
 * Ruta de la cola para `type: "update"` (docs/02 §1.3 paso 3, §3.3, §4.1).
 * Un tipo inesperado nunca rompe: se anota en `event_log` (solo el tipo, sin contenido) y se responde con texto fijo.
 * Los choques de versión de la conversación y las fallas de descarga de medios se propagan para que la cola reintente
 * (son idempotentes), igual que los ProviderError de límite o caída del proveedor; lo demás responde "algo salió mal" y queda registrado.
 */
export async function handleUpdateMessage(msg: { update_id?: number; update?: unknown }, env: Env, deps: DispatchDeps = {}): Promise<void> {
  const update = (msg.update && typeof msg.update === "object" ? msg.update : {}) as TgUpdate;
  const kind = classifyUpdate(update);
  const send = deps.send ?? telegramSender(env.TELEGRAM_BOT_TOKEN);
  const chatId = update.message?.chat?.id;
  const say = (text: string) =>
    typeof chatId === "number" ? deliver(env, send, chatId, { texto: text }) : Promise.resolve();

  try {
    switch (kind) {
      case "callback":
        const cq = update.callback_query!;
        await handleCallback(env, cq, deps.callback); // contesta el botón y resuelve los `pa:<id>:*`
        // Atajos (`sc:`) y elecciones del agente (`ch:`): entran al agente igual que un mensaje escrito.
        const input = agentInputFromCallback(cq.data);
        const cbChat = cq.message?.chat?.id ?? cq.from?.id;
        if (input && typeof cbChat === "number") {
          const reply = await runTurn(getRuntime(env), { chatId: cbChat, text: input });
          await respond(env, send, cbChat, reply, msg.update_id);
        }
        return;
      case "text": {
        // Comandos `/…` solo para role=admin; para cualquier otro chat `handleAdminCommand` devuelve null y sigue el flujo normal.
        const adminReply = update.message!.text!.trim().startsWith("/") ? await handleAdminCommand(env, chatId!, update.message!.text!) : null;
        if (adminReply !== null) {
          await say(adminReply);
          return;
        }
        const reply = await runTurn(getRuntime(env), { chatId: chatId!, text: update.message!.text!.trim() });
        await respond(env, send, chatId!, reply, msg.update_id);
        return;
      }
      case "voice": {
        const rt = getRuntime(env);
        const download = deps.download ?? telegramDownloader(env.TELEGRAM_BOT_TOKEN);
        const m = update.message!;
        const reply = await handleVoice({ ...rt, download }, { chatId: chatId!, fileId: m.voice!.file_id, mime: m.voice!.mime_type });
        await respond(env, send, chatId!, reply, msg.update_id);
        return;
      }
      case "media": {
        const m = update.message!;
        await handleMediaMessage(env, m, deps.media);
        // Foto o video suelto: entra al agente ya. Los álbumes entran por `album.flush` (setAgentEntry).
        if (!m.media_group_id) {
          const unique = extractMedia(m)!.uniqueId;
          const row = await env.DB.prepare("SELECT id FROM media WHERE tg_file_unique_id = ?").bind(unique).first<{ id: string }>();
          if (row) {
            const reply = await runTurn(getRuntime(env), { chatId: chatId!, text: albumEventText([row.id]) });
            await respond(env, send, chatId!, reply, msg.update_id);
          }
        }
        return;
      }
      case "unsupported":
        await logEvent(env, "update.unsupported", "info", { keys: Object.keys(update.message ?? {}).filter((k) => !["message_id", "date", "chat", "from"].includes(k)) });
        await say(copy.tipoNoSoportado);
        return;
      default:
        await logEvent(env, "update.ignored", "info", { keys: Object.keys(update) });
    }
  } catch (e) {
    // Proveedor de chat limitado o caído: sube a la cola (reintento con `retry-after` + aviso amable una sola vez, `handleBatch`).
    if (isVersionConflict(e) || kind === "media" || (isProviderError(e) && (e.kind === "rate_limit" || e.kind === "unavailable"))) throw e;
    await logEvent(env, "update.error", "error", { kind, update_id: msg.update_id ?? null, error: e instanceof Error ? e.name : "unknown" });
    await say(copy.algoSalioMal);
  }
}
