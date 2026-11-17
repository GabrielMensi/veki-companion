import { describe, expect, it } from "vitest";
import fixture from "../src/fixtures/catalog.fixture.json";
import { parseCatalog } from "../src/lib/catalog";
import { AVAILABILITY_LABEL, formatPrice, variantLabel } from "../src/lib/format";

describe("catálogo", () => {
  it("el fixture valida contra el schema", () => {
    expect(parseCatalog(fixture, "fixture").products.length).toBeGreaterThan(0);
  });

  it("falla (y por lo tanto el build) si el catálogo no valida", () => {
    const broken = structuredClone(fixture) as any;
    broken.products[0].price_ars = "mucho";
    delete broken.whatsapp_number;
    expect(() => parseCatalog(broken, "fixture")).toThrow(/no valida su schema/);
  });

  it("rechaza una disponibilidad numérica (sin conteo de stock)", () => {
    const broken = structuredClone(fixture) as any;
    broken.products[0].variants[0].availability = 3;
    expect(() => parseCatalog(broken, "x")).toThrow();
  });
});

describe("format", () => {
  it("precio null es Consultar", () => {
    expect(formatPrice(null)).toBe("Consultar");
    expect(formatPrice(12500)).toBe("$12.500");
  });
  it("etiquetas de disponibilidad", () => {
    expect(Object.values(AVAILABILITY_LABEL)).toEqual(["Disponible", "Últimas unidades", "Por encargo"]);
  });
  it("une solo las partes presentes", () => {
    expect(variantLabel({ design: "luna", size: "", color: "lila" })).toBe("luna · lila");
  });
});
