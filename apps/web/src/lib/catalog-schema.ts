import { z } from "zod";

/**
 * Contrato de `GET /public/catalog.json` (docs/02-diseno.md §5.3).
 * Schema local de T21; T20 define el oficial en packages/core y lo reemplaza.
 * Sin stock numérico: la disponibilidad ya viene como estado público (§5.1).
 */
export const availabilitySchema = z.enum(["available", "last_units", "made_to_order"]);

export const variantSchema = z.object({
  id: z.string().min(1),
  design: z.string(),
  size: z.string(),
  color: z.string(),
  price_ars: z.number().int().nonnegative().nullable(),
  availability: availabilitySchema,
});

export const mediaSchema = z.object({
  id: z.string().min(1),
  position: z.number().int().nonnegative(),
  alt_text: z.string().min(1),
});

export const productSchema = z.object({
  id: z.string().min(1),
  slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  name: z.string().min(1),
  category: z.string().min(1),
  description: z.string().nullable(),
  price_ars: z.number().int().nonnegative().nullable(),
  featured: z.boolean(),
  updated_at: z.number().int(),
  variants: z.array(variantSchema),
  media: z.array(mediaSchema),
});

export const fairSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  place: z.string().min(1),
  address: z.string().nullable(),
  maps_url: z.url().nullable(),
  starts_at: z.number().int(),
  ends_at: z.number().int(),
});

export const catalogSchema = z.object({
  generated_at: z.number().int(),
  whatsapp_number: z.string().regex(/^\+?\d[\d\s-]{6,}$/),
  categories: z.array(z.object({ slug: z.string().min(1), label: z.string().min(1) })).min(1),
  products: z.array(productSchema),
  fairs: z.array(fairSchema),
});

export type Availability = z.infer<typeof availabilitySchema>;
export type Variant = z.infer<typeof variantSchema>;
export type Product = z.infer<typeof productSchema>;
export type Fair = z.infer<typeof fairSchema>;
export type Catalog = z.infer<typeof catalogSchema>;
