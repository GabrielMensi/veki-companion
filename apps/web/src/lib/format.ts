import type { Availability, Product, Variant } from "./catalog-schema";

const TZ = "America/Argentina/Buenos_Aires";

export function formatPrice(price: number | null): string {
  if (price === null) return "Consultar";
  return `$${price.toLocaleString("es-AR")}`;
}

export const AVAILABILITY_LABEL: Record<Availability, string> = {
  available: "Disponible",
  last_units: "Últimas unidades",
  made_to_order: "Por encargo",
};

export function variantLabel(v: Pick<Variant, "design" | "size" | "color">): string {
  return [v.design, v.size, v.color].filter(Boolean).join(" · ");
}

export function variantPrice(p: Pick<Product, "price_ars">, v: Pick<Variant, "price_ars">): number | null {
  return v.price_ars ?? p.price_ars;
}

export function formatFairDate(startsAt: number, endsAt: number): string {
  const day = new Intl.DateTimeFormat("es-AR", { timeZone: TZ, weekday: "long", day: "numeric", month: "long" });
  const hour = new Intl.DateTimeFormat("es-AR", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false });
  const sameDay = day.format(startsAt) === day.format(endsAt);
  return sameDay
    ? `${day.format(startsAt)}, de ${hour.format(startsAt)} a ${hour.format(endsAt)} h`
    : `${day.format(startsAt)} al ${day.format(endsAt)}`;
}
