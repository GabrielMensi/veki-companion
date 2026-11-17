import { describe, expect, it } from "vitest";
import fixture from "../../../../apps/web/src/fixtures/catalog.fixture.json";
import { availabilityFromStock, catalogSchema, categorySlug } from "./catalog-schema";

describe("catalog-schema", () => {
  it("el fixture del sitio valida contra el schema", () => {
    expect(catalogSchema.parse(fixture).products.length).toBeGreaterThan(0);
  });
  it("rechaza stock numérico y falta de número de WhatsApp", () => {
    const bad = structuredClone(fixture) as any;
    bad.products[0].variants[0].availability = 2;
    expect(catalogSchema.safeParse(bad).success).toBe(false);
    const noWa = structuredClone(fixture) as any;
    noWa.whatsapp_number = "";
    expect(catalogSchema.safeParse(noWa).success).toBe(false);
  });
  it("disponibilidad pública desde el stock", () => {
    expect([null, 0, 1, 2].map(availabilityFromStock)).toEqual(["made_to_order", "made_to_order", "last_units", "available"]);
  });
  it("slug de categoría sin tildes ni ñ", () => {
    expect(categorySlug("Riñoneras")).toBe("rinoneras");
    expect(categorySlug("riñoneras")).toBe("rinoneras");
  });
});
