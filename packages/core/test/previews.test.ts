import { describe, expect, it } from "vitest";
import { botonCallbackData, previewFor } from "../src";

describe("vistas previas sin ids ni JSON", () => {
  it("editar_producto muestra el nombre y el cambio de precio", () => {
    const t = previewFor("editar_producto", { producto_id: "prod-123", cambios: { price_ars: 15000 } }, null, { nombre: "Riñonera Girasol", precioActual: "$12.500" });
    expect(t).toContain("Riñonera Girasol");
    expect(t).toContain("Precio: $12.500 → $15.000");
    expect(t).not.toMatch(/prod-123|producto_id|cambios|[{}]/);
  });
  it("editar_producto sin poder leer el producto igual sale limpio", () => {
    const t = previewFor("editar_producto", { producto_id: "x1", cambios: { price_ars: 15000, status: "hidden" } }, null);
    expect(t).toContain("Precio: $15.000");
    expect(t).not.toMatch(/x1|producto_id|[{}]/);
  });
  it("deshacer y el resto no muestran argumentos", () => {
    expect(previewFor("deshacer", { accion_id: "abc" }, null)).not.toContain("abc");
    expect(previewFor("cambiar_stock", { variante_id: "v9", delta: -1 }, null)).not.toMatch(/v9|variante_id/);
  });
  it("botonCallbackData respeta los 64 bytes y deja pa:/sc: como están", () => {
    expect(botonCallbackData("pa:1:yes")).toBe("pa:1:yes");
    expect(botonCallbackData("sc:feria")).toBe("sc:feria");
    expect(new TextEncoder().encode(botonCallbackData("ñ".repeat(100))).length).toBeLessThanOrEqual(64);
  });
});
