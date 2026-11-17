import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { catalogSchema } from "@veki/core";
import { handlePublic, markSiteDirty, type PublicEnv } from "../src/public";
import { handleCron, rebuildIfDirty, CRON_EVERY_15_MIN } from "../src/cron";

const e = env as unknown as PublicEnv & { DB: D1Database; MEDIA: R2Bucket };
const NOW = Date.UTC(2026, 10, 17, 15, 0, 0);
const MIN = 60_000;
const HOOK = "https://hook.invalid/deploy";

async function seed() {
  await e.DB.batch([
    ...["site_state", "media", "variants", "products", "fairs"].map((t) => e.DB.prepare(`DELETE FROM ${t}`)),
    e.DB.prepare("UPDATE settings SET value = '\"5491100000000\"' WHERE key = 'whatsapp_number'"),
    e.DB.prepare("INSERT INTO products (id, slug, name, category, description, price_ars, status, featured, created_at, updated_at) VALUES ('P1','rinonera-girasol','Rinonera Girasol','riñoneras','Linda',12500,'active',1,1,2),('P2','cartera-oculta','Cartera Oculta','carteras',NULL,5000,'hidden',0,1,2)"),
    e.DB.prepare("INSERT INTO variants (id, product_id, design, size, color, price_ars, stock, status, updated_at) VALUES ('V1','P1','girasol','chica','lila',NULL,1,'active',1),('V2','P1','girasol','grande','azul',9,0,'active',1),('V3','P1','girasol','media','rojo',9,5,'active',1),('V4','P1','x','x','x',9,5,'archived',1),('V5','P2','a','b','c',9,5,'active',1)"),
    e.DB.prepare("INSERT INTO media (id, r2_key, kind, mime, product_id, position, alt_text, status, created_at) VALUES ('M1','orig/m1.jpg','photo','image/jpeg','P1',0,'Foto 1','attached',1),('M2','orig/m2.jpg','photo','image/jpeg','P2',0,'Oculta','attached',1),('M3','orig/m3.jpg','photo','image/jpeg',NULL,NULL,NULL,'inbox',1)"),
    e.DB.prepare("INSERT INTO fairs (id, name, place, starts_at, ends_at, status, public, created_at, updated_at) VALUES ('F1','Feria','Plaza',?,?,'confirmed',1,1,1),('F2','Vieja','Plaza',1,2,'confirmed',1,1,1),('F3','Privada','Casa',?,?,'confirmed',0,1,1),('F4','Cancelada','Plaza',?,?,'cancelled',1,1,1)")
      .bind(NOW + 1000, NOW + 2000, NOW + 1000, NOW + 2000, NOW + 1000, NOW + 2000),
  ]);
  for (const k of ["orig/m1.jpg", "orig/m2.jpg", "orig/m3.jpg"]) await e.MEDIA.put(k, `bytes-${k}`);
}
const get = (path: string) => handlePublic(new Request(`https://x.test${path}`), e, NOW)!;

describe("GET /public/catalog.json", () => {
  beforeEach(seed);

  it("solo trae productos active, sin stock numerico, y valida el schema", async () => {
    const res = await get("/public/catalog.json");
    expect(res.status).toBe(200);
    const body = await res.json();
    const cat = catalogSchema.parse(body);
    expect(cat.products.map((p) => p.id)).toEqual(["P1"]);
    expect(cat.whatsapp_number).toBe("5491100000000");
    expect(cat.products[0]!.category).toBe("rinoneras");
    expect(cat.products[0]!.variants.map((v) => v.availability).sort()).toEqual(["available", "last_units", "made_to_order"]);
    expect(JSON.stringify(body)).not.toMatch(/stock/);
    expect(cat.products[0]!.media.map((m) => m.id)).toEqual(["M1"]);
    expect(cat.fairs.map((f) => f.id)).toEqual(["F1"]);
  });

  it("un producto hidden no aparece (ni sus variantes ni fotos)", async () => {
    const text = await (await get("/public/catalog.json")).text();
    expect(text).not.toContain("cartera-oculta");
    expect(text).not.toContain("M2");
    expect(text).not.toContain("V5");
  });

  it("sin numero de WhatsApp responde 503 en vez de un catalogo roto", async () => {
    await e.DB.prepare("UPDATE settings SET value = '\"\"' WHERE key = 'whatsapp_number'").run();
    expect((await get("/public/catalog.json")).status).toBe(503);
  });
});

