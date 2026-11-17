import { MAX_DOWNLOAD_BYTES, copyMedia } from "@veki/core";
import type { D1DatabaseLike, D1PreparedStatementLike, Env, QueueProducer } from "../env";
import { mediaKey, newMediaId, putOriginal, type R2Like } from "../r2";

/** D1 real tiene `batch`; el tipo estructural de env.ts no lo declara. */
export type DbBatch = D1DatabaseLike & { batch(stmts: D1PreparedStatementLike[]): Promise<{ meta: { changes: number } }[]> };

export const ALBUM_DELAY_SECONDS = 3;
export const MEMBER_EVENT = "media.group_member";

export type MediaItem = {
  kind: "photo" | "video";
  fileId: string;
  uniqueId: string;
  smallFileId?: string;
  mime: string;
  ext: string;
  size?: number;
  width?: number;
  height?: number;
  duration?: number;
};

type PhotoSize = { file_id: string; file_unique_id: string; width: number; height: number; file_size?: number };
type FileLike = { file_id: string; file_unique_id: string; file_size?: number; duration?: number; width?: number; height?: number; mime_type?: string; length?: number };
export type TgMessage = {
  chat: { id: number };
  media_group_id?: string;
  photo?: PhotoSize[];
  video?: FileLike;
  video_note?: FileLike;
  animation?: FileLike;
  document?: FileLike;
};

const extFromMime = (mime: string) => (mime === "video/quicktime" ? "mov" : mime === "video/webm" ? "webm" : "mp4");

/** Foto: guarda la más grande; para visión anota la más cercana a 800 px de lado (docs/02 §4.1). */
export function extractMedia(m: TgMessage): MediaItem | null {
  if (m.photo?.length) {
    const sizes = m.photo;
    const biggest = sizes.reduce((a, b) => (b.width * b.height >= a.width * a.height ? b : a));
    const small = sizes.reduce((a, b) => (Math.abs(Math.max(b.width, b.height) - 800) < Math.abs(Math.max(a.width, a.height) - 800) ? b : a));
    return {
      kind: "photo", fileId: biggest.file_id, uniqueId: biggest.file_unique_id, smallFileId: small.file_id,
      mime: "image/jpeg", ext: "jpg", size: biggest.file_size, width: biggest.width, height: biggest.height,
    };
  }
  // video, video_note, animation y document con video/* (hallazgo del spike).
  const v = m.video ?? m.video_note ?? m.animation ?? (m.document?.mime_type?.startsWith("video/") ? m.document : undefined);
  if (!v) return null;
  const mime = v.mime_type?.startsWith("video/") ? v.mime_type : "video/mp4";
  return {
    kind: "video", fileId: v.file_id, uniqueId: v.file_unique_id, mime, ext: extFromMime(mime),
    size: v.file_size, width: v.width ?? v.length, height: v.height ?? v.length, duration: v.duration,
  };
}

export type MediaDeps = {
  db: DbBatch;
  r2: R2Like;
  jobs: QueueProducer;
  token: string;
  fetch?: typeof fetch;
  now?: () => number;
  /** Respuesta a la usuaria (texto fijo). Por defecto `sendMessage` de Telegram. */
  send?: (chatId: number, text: string) => Promise<void>;
};

export function mediaDepsFromEnv(env: Env): MediaDeps {
  return { db: env.DB as DbBatch, r2: env.MEDIA as R2Like, jobs: env.Q_JOBS, token: env.TELEGRAM_BOT_TOKEN };
}

export async function sendTelegram(token: string, chatId: number, text: string, f: typeof fetch = fetch): Promise<void> {
  const res = await f(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!res.ok) throw new Error("telegram sendMessage failed");
}

class TooBig extends Error {}

/** getFile + descarga. Un 400 "too big" de getFile es el límite de 20 MB (spike). */
async function download(deps: MediaDeps, fileId: string): Promise<{ bytes: ArrayBuffer; mime?: string }> {
  const f = deps.fetch ?? fetch;
  const meta = await f(`https://api.telegram.org/bot${deps.token}/getFile?file_id=${encodeURIComponent(fileId)}`);
  const body = (await meta.json().catch(() => ({}))) as { ok?: boolean; error_code?: number; description?: string; result?: { file_path?: string } };
  if (meta.status === 400 && /too big/i.test(body.description ?? "")) throw new TooBig();
  const path = body.result?.file_path;
  if (!meta.ok || !body.ok || !path) throw new Error("telegram getFile failed");
  const file = await f(`https://api.telegram.org/file/bot${deps.token}/${path}`);
  if (!file.ok) throw new Error("telegram file download failed");
  return { bytes: await file.arrayBuffer(), mime: file.headers.get("content-type") ?? undefined };
}

