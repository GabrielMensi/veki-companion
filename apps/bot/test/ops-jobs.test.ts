import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BACKUP_TABLES, backupKey, runBackup, shouldKeep, type BackupBucket, type BackupFile } from "../src/jobs/backup";
import { runPurge } from "../src/jobs/purge";
import { handleCron, CRON_DAILY, CRON_EVERY_15_MIN } from "../src/cron";
import type { Env } from "../src/env";

// Datos inventados. El bucket es el R2 local del pool de Workers.
const e = env as unknown as { DB: Env["DB"]; MEDIA: R2Bucket };
const NOW = Date.UTC(2026, 10, 17, 12, 0, 0);
const DAY = 86_400_000;
const run = (sql: string, ...b: unknown[]) => e.DB.prepare(sql).bind(...b).run();
const count = async (sql: string, ...b: unknown[]) => (await e.DB.prepare(sql).bind(...b).first<{ n: number }>())!.n;
const bucket = e.MEDIA as unknown as BackupBucket;

async function clearBucket() {
  const l = await e.MEDIA.list();
  if (l.objects.length) await e.MEDIA.delete(l.objects.map((o) => o.key));
}

beforeEach(async () => {
  for (const t of ["event_log", "updates", "media", "variants", "products", "fairs", "nudge_policy", "conversations"]) await run(`DELETE FROM ${t}`);
  await clearBucket();
});

describe("backup a R2", () => {
  it("genera JSON válido con las tablas de negocio y sin las excluidas", async () => {
    await run("INSERT INTO products (id, slug, name, category, status, created_at, updated_at) VALUES ('p1', 'rinonera-x', 'Riñonera X', 'riñoneras', 'active', 1, 1)");
    await run("INSERT INTO variants (id, product_id, design, size, color, stock, updated_at) VALUES ('v1', 'p1', 'girasol', 'chica', 'lila', 3, 1)");
    await run("INSERT INTO fairs (id, name, place, starts_at, ends_at, created_at, updated_at) VALUES ('f1', 'Feria Inventada', 'Plaza', 1, 2, 1, 1)");
    await run("INSERT INTO nudge_policy (type, enabled) VALUES ('inactividad', 1)");
    await run("INSERT INTO conversations (chat_id, role, history, updated_at) VALUES (1, 'owner', '[\"TEXTO-PRIVADO\"]', 1)");
    await run("INSERT INTO updates (update_id, chat_id, kind, received_at) VALUES (1, 1, 'text', 1)");

    const r = await runBackup({ DB: e.DB, MEDIA: e.MEDIA }, NOW);
    expect(r.key).toBe("backups/2026-11-17.json");
    const obj = await e.MEDIA.get(r.key);
    expect(obj).not.toBeNull();
    const text = await obj!.text();
    const file = JSON.parse(text) as BackupFile; // JSON válido
    expect(file.version).toBe(1);
    expect(Object.keys(file.tables).sort()).toEqual([...BACKUP_TABLES].sort());
    expect(file.tables.products).toEqual([expect.objectContaining({ id: "p1", slug: "rinonera-x" })]);
    expect(file.tables.variants).toHaveLength(1);
    expect(file.tables.settings.length).toBeGreaterThan(0);
    expect(text).not.toContain("TEXTO-PRIVADO");
    expect(obj!.httpMetadata?.contentType).toBe("application/json");
    expect(await count("SELECT COUNT(*) AS n FROM event_log WHERE type = 'backup.done'")).toBe(1);
  });

  it("poda: borra los de más de 30 días salvo el día 1 de cada mes, ignora claves ajenas", async () => {
    for (const k of ["2026-09-20", "2026-10-01", "2026-10-10", "2026-11-16", "2026-11-17"]) await e.MEDIA.put(backupKey(k), "{}");
    await e.MEDIA.put("orig/2026/11/x.jpg", "img");
    const r = await runBackup({ DB: e.DB, MEDIA: e.MEDIA }, NOW);
    expect(r.pruned).toBe(2); // 2026-09-20 y 2026-10-10
    const keys = (await e.MEDIA.list()).objects.map((o) => o.key).sort();
    expect(keys).toEqual(["backups/2026-10-01.json", "backups/2026-11-16.json", "backups/2026-11-17.json", "orig/2026/11/x.jpg"]);
    expect(shouldKeep("2026-10-18", "2026-11-17")).toBe(true); // 30 días justos
    expect(shouldKeep("2026-10-17", "2026-11-17")).toBe(false); // 31 días
    expect(shouldKeep("2026-10-16", "2026-11-17")).toBe(false);
  });
});

