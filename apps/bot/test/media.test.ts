import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { copyMedia } from "@veki/core";
import { handleBatch, type QueueMessageLike } from "../src/queues";
import { handleAlbumFlush, setAgentEntry, type AlbumEvent } from "../src/jobs/album-flush";
import { ingestMedia, type DbBatch, type MediaDeps, type TgMessage } from "../src/handlers/media";
import type { Env } from "../src/env";
import { mediaKey } from "../src/r2";

// Todo inventado: ids, token y bytes.
const e = env as unknown as { DB: DbBatch; MEDIA: R2Bucket };
const CHAT = 4242;
const T0 = 1_800_000_000_000;

type Sent = { msg: unknown; delay?: number };
function setup() {
  const jobs: Sent[] = [];
  const replies: string[] = [];
  const getFileCalls: string[] = [];
  const fakeFetch = (async (input: RequestInfo | URL) => {
    const u = String(input);
    if (u.includes("/getFile")) {
      const id = new URL(u).searchParams.get("file_id")!;
      getFileCalls.push(id);
      if (id.startsWith("huge")) return new Response(JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: file is too big" }), { status: 400 });
      return new Response(JSON.stringify({ ok: true, result: { file_path: `files/${id}.bin` } }));
    }
    return new Response(new Uint8Array([1, 2, 3, 4]));
  }) as typeof fetch;
  const deps: MediaDeps = {
    db: e.DB,
    r2: e.MEDIA as unknown as MediaDeps["r2"],
    jobs: { send: async (msg, o) => void jobs.push({ msg, delay: o?.delaySeconds }) },
    token: "test-token",
    fetch: fakeFetch,
    now: () => T0,
    send: async (_c, t) => void replies.push(t),
  };
  return { deps, jobs, replies, getFileCalls };
}

const photo = (uid: string, gid?: string, extra: Partial<TgMessage> = {}): TgMessage => ({
  chat: { id: CHAT },
  ...(gid ? { media_group_id: gid } : {}),
  photo: [
    { file_id: `${uid}-s`, file_unique_id: `${uid}-s`, width: 90, height: 60 },
    { file_id: `${uid}-m`, file_unique_id: `${uid}-m`, width: 800, height: 600 },
    { file_id: `${uid}-l`, file_unique_id: `${uid}-l`, width: 1280, height: 960 },
  ],
  ...extra,
});

const mediaCount = async () => (await e.DB.prepare("SELECT COUNT(*) AS n FROM media").first<{ n: number }>())!.n;

beforeEach(async () => {
  await e.DB.prepare("DELETE FROM media").run();
  await e.DB.prepare("DELETE FROM inbox_groups").run();
  await e.DB.prepare("DELETE FROM event_log").run();
  setAgentEntry(null);
});

describe("r2 key", () => {
  it("orig/YYYY/MM/<id>.<ext>", () => {
    expect(mediaKey("01ABC", "jpg", Date.UTC(2026, 10, 5))).toBe("orig/2026/11/01ABC.jpg");
  });
});

describe("photo intake", () => {
  it("stores the biggest size in R2 and notes the ~800px one for vision", async () => {
    const { deps } = setup();
    const r = await ingestMedia(deps, photo("p1"));
    expect(r.status).toBe("stored");
    const row = await e.DB.prepare("SELECT * FROM media").first<Record<string, unknown>>();
    expect(row).toMatchObject({ kind: "photo", mime: "image/jpeg", status: "inbox", tg_file_unique_id: "p1-l", tg_small_file_id: "p1-m", width: 1280, height: 960 });
    expect(String(row!.r2_key)).toMatch(/^orig\/\d{4}\/\d{2}\/[0-9A-Za-z]+\.jpg$/);
    expect(await e.MEDIA.head(row!.r2_key as string)).not.toBeNull();
  });

  it("a forwarded (same unique_id) photo leaves a single media row and does not re-download", async () => {
    const { deps, getFileCalls } = setup();
    const a = await ingestMedia(deps, photo("p2"));
    const b = await ingestMedia(deps, photo("p2", undefined, { forward_origin: { type: "user" } } as Partial<TgMessage>));
    expect(await mediaCount()).toBe(1);
    expect(b.status).toBe("duplicate");
    expect(b).toMatchObject({ mediaId: (a as { mediaId: string }).mediaId });
    expect(getFileCalls).toHaveLength(1);
  });

  it("concurrent duplicate deliveries still yield one row and no orphan object", async () => {
    const { deps } = setup();
    await Promise.all([ingestMedia(deps, photo("p3")), ingestMedia(deps, photo("p3"))]);
    expect(await mediaCount()).toBe(1);
    const rows = await e.DB.prepare("SELECT r2_key FROM media").all<{ r2_key: string }>();
    const known = new Set(rows.results.map((r) => r.r2_key));
    expect(known.size).toBe(1);
    const listed = await e.MEDIA.list({ prefix: "orig/" });
    expect(listed.objects.filter((o) => !known.has(o.key) && o.key.endsWith(".jpg") && o.uploaded.getTime() > Date.now() - 60_000).length).toBe(0);
  });
});

describe("videos", () => {
  const vid = (over: Record<string, unknown>, key = "video"): TgMessage => ({ chat: { id: CHAT }, [key]: { file_id: "v1", file_unique_id: "v1u", mime_type: "video/mp4", file_size: 1000, duration: 8, ...over } }) as TgMessage;

  it("video over 20 MB gets the friendly text and no row", async () => {
    const { deps, replies, getFileCalls } = setup();
    const r = await ingestMedia(deps, vid({ file_size: 25 * 1024 * 1024 }));
    expect(r.status).toBe("too_big");
    expect(replies).toEqual([copyMedia.videoPesado(25 * 1024 * 1024)]);
    expect(replies[0]).toContain("25,0 MB");
    expect(await mediaCount()).toBe(0);
    expect(getFileCalls).toHaveLength(0);
  });

  it("getFile 400 'too big' (size unknown) gives the friendly text", async () => {
    const { deps, replies } = setup();
    const r = await ingestMedia(deps, vid({ file_id: "huge1", file_size: undefined }));
    expect(r.status).toBe("too_big");
    expect(replies).toEqual([copyMedia.videoPesado()]);
    expect(replies[0]).toContain("más de 20 MB");
    expect(await mediaCount()).toBe(0);
  });

  it.each([
    ["video", {}],
    ["video_note", { mime_type: undefined }],
    ["animation", {}],
    ["document", {}],
  ])("%s is stored as kind=video", async (key, over) => {
    const { deps } = setup();
    const r = await ingestMedia(deps, vid({ file_unique_id: `u-${key}`, ...over }, key));
    expect(r.status).toBe("stored");
    const row = await e.DB.prepare("SELECT kind, mime, r2_key FROM media").first<{ kind: string; mime: string; r2_key: string }>();
    expect(row).toMatchObject({ kind: "video", mime: "video/mp4" });
    expect(row!.r2_key.endsWith(".mp4")).toBe(true);
  });

  it("a non-video document is ignored", async () => {
    const { deps } = setup();
    const r = await ingestMedia(deps, { chat: { id: CHAT }, document: { file_id: "d", file_unique_id: "du", mime_type: "application/pdf" } });
    expect(r.status).toBe("ignored");
  });
});

describe("albums", () => {
  async function sendAlbum(deps: MediaDeps, gid: string, uids: string[]) {
    for (const u of uids) await ingestMedia(deps, photo(u, gid));
  }
  const batchEnv = (jobs: Sent[]) => ({ ...(env as object), Q_JOBS: { send: async (m: unknown, o?: { delaySeconds?: number }) => void jobs.push({ msg: m, delay: o?.delaySeconds }) } }) as unknown as Env;

  it("3 photos of one media_group_id arriving out of order -> exactly one event", async () => {
    const { deps, jobs } = setup();
    const events: AlbumEvent[] = [];
    setAgentEntry(async (ev) => void events.push(ev));
    // Llegan 'desordenadas' (c, a, b) y cada una encola su flush con 3 s.
    await sendAlbum(deps, "g1", ["c", "a", "b"]);
    expect(jobs.map((j) => j.delay)).toEqual([3, 3, 3]);
    const g = await e.DB.prepare("SELECT item_count, status FROM inbox_groups WHERE media_group_id='g1'").first();
    expect(g).toMatchObject({ item_count: 3, status: "open" });

    // Un flush antes de que pasen 2 s desde la última foto se re-encola con 2 s.
    const q: Sent[] = [];
    expect(await handleAlbumFlush({ gid: "g1" }, batchEnv(q), T0 + 1000)).toBe("requeued");
    expect(q).toEqual([{ msg: { type: "album.flush", gid: "g1" }, delay: 2 }]);
    expect(events).toHaveLength(0);

    // Los 3 mensajes de flush pasan por el router de la cola: uno gana, los otros hacen ack.
    const acks: number[] = [];
    const batch = { queue: "q-jobs", messages: jobs.map((j, i) => ({ body: j.msg, attempts: 1, ack: () => void acks.push(i), retry: () => {} }) as QueueMessageLike) };
    const realNow = Date.now;
    Date.now = () => T0 + 3000;
    try {
      await handleBatch(batch, batchEnv([]));
    } finally {
      Date.now = realNow;
    }
    expect(acks).toEqual([0, 1, 2]);
    expect(events).toHaveLength(1);
    expect(events[0]!.chatId).toBe(CHAT);
    expect(events[0]!.media_ids).toHaveLength(3);
    const rows = await e.DB.prepare("SELECT id FROM media").all<{ id: string }>();
    expect([...events[0]!.media_ids].sort()).toEqual(rows.results.map((r) => r.id).sort());
    expect((await e.DB.prepare("SELECT status FROM inbox_groups WHERE media_group_id='g1'").first<{ status: string }>())!.status).toBe("flushed");
  });

  it("2 concurrent flushes -> one wins", async () => {
    const { deps } = setup();
    const events: AlbumEvent[] = [];
    setAgentEntry(async (ev) => void events.push(ev));
    await sendAlbum(deps, "g2", ["x", "y"]);
    const out = await Promise.all([handleAlbumFlush({ gid: "g2" }, batchEnv([]), T0 + 3000), handleAlbumFlush({ gid: "g2" }, batchEnv([]), T0 + 3000)]);
    expect(out.sort()).toEqual(["delivered", "skipped"]);
    expect(events).toHaveLength(1);
    expect(events[0]!.media_ids).toHaveLength(2);
  });

  it("a duplicate photo inside an album is still listed once", async () => {
    const { deps } = setup();
    const events: AlbumEvent[] = [];
    setAgentEntry(async (ev) => void events.push(ev));
    await ingestMedia(deps, photo("dup")); // enviada antes, suelta
    await sendAlbum(deps, "g3", ["dup", "other"]);
    await handleAlbumFlush({ gid: "g3" }, batchEnv([]), T0 + 3000);
    expect(await mediaCount()).toBe(2);
    expect(events[0]!.media_ids).toHaveLength(2);
  });

  it("album membership is written to media.media_group_id and read back from it (no event_log rows)", async () => {
    const { deps } = setup();
    const events: AlbumEvent[] = [];
    setAgentEntry(async (ev) => void events.push(ev));
    await sendAlbum(deps, "gcol", ["k1", "k2"]);
    await ingestMedia(deps, photo("solo")); // suelta: sin grupo
    const rows = await e.DB.prepare("SELECT id, media_group_id AS g FROM media ORDER BY created_at, id").all<{ id: string; g: string | null }>();
    expect(rows.results.filter((r) => r.g === "gcol")).toHaveLength(2);
    expect(rows.results.filter((r) => r.g === null)).toHaveLength(1);
    expect((await e.DB.prepare("SELECT COUNT(*) AS n FROM event_log WHERE type = 'media.group_member'").first<{ n: number }>())!.n).toBe(0);
    await handleAlbumFlush({ gid: "gcol" }, batchEnv([]), T0 + 3000);
    expect([...events[0]!.media_ids].sort()).toEqual(rows.results.filter((r) => r.g === "gcol").map((r) => r.id).sort());
  });

  it("legacy album (pre-0002: membership only in event_log) is still delivered with all its photos", async () => {
    const run = (sql: string, ...b: unknown[]) => e.DB.prepare(sql).bind(...b).run();
    for (const id of ["m-old-1", "m-old-2"]) {
      await run("INSERT INTO media (id, r2_key, kind, mime, tg_file_unique_id, status, created_at) VALUES (?, ?, 'photo', 'image/jpeg', ?, 'inbox', ?)", id, `orig/${id}.jpg`, `u-${id}`, T0);
      await run("INSERT INTO event_log (id, ts, actor, type, severity, data) VALUES (?, ?, 'bot', 'media.group_member', 'info', json_object('gid', 'glegacy', 'media_id', ?))", `ev-${id}`, T0, id);
    }
    await run("INSERT INTO inbox_groups (media_group_id, chat_id, item_count, first_at, last_at, status) VALUES ('glegacy', ?, 2, ?, ?, 'open')", CHAT, T0, T0);
    const events: AlbumEvent[] = [];
    setAgentEntry(async (ev) => void events.push(ev));
    expect(await handleAlbumFlush({ gid: "glegacy" }, batchEnv([]), T0 + 3000)).toBe("delivered");
    expect(events[0]!.media_ids).toEqual(["m-old-1", "m-old-2"]);
  });

  it("an album mixing legacy members and column members lists each photo once", async () => {
    const run = (sql: string, ...b: unknown[]) => e.DB.prepare(sql).bind(...b).run();
    await run("INSERT INTO media (id, r2_key, kind, mime, tg_file_unique_id, status, created_at) VALUES ('m-leg', 'orig/m-leg.jpg', 'photo', 'image/jpeg', 'u-leg', 'inbox', ?)", T0);
    await run("INSERT INTO event_log (id, ts, actor, type, severity, data) VALUES ('ev-leg', ?, 'bot', 'media.group_member', 'info', json_object('gid', 'gmix', 'media_id', 'm-leg'))", T0);
    await run("INSERT INTO inbox_groups (media_group_id, chat_id, item_count, first_at, last_at, status) VALUES ('gmix', ?, 1, ?, ?, 'open')", CHAT, T0, T0);
    const { deps } = setup();
    await ingestMedia(deps, photo("late", "gmix"));
    const events: AlbumEvent[] = [];
    setAgentEntry(async (ev) => void events.push(ev));
    await handleAlbumFlush({ gid: "gmix" }, batchEnv([]), T0 + 3000);
    expect(events[0]!.media_ids).toHaveLength(2);
    expect(events[0]!.media_ids).toContain("m-leg");
    expect(new Set(events[0]!.media_ids).size).toBe(2);
  });

  it("delivery failure reopens the group so the queue retry wins again", async () => {
    const { deps } = setup();
    await sendAlbum(deps, "g4", ["m1"]);
    setAgentEntry(async () => {
      throw new Error("agent down");
    });
    await expect(handleAlbumFlush({ gid: "g4" }, batchEnv([]), T0 + 3000)).rejects.toThrow("agent down");
    const events: AlbumEvent[] = [];
    setAgentEntry(async (ev) => void events.push(ev));
    expect(await handleAlbumFlush({ gid: "g4" }, batchEnv([]), T0 + 3000)).toBe("delivered");
    expect(events).toHaveLength(1);
  });

  it("unknown group is acked without effect", async () => {
    expect(await handleAlbumFlush({ gid: "nope" }, batchEnv([]), T0 + 3000)).toBe("skipped");
  });
});
