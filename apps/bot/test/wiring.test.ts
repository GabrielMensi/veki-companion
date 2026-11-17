import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";

// Valores inventados solo para tests.
const db = (env as unknown as { DB: Env["DB"] }).DB;

function makeEnv(extra: Partial<Env> = {}): Env {
  return {
    DB: db,
    MEDIA: null,
    Q_UPDATES: { send: async () => {} },
    Q_JOBS: { send: async () => {} },
    TELEGRAM_BOT_TOKEN: "test-token",
    TG_WEBHOOK_SECRET: "test-secret-123",
    ALLOWED_CHAT_IDS: "1001:owner",
    ...extra,
  };
}

function ctx() {
  const pending: Promise<unknown>[] = [];
  return { ctx: { waitUntil: (p: Promise<unknown>) => void pending.push(p) }, pending };
}

describe("fetch routing", () => {
  it("routes /tg/webhook to the webhook handler (bad secret -> 401)", async () => {
    const res = await worker.fetch(
      new Request("https://bot.test/tg/webhook", { method: "POST", body: "{}" }),
      makeEnv(),
    );
    expect(res.status).toBe(401);
  });

  it("routes GET /public/catalog.json to the public handler", async () => {
    const res = await worker.fetch(new Request("https://bot.test/public/catalog.json"), makeEnv());
    expect(res.status).not.toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("returns 404 for unknown paths", async () => {
    const res = await worker.fetch(new Request("https://bot.test/nope"), makeEnv());
    expect(res.status).toBe(404);
  });
});

describe("scheduled dispatch", () => {
  const NOW = 1_800_000_000_000;

  it("*/15 cron reaches the rebuild path (calls the deploy hook when dirty)", async () => {
    await db.prepare("INSERT OR REPLACE INTO site_state (id, dirty_since, last_build_at, builds_day, builds_today) VALUES (1, ?, NULL, NULL, 0)").bind(NOW - 3_600_000).run();
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    try {
      const { ctx: c, pending } = ctx();
      await worker.scheduled({ cron: "*/15 * * * *", scheduledTime: NOW }, makeEnv({ DEPLOY_HOOK_URL: "https://hooks.test/deploy" }), c);
      await Promise.all(pending);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(calls).toEqual(["https://hooks.test/deploy"]);
    const st = await db.prepare("SELECT dirty_since FROM site_state WHERE id = 1").first<{ dirty_since: number | null }>();
    expect(st!.dirty_since).toBeNull();
  });

  it("0 9 * * * cron reaches its skeleton without rebuilding", async () => {
    await db.prepare("INSERT OR REPLACE INTO site_state (id, dirty_since, last_build_at, builds_day, builds_today) VALUES (1, ?, NULL, NULL, 0)").bind(NOW).run();
    let called = false;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("ok");
    }) as typeof fetch;
    try {
      const { ctx: c, pending } = ctx();
      await worker.scheduled({ cron: "0 9 * * *", scheduledTime: NOW }, makeEnv({ DEPLOY_HOOK_URL: "https://hooks.test/deploy" }), c);
      expect(pending).toHaveLength(1);
      await Promise.all(pending);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(called).toBe(false);
  });
});
