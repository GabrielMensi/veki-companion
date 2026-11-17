import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { BACKUP_TABLES, backupKey, runBackup, shouldKeep, type BackupBucket, type BackupFile } from "../src/jobs/backup";
import { runPurge } from "../src/jobs/purge";
import { handleCron, CRON_DAILY } from "../src/cron";
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
