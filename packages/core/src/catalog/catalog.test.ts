import { describe, expect, it } from "vitest";
import { formatPrice, priceToColumn } from "./price";
import { normalizeText, searchProducts, type SearchItem } from "./search";
import { slugify, uniqueSlug } from "./slug";

describe("slugify", () => {
  it("quita tildes y ñ, pasa a minúsculas y une con guiones", () => {
    expect(slugify("Riñonera Girasol")).toBe("rinonera-girasol");
    expect(slugify("  ¡Mochila   Ñandú & Co.! ")).toBe("mochila-nandu-co");
    expect(slugify("CAFÉ àéîõü")).toBe("cafe-aeiou");
  });
  it("sin letras ni números cae en 'producto'; corta largo sin dejar guion final", () => {
    expect(slugify("¡¡¡")).toBe("producto");
    const s = slugify("a".repeat(59) + " bbbb");
    expect(s.length).toBeLessThanOrEqual(60);
    expect(s.endsWith("-")).toBe(false);
  });
});

describe("uniqueSlug", () => {
  it("devuelve la base si está libre y suma -2, -3 si no", () => {
    expect(uniqueSlug("rinonera", [])).toBe("rinonera");
    expect(uniqueSlug("rinonera", ["rinonera"])).toBe("rinonera-2");
    expect(uniqueSlug("rinonera", ["rinonera", "rinonera-2"])).toBe("rinonera-3");
    expect(uniqueSlug("rinonera", ["rinonera", "rinonera-3"])).toBe("rinonera-2");
  });
});

describe("price", () => {
  it("formatea con punto de miles", () => {
    expect(formatPrice(12500)).toBe("$12.500");
    expect(formatPrice(900)).toBe("$900");
    expect(formatPrice(1234567)).toBe("$1.234.567");
    expect(formatPrice("consultar")).toBe("precio a consultar");
    expect(formatPrice(null)).toBe("precio a consultar");
  });
  it("'consultar' se guarda como NULL", () => {
    expect(priceToColumn("consultar")).toBeNull();
    expect(priceToColumn(12500)).toBe(12500);
  });
});

const items: SearchItem[] = [
  { id: "1", name: "Riñonera Girasol", category: "riñoneras", variants: [{ design: "girasol", size: "", color: "lila" }] },
  { id: "2", name: "Mochila Mini", category: "mochilas", variants: [{ design: "", size: "chica", color: "Girasol amarillo" }] },
  { id: "3", name: "Neceser", category: "accesorios", variants: [] },
];

describe("search", () => {
  it("normaliza tildes, mayúsculas y símbolos", () => {
    expect(normalizeText("  ÑANDÚ, Rosa!! ")).toBe("nandu rosa");
  });
  it("ignora tildes y mayúsculas", () => {
    expect(searchProducts("RINONERA", items).map((i) => i.id)).toEqual(["1"]);
    expect(searchProducts("riñonera", items).map((i) => i.id)).toEqual(["1"]);
    expect(searchProducts("NÉCESER", items).map((i) => i.id)).toEqual(["3"]);
  });
  it("busca también en diseño, color y categoría; el nombre rankea primero", () => {
    expect(searchProducts("girasol", items).map((i) => i.id)).toEqual(["1", "2"]);
    expect(searchProducts("lila", items).map((i) => i.id)).toEqual(["1"]);
    expect(searchProducts("mochilas", items).map((i) => i.id)).toEqual(["2"]);
  });
  it("exige todas las palabras y tolera plural simple", () => {
    expect(searchProducts("girasol lila", items).map((i) => i.id)).toEqual(["1"]);
    expect(searchProducts("girasol verde", items)).toEqual([]);
    expect(searchProducts("riñoneras", items).map((i) => i.id)).toEqual(["1"]);
  });
  it("consulta vacía o solo símbolos no devuelve nada; respeta el límite", () => {
    expect(searchProducts("  !! ", items)).toEqual([]);
    expect(searchProducts("girasol", items, 1)).toHaveLength(1);
  });
});
