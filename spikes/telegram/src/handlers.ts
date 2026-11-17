// Portable handler logic: only grammY + web-standard APIs (fetch, setTimeout, Map).
// No fs / process here. Node-only I/O lives in poll.ts / ping.ts / node-io.ts.
// On Workers, swap `AlbumBuffer` (in-memory) for a Durable Object / D1 row, since
// isolates do not share memory between requests.
import { Bot, InlineKeyboard, type Context } from "grammy";

export const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
export const ALBUM_DEBOUNCE_MS = 2000;

export interface Deps {
  saveChatId(id: number): Promise<void>;
  log(msg: string, data?: Record<string, unknown>): void;
}

export const confirmKeyboard = () =>
  new InlineKeyboard().text("Sí", "confirm:yes").text("Cambiar", "confirm:change").text("Cancelar", "confirm:cancel");

export const pingKeyboard = () =>
  new InlineKeyboard().text("Sí, dale", "ping:yes").text("Más tarde", "ping:later");

const mb = (n: number) => (n / 1024 / 1024).toFixed(1);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

interface Album { count: number; timer: ReturnType<typeof setTimeout> }

export function registerHandlers(bot: Bot, deps: Deps): void {
  const albums = new Map<string, Album>();

  async function afterPhotos(ctx: Context, count: number) {
    await ctx.reply(`¡Qué lindas fotos! Recibí ${plural(count, "foto", "fotos")}.`);
    await ctx.reply(`Armé una vista previa con ${plural(count, "foto", "fotos")}. ¿La publicamos?`, {
      reply_markup: confirmKeyboard(),
    });
  }

  bot.command("start", async (ctx) => {
    await deps.saveChatId(ctx.chat.id);
    deps.log("start", { chatId: ctx.chat.id });
    await ctx.reply(
      "¡Hola! Soy Veki 👋 Mandame fotos, audios o videos cortitos de tus productos y yo me encargo del resto. Probá mandarme una foto cuando quieras.",
    );
  });

  bot.on("message:photo", async (ctx) => {
    const photo = ctx.message.photo.at(-1);
    deps.log("photo", { size: photo?.file_size, album: ctx.message.media_group_id ?? null });
    const gid = ctx.message.media_group_id;
    if (!gid) return afterPhotos(ctx, 1);
    const prev = albums.get(gid);
    if (prev) clearTimeout(prev.timer);
    const count = (prev?.count ?? 0) + 1;
    const timer = setTimeout(() => {
      albums.delete(gid);
      afterPhotos(ctx, count).catch((e) => deps.log("album reply failed", { err: String(e) }));
    }, ALBUM_DEBOUNCE_MS);
    albums.set(gid, { count, timer });
  });

  bot.on("message:voice", async (ctx) => {
    const v = ctx.message.voice;
    const file = await ctx.getFile();
    let downloaded = "n/a";
    if (file.file_path) {
      const res = await fetch(`https://api.telegram.org/file/bot${bot.token}/${file.file_path}`);
      downloaded = String((await res.arrayBuffer()).byteLength);
    }
    deps.log("voice", { duration_s: v.duration, size: v.file_size, downloaded_bytes: downloaded });
    await ctx.reply("¡Escuché tu audio! Lo recibí bien. 🎧 (Todavía no sé transcribirlo, eso viene después.)");
  });

  bot.on("message:video", async (ctx) => {
    const v = ctx.message.video;
    const size = v.file_size ?? 0;
    deps.log("video", { size_mb: mb(size), duration_s: v.duration });
    if (size > MAX_DOWNLOAD_BYTES) {
      await ctx.reply(
        `Uh, ese video pesa ${mb(size)} MB y no lo puedo bajar (mi límite es 20 MB). ¿Me mandás uno más cortito, de unos 10 segundos? 🙏`,
      );
      return;
    }
    await ctx.reply(`¡Recibí tu video! Pesa ${mb(size)} MB y dura ${v.duration} s. 🎬`);
  });

  bot.callbackQuery(/^confirm:(yes|change|cancel)$/, async (ctx) => {
    const action = ctx.match[1];
    const text =
      action === "yes" ? "✅ ¡Listo! Quedó confirmado."
      : action === "change" ? "✏️ Dale, contame qué querés cambiar."
      : "❌ Cancelado, no se publicó nada.";
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(text);
  });

  bot.callbackQuery(/^ping:(yes|later)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(ctx.match[1] === "yes" ? "¡Genial, gracias! 🙌" : "Dale, te aviso más tarde. 😊");
  });

  bot.on("message", async (ctx) => {
    await ctx.reply("Por ahora entiendo fotos, audios y videos cortitos. ¡Probá con alguno! 🙂");
  });

  bot.catch(async (err) => {
    deps.log("unhandled error", { err: String(err.error), update: err.ctx.update.update_id });
    try {
      await err.ctx.reply("Ups, algo salió mal de mi lado. ¿Probás de nuevo? 🙏");
    } catch {
      /* reply itself failed; already logged */
    }
  });
}

export async function sendPing(bot: Bot, chatId: number): Promise<void> {
  await bot.api.sendMessage(chatId, "¡Hola! Soy Veki 👋 Te escribo yo primero. ¿Te acordás de que mañana hay feria? ¿Armamos algo?", {
    reply_markup: pingKeyboard(),
  });
}