describe("purga (docs/02 §2.5)", () => {
  it("borra updates > 14 d, event_log > 180 d y videos inbox sin usar > 30 d (con su objeto en R2)", async () => {
    await run("INSERT INTO updates (update_id, chat_id, kind, received_at) VALUES (1, 1, 'text', ?), (2, 1, 'text', ?)", NOW - 15 * DAY, NOW - 13 * DAY);
    await run("INSERT INTO event_log (id, ts, actor, type) VALUES ('old', ?, 'bot', 'x'), ('new', ?, 'bot', 'x')", NOW - 181 * DAY, NOW - 179 * DAY);
    await run("INSERT INTO products (id, slug, name, category, created_at, updated_at) VALUES ('p1', 's', 'n', 'otros', 1, 1)");
    const mk = (id: string, kind: string, status: string, product: string | null, age: number) =>
      run("INSERT INTO media (id, r2_key, kind, mime, product_id, status, created_at) VALUES (?, ?, ?, 'x/y', ?, ?, ?)", id, `orig/${id}`, kind, product, status, NOW - age * DAY);
    await mk("vOld", "video", "inbox", null, 31);
    await mk("vNew", "video", "inbox", null, 29);
    await mk("vUsed", "video", "attached", "p1", 90);
    await mk("pOld", "photo", "inbox", null, 90);
    for (const k of ["vOld", "vNew", "vUsed", "pOld"]) await e.MEDIA.put(`orig/${k}`, "bytes");

    const r = await runPurge({ DB: e.DB, MEDIA: e.MEDIA }, NOW);
    expect(r).toEqual({ updates: 1, events: 1, videos: 1 });
    expect(await count("SELECT COUNT(*) AS n FROM updates")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM event_log WHERE id IN ('old')")).toBe(0);
    const left = (await e.DB.prepare("SELECT id FROM media ORDER BY id").bind().all<{ id: string }>()).results.map((m) => m.id);
    expect(left).toEqual(["pOld", "vNew", "vUsed"]);
    expect(await e.MEDIA.head("orig/vOld")).toBeNull();
    expect(await e.MEDIA.head("orig/vNew")).not.toBeNull();
    expect(await count("SELECT COUNT(*) AS n FROM event_log WHERE type = 'purge.done'")).toBe(1);
  });
});

describe("cron diario", () => {
  it("0 9 * * *: hace backup y purga, y un paso que falla no frena al resto", async () => {
    const full = { DB: e.DB, MEDIA: e.MEDIA, ALLOWED_CHAT_IDS: "" } as unknown as Env;
    await handleCron(CRON_DAILY, full, NOW);
    expect(await e.MEDIA.head("backups/2026-11-17.json")).not.toBeNull();
    expect(await count("SELECT COUNT(*) AS n FROM event_log WHERE type = 'purge.done'")).toBe(1);

    const broken = { DB: e.DB, MEDIA: { put: async () => { throw new Error("r2 caído"); }, delete: async () => {}, list: async () => ({ objects: [], truncated: false }) }, ALLOWED_CHAT_IDS: "" } as unknown as Env;
    await handleCron(CRON_DAILY, broken, NOW + 1);
    expect(await count("SELECT COUNT(*) AS n FROM event_log WHERE type = 'cron.step_failed'")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM event_log WHERE type = 'purge.done'")).toBe(2);
  });
});

describe("cron cada 15 min", () => {
  const ADMIN = 31337;
  const full = () => ({ DB: e.DB, MEDIA: e.MEDIA, TELEGRAM_BOT_TOKEN: "t", ALLOWED_CHAT_IDS: `1:owner,${ADMIN}:admin`, DEPLOY_HOOK_URL: "https://hook.test/deploy" }) as unknown as Env;
  const realFetch = globalThis.fetch;
  let calls: { url: string; body: any }[] = [];
  beforeEach(async () => {
    calls = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: init?.body && typeof init.body === "string" && init.body.startsWith("{") ? JSON.parse(init.body) : null });
      return Response.json({ ok: true, result: { message_id: 1 } });
    }) as typeof fetch;
    await run("DELETE FROM settings WHERE key LIKE 'alert_last:%'");
    await run("DELETE FROM site_state");
    await run("INSERT INTO site_state (id, dirty_since, last_build_at) VALUES (1, NULL, NULL)");
  });
  afterEach(() => void (globalThis.fetch = realFetch));

  it("*/15: ejecuta scanAlerts (avisa al admin de un error reciente) y mantiene la reconstruccion", async () => {
    await run("INSERT INTO event_log (id, ts, actor, type, severity) VALUES ('e1', ?, 'bot', 'x', 'error')", NOW - 60_000);
    await run("UPDATE site_state SET dirty_since = ? WHERE id = 1", NOW - 3_600_000);
    await handleCron(CRON_EVERY_15_MIN, full(), NOW);
    const toAdmin = calls.filter((c) => c.url.includes("sendMessage") && c.body?.chat_id === ADMIN);
    expect(toAdmin).toHaveLength(1);
    expect(calls.filter((c) => c.url === "https://hook.test/deploy")).toHaveLength(1); // la reconstruccion sigue andando
  });

  it("*/15 respeta el tope de 30 min: una segunda pasada a los 15 min no repite la alerta", async () => {
    await run("INSERT INTO event_log (id, ts, actor, type, severity) VALUES ('e2', ?, 'bot', 'x', 'error')", NOW - 60_000);
    await handleCron(CRON_EVERY_15_MIN, full(), NOW);
    await handleCron(CRON_EVERY_15_MIN, full(), NOW + 15 * 60_000);
    expect(calls.filter((c) => c.url.includes("sendMessage"))).toHaveLength(1);
  });

  it("*/15: si scanAlerts falla queda en event_log y la reconstruccion igual corrio", async () => {
    await run("UPDATE site_state SET dirty_since = ? WHERE id = 1", NOW - 3_600_000);
    const broken = { ...full(), DB: new Proxy(e.DB, { get: (t, k) => (k === "prepare" ? (sql: string) => (sql.includes("severity = 'error'") ? { bind: () => ({ first: async () => { throw new Error("boom"); } }) } : t.prepare(sql)) : (t as any)[k]) }) } as unknown as Env;
    await handleCron(CRON_EVERY_15_MIN, broken, NOW);
    expect(calls.filter((c) => c.url === "https://hook.test/deploy")).toHaveLength(1);
    expect(await count("SELECT COUNT(*) AS n FROM event_log WHERE type = 'cron.step_failed'")).toBe(1);
  });
});
