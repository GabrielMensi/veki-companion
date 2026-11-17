import { formatPrecio } from "../copy/es-AR";

/** Precio para mostrar: `$12.500`; sin precio, "precio a consultar". Una sola implementación (la de `copy`). */
export const formatPrice: (p: number | "consultar" | null | undefined) => string = formatPrecio;

/** Precio del borrador → columna `products.price_ars` (`"consultar"` se guarda como NULL). */
export function priceToColumn(p: number | "consultar" | null | undefined): number | null {
  return typeof p === "number" ? Math.round(p) : null;
}