export type IngestResult =
  | { status: "ignored" }
  | { status: "too_big" }
  | { status: "stored" | "duplicate"; mediaId: string; gid?: string };

/**
 * Ingresa una foto/video: dedupe por `tg_file_unique_id`, descarga a R2 y fila `media` (inbox).
 * Con `media_group_id`: upsert en `inbox_groups` + membresía + fila `media` en un solo `db.batch()`
 * y encola `album.flush` con 3 s de demora (docs/02 §2.3). Sin álbum no hay evento propio aquí:
 * la foto suelta entra al agente por el flujo normal de mensajes.
 */
export async function ingestMedia(deps: MediaDeps, m: TgMessage): Promise<IngestResult> {
  const item = extractMedia(m);
  if (!item) return { status: "ignored" };
  const now = (deps.now ?? Date.now)();
  const chatId = m.chat.id;
  const send = deps.send ?? ((c, t) => sendTelegram(deps.token, c, t, deps.fetch));
  const gid = m.media_group_id;

  if (item.size !== undefined && item.size > MAX_DOWNLOAD_BYTES) {
    await send(chatId, copyMedia.videoPesado(item.size));
    return { status: "too_big" };
  }

  const existing = await deps.db.prepare("SELECT id FROM media WHERE tg_file_unique_id = ?").bind(item.uniqueId).first<{ id: string }>();
  let mediaId = existing?.id ?? "";
  let status: "stored" | "duplicate" = "duplicate";
  let r2Key: string | null = null;

  const group: D1PreparedStatementLike[] = gid
    ? [
        deps.db
          .prepare(
            "INSERT INTO inbox_groups (media_group_id, chat_id, item_count, first_at, last_at, status) VALUES (?, ?, 1, ?, ?, 'open') ON CONFLICT(media_group_id) DO UPDATE SET item_count = item_count + 1, last_at = excluded.last_at",
          )
          .bind(gid, chatId, now, now),
        // Membresía: `media` no tiene columna de grupo; el id sale del unique_id para tolerar carreras.
        deps.db
          .prepare(
            "INSERT INTO event_log (id, ts, actor, type, severity, data) VALUES (?, ?, 'bot', ?, 'info', json_object('gid', ?, 'media_id', (SELECT id FROM media WHERE tg_file_unique_id = ?)))",
          )
          .bind(newMediaId(now), now, MEMBER_EVENT, gid, item.uniqueId),
      ]
    : [];

  if (!existing) {
    let file: { bytes: ArrayBuffer; mime?: string };
    try {
      file = await download(deps, item.fileId);
    } catch (e) {
      if (e instanceof TooBig) {
        await send(chatId, copyMedia.videoPesado());
        return { status: "too_big" };
      }
      throw e;
    }
    if (file.bytes.byteLength > MAX_DOWNLOAD_BYTES) {
      await send(chatId, copyMedia.videoPesado(file.bytes.byteLength));
      return { status: "too_big" };
    }
    mediaId = newMediaId(now);
    r2Key = mediaKey(mediaId, item.ext, now);
    await putOriginal(deps.r2, r2Key, file.bytes, item.mime);
    const insert = deps.db
      .prepare(
        "INSERT OR IGNORE INTO media (id, r2_key, kind, mime, bytes, width, height, duration_s, tg_file_unique_id, tg_small_file_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'inbox', ?)",
      )
      .bind(mediaId, r2Key, item.kind, item.mime, file.bytes.byteLength, item.width ?? null, item.height ?? null, item.duration ?? null, item.uniqueId, item.smallFileId ?? null, now);
    const res = await deps.db.batch([insert, ...group]);
    if (res[0]!.meta.changes === 0) {
      // Otra entrega ganó la carrera por el mismo archivo: borramos el objeto huérfano.
      await deps.r2.delete(r2Key);
      const winner = await deps.db.prepare("SELECT id FROM media WHERE tg_file_unique_id = ?").bind(item.uniqueId).first<{ id: string }>();
      mediaId = winner!.id;
    } else {
      status = "stored";
    }
  } else if (group.length) {
    await deps.db.batch(group);
  }

  if (gid) await deps.jobs.send({ type: "album.flush", gid }, { delaySeconds: ALBUM_DELAY_SECONDS });
  return { status, mediaId, ...(gid ? { gid } : {}) };
}

/** Punto de entrada para el router de updates: `false` si el mensaje no trae foto ni video. */
export async function handleMediaMessage(env: Env, message: TgMessage, deps: MediaDeps = mediaDepsFromEnv(env)): Promise<boolean> {
  if (!extractMedia(message)) return false;
  await ingestMedia(deps, message);
  return true;
}
