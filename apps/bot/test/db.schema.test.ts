import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { tables, settingSchemas, ulid, isUlid, type TableName } from "@veki/core";

const db = (env as unknown as { DB: D1Database }).DB;

function zodColumns(name: TableName): string[] {
  const t = tables[name] as unknown as { shape?: Record<string, unknown>; _def: { schema?: { shape: Record<string, unknown> } } };
  return Object.keys(t.shape ?? t._def.schema!.shape).sort();
}

describe("D1 schema vs zod", () => {
  it("covers every table in the migration", async () => {
    const { results } = await db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations' ORDER BY name")
      .all<{ name: string }>();
    expect(results.map((r) => r.name).sort()).toEqual(Object.keys(tables).sort());
  });

  for (const name of Object.keys(tables) as TableName[]) {
    it(`columns of ${name} match PRAGMA table_info`, async () => {
      const { results } = await db.prepare(`PRAGMA table_info(${name})`).all<{ name: string }>();
      expect(results.map((r) => r.name).sort()).toEqual(zodColumns(name));
    });
  }

  it("seeded settings validate", async () => {
    const { results } = await db.prepare("SELECT key, value FROM settings").all<{ key: string; value: string }>();
    expect(results.map((r) => r.key).sort()).toEqual(Object.keys(settingSchemas).sort());
    for (const r of results) {
      expect(() => settingSchemas[r.key as keyof typeof settingSchemas].parse(JSON.parse(r.value))).not.toThrow();
    }
  });

  it("generates sortable ULIDs", () => {
    const a = ulid(1_700_000_000_000);
    const b = ulid(1_700_000_001_000);
    expect(isUlid(a)).toBe(true);
    expect(a < b).toBe(true);
  });
});
