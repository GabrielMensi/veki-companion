// Portable handler logic: only grammY + web-standard APIs (fetch, setTimeout, Map).
// No fs / process here. Node-only I/O lives in poll.ts / ping.ts / node-io.ts.
// On Workers, swap `AlbumBuffer` (in-memory) for a Durable Object / D1 row, since
// isolates do not share memory between requests.
import { Bot, GrammyError, InlineKeyboard, type Context } from "grammy";
import type { Message } from "grammy/types";

export const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
export const ALBUM_DEBOUNCE_MS = 2000;

export interface Deps {
  saveChatId(id: number): Promise<void>;
  log(msg: string, data?: Record<string, unknown>): void;
  albumDebounceMs?: number;
}

export const confirmKeyboard = () =>
  new InlineKeyboard().text("Sí", "confirm:yes").text("Cambiar", "confirm:change").text("Cancelar", "confirm:cancel");

export const pingKeyboard = () =>
  new InlineKeyboard().text("Sí, dale", "ping:yes").text("Más tarde", "ping:later");

const mb = (n: number) => (n / 1024 / 1024).toFixed(1);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

interface VideoInfo { kind: string; size?: number; duration?: number; tooBig: boolean }
interface Album { photos: number; videos: VideoInfo[]; timer: ReturnType<typeof setTimeout> }

/** Extract video-like payloads: video, video_note, animation, or document with video/* mime. */
function videoInfo(m: Message): VideoInfo | undefined {
  const mk = (kind: string, f: { file_size?: number; duration?: number }): VideoInfo => ({
    kind, size: f.file_size, duration: f.duration, tooBig: (f.file_size ?? 0) > MAX_DOWNLOAD_BYTES,
  });
  if (m.video) return mk("video", m.video);
  if (m.video_note) return mk("video_note", m.video_note);
  if (m.animation) return mk("animation", m.animation);
  if (m.document?.mime_type?.startsWith("video/")) return mk("document", m.document);
  return undefined;
}

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

  const debounce = deps.albumDebounceMs ?? ALBUM_DEBOUNCE_MS;

  async function flushAlbum(ctx: Context, al: { photos: number; videos: VideoInfo[] }) {
    if (al.videos.length === 0) return afterPhotos(ctx, al.photos);
    if (al.photos > 0) await afterPhotos(ctx, al.photos);
    await replyVideos(ctx, al.videos);
  }

  async function replyVideos(ctx: Context, vids: VideoInfo[]) {
    const big = vids.filter((v) => v.tooBig);
    const ok = vids.length - big.length;
    if (big.length > 0) {
      const sizes = big.map((v) => (v.size === undefined ? "más de 20 MB" : `${mb(v.size)} MB`)).join(", ");
      await ctx.reply(
        `Uh, ${big.length === 1 ? "ese video pesa" : "esos videos pesan"} ${sizes} y no lo${big.length === 1 ? "" : "s"} puedo bajar (mi límite es 20 MB). ¿Me mandás ${big.length === 1 ? "uno más cortito" : "otros más cortitos"}, de unos 10 segundos? 🙏`,
      );
    }
    if (ok > 0) {
      const v = vids.find((x) => !x.tooBig)!;
      const detail = vids.length === 1 && v.size !== undefined ? ` Pesa ${mb(v.size)} MB${v.duration ? ` y dura ${v.duration} s` : ""}.` : "";
      await ctx.reply(`¡Recibí ${plural(ok, "video", "videos")}!${detail} 🎬`);
    }
  }

  function addToAlbum(ctx: Context, gid: string, add: { photo?: boolean; video?: VideoInfo }) {
    const prev = albums.get(gid);
    if (prev) clearTimeout(prev.timer);
    const al = { photos: prev?.photos ?? 0, videos: prev?.videos ?? [] };
    if (add.photo) al.photos++;
    if (add.video) al.videos.push(add.video);
    const timer = setTimeout(() => {
      albums.delete(gid);
      flushAlbum(ctx, al).catch((e) => deps.log("album reply failed", { err: String(e) }));
    }, debounce);
    albums.set(gid, { ...al, timer });
  }

  bot.on("message:photo", async (ctx) => {
    const photo = ctx.message.photo.at(-1);
    deps.log("photo", { size: photo?.file_size, album: ctx.message.media_group_id ?? null });
    const gid = ctx.message.media_group_id;
    if (!gid) return afterPhotos(ctx, 1);
    addToAlbum(ctx, gid, { photo: true });
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

  bot.on("message", async (ctx, next) => {
    const m = ctx.message;
    const info = videoInfo(m);
    if (!info) return next();
    // Missing size metadata: ask Telegram; a 400 "file is too big" means over the limit.
    if (info.size === undefined) {
      try {
        await ctx.getFile();
      } catch (e) {
        if (e instanceof GrammyError && e.error_code === 400 && /too big/i.test(e.description)) info.tooBig = true;
        else throw e;
      }
    }
    deps.log("video", {
      kind: info.kind, size_mb: info.size === undefined ? "unknown" : mb(info.size),
      duration_s: info.duration, too_big: info.tooBig, album: m.media_group_id ?? null,
    });
    if (m.media_group_id) return addToAlbum(ctx, m.media_group_id, { video: info });
    await replyVideos(ctx, [info]);
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
    const m = ctx.message;
    const media = m.document ?? m.video ?? m.audio ?? m.sticker;
    deps.log("unhandled message", {
      keys: Object.keys(m).filter((k) => !["message_id", "from", "chat", "date"].includes(k)),
      mime: (m.document ?? m.audio)?.mime_type,
      size: media?.file_size,
      file_name: m.document?.file_name,
    });
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
