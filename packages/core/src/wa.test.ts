import { describe, expect, it } from "vitest";
import { waLink, waMessage } from "./wa";

describe("waLink", () => {
  it("codifica tildes y signos de apertura", () => {
    expect(waLink("5491112345678", "¡Hola! ¿Está?")).toBe(
      "https://wa.me/5491112345678?text=%C2%A1Hola!%20%C2%BFEst%C3%A1%3F",
    );
  });

  it("codifica la ñ", () => {
    const url = waLink("5491112345678", "riñonera pequeña");
    expect(url).toContain("ri%C3%B1onera%20peque%C3%B1a");
  });

  it("codifica & para no cortar el query string", () => {
    const url = waLink("5491112345678", "bolsos & neceseres");
    expect(url).toContain("bolsos%20%26%20neceseres");
    expect(new URL(url).searchParams.get("text")).toBe("bolsos & neceseres");
  });

  it("ida y vuelta con todo junto", () => {
    const msg = "¡Hola Veky! Cartera “Ñandú” & más — ($1.500)";
    expect(new URL(waLink("5491112345678", msg)).searchParams.get("text")).toBe(msg);
  });

  it("normaliza el número a dígitos", () => {
    expect(waLink("+54 9 11 1234-5678")).toBe("https://wa.me/5491112345678");
  });

  it("falla con número vacío", () => {
    expect(() => waLink("abc", "x")).toThrow();
  });
});

describe("waMessage", () => {
  it("arma el mensaje con variante y precio", () => {
    expect(
      waMessage({ product: "Riñonera Girasol", variant: "chica · lila", price: "$12.500", url: "https://veky.pages.dev/p/rinonera-girasol/" }),
    ).toBe("¡Hola Veky! Me interesa Riñonera Girasol — chica · lila ($12.500) que vi en la web: https://veky.pages.dev/p/rinonera-girasol/");
  });

  it("omite variante y precio si no hay", () => {
    expect(waMessage({ product: "Cartera", url: "https://x/p/c/" })).toBe(
      "¡Hola Veky! Me interesa Cartera que vi en la web: https://x/p/c/",
    );
  });
});