describe("GET /public/media/:id", () => {
  beforeEach(seed);

  it("sirve la foto de un producto active con Cache-Control largo", async () => {
    const res = await get("/public/media/M1");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("cache-control")).toMatch(/max-age=31536000/);
    expect(await res.text()).toBe("bytes-orig/m1.jpg");
  });

  it("media de un producto hidden -> 404", async () => {
    expect((await get("/public/media/M2")).status).toBe(404);
  });

  it("media sin adjuntar o inexistente -> 404", async () => {
    expect((await get("/public/media/M3")).status).toBe(404);
    expect((await get("/public/media/NOPE")).status).toBe(404);
  });

  it("ignora paths que no son publicos", async () => {
    expect(await handlePublic(new Request("https://x.test/webhook"), e, NOW)).toBeNull();
  });
});

describe("cron de reconstruccion", () => {
  const cronEnv = { DB: e.DB, DEPLOY_HOOK_URL: HOOK };
  const ok = () => vi.fn(async () => new Response("{}", { status: 200 }));
  beforeEach(seed);

  it("dirty_since con ventana cumplida -> exactamente 1 llamada y limpia dirty_since", async () => {
    await e.DB.prepare("INSERT INTO site_state (id, dirty_since, last_build_at) VALUES (1, ?, ?)").bind(NOW - 20 * MIN, NOW - 30 * MIN).run();
    const f = ok();
    expect((await rebuildIfDirty(cronEnv, NOW, { fetchFn: f })).status).toBe("called");
    expect((await rebuildIfDirty(cronEnv, NOW + 15 * MIN, { fetchFn: f })).status).toBe("skipped");
    expect(f).toHaveBeenCalledTimes(1);
    expect(f).toHaveBeenCalledWith(HOOK, { method: "POST" });
    const st = await e.DB.prepare("SELECT dirty_since, builds_today FROM site_state").first<any>();
    expect(st).toEqual({ dirty_since: null, builds_today: 1 });
  });

  it("sin cambios o dentro de la ventana de 10 min no llama", async () => {
    const f = ok();
    expect((await rebuildIfDirty(cronEnv, NOW, { fetchFn: f })).status).toBe("skipped");
    await markSiteDirty(e.DB, NOW - 1 * MIN);
    await e.DB.prepare("UPDATE site_state SET last_build_at = ?").bind(NOW - 5 * MIN).run();
    expect(await rebuildIfDirty(cronEnv, NOW, { fetchFn: f })).toEqual({ status: "skipped", reason: "window" });
    expect(f).not.toHaveBeenCalled();
  });

  it("respeta el tope diario, tambien con force; al dia siguiente se reinicia", async () => {
    await e.DB.prepare("UPDATE settings SET value = '2' WHERE key = 'max_builds_per_day'").run();
    const f = ok();
    let t = NOW;
    for (let i = 0; i < 4; i++) {
      await markSiteDirty(e.DB, t);
      await rebuildIfDirty(cronEnv, t, { fetchFn: f, force: i === 3 });
      t += 11 * MIN;
    }
    expect(f).toHaveBeenCalledTimes(2);
    await markSiteDirty(e.DB, t);
    expect(await rebuildIfDirty(cronEnv, NOW + 24 * 3600_000, { fetchFn: f })).toEqual({ status: "called" });
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("si el hook falla, el cambio sigue pendiente y queda en el registro", async () => {
    await markSiteDirty(e.DB, NOW - 20 * MIN);
    const f = vi.fn(async () => new Response("no", { status: 500 }));
    expect((await rebuildIfDirty(cronEnv, NOW, { fetchFn: f })).status).toBe("failed");
    const st = await e.DB.prepare("SELECT dirty_since FROM site_state").first<any>();
    expect(st.dirty_since).toBe(NOW - 20 * MIN);
    const log = await e.DB.prepare("SELECT type FROM event_log WHERE type = 'site.rebuild_failed'").first();
    expect(log).not.toBeNull();
  });

  it("sin DEPLOY_HOOK_URL no llama y handleCron despacha el cron de 15 min", async () => {
    await markSiteDirty(e.DB, NOW - 20 * MIN);
    await handleCron(CRON_EVERY_15_MIN, { DB: e.DB }, NOW);
    expect((await e.DB.prepare("SELECT dirty_since FROM site_state").first<any>()).dirty_since).toBe(NOW - 20 * MIN);
  });
});
