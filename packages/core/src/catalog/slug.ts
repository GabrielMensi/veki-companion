/** Slug de producto: sin tildes ni símbolos, en minúsculas, con guiones (docs/02 §2.2: "rinonera-girasol"). */
export const MAX_SLUG = 60;

export function slugify(name: string): string {
  const s = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // ñ → n, á → a
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG)
    .replace(/-+$/g, "");
  return s || "producto";
}

/** Primer slug libre: `base`, `base-2`, `base-3`… `taken` son los slugs que ya existen. */
export function uniqueSlug(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}
