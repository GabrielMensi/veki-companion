/** Helpers puros para el CTA de WhatsApp (docs/02-diseno.md §5.2). */

export interface WaMessageInput {
  product: string;
  /** Variante legible, p. ej. "girasol · chica · lila". Opcional. */
  variant?: string;
  /** Precio ya formateado, p. ej. "$12.500". Opcional ("consultar" no lleva precio). */
  price?: string;
  /** URL pública de la página del producto. */
  url: string;
}

/** Mensaje prellenado: "¡Hola Veky! Me interesa {producto}{ — variante} ({precio}) que vi en la web: {url}". */
export function waMessage({ product, variant, price, url }: WaMessageInput): string {
  const variantPart = variant ? ` — ${variant}` : "";
  const pricePart = price ? ` (${price})` : "";
  return `¡Hola Veky! Me interesa ${product}${variantPart}${pricePart} que vi en la web: ${url}`;
}

/** `https://wa.me/{numero}?text={encodeURIComponent(msg)}`. El número se normaliza a solo dígitos. */
export function waLink(number: string, message?: string): string {
  const digits = number.replace(/\D/g, "");
  if (digits.length === 0) {
    throw new Error("waLink: número de WhatsApp vacío o inválido");
  }
  const base = `https://wa.me/${digits}`;
  return message ? `${base}?text=${encodeURIComponent(message)}` : base;
}
