/** Búsqueda de productos sin tildes ni mayúsculas (D1 `LIKE` no normaliza tildes, así que se filtra acá). */

export type SearchVariant = { design: string; size: string; color: string };
export type SearchItem = { id: string; name: string; category: string; variants: SearchVariant[] };

export function normalizeText(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Palabras de la consulta; quita la "s" final de las largas para que "riñoneras" encuentre "Riñonera". */
function tokens(query: string): string[] {
  return normalizeText(query)
    .split(" ")
    .filter(Boolean)
    .map((t) => (t.length > 3 && t.endsWith("s") ? t.slice(0, -1) : t));
}

/**
 * Productos que contienen TODAS las palabras en nombre, categoría o variantes. Orden: más coincidencias en el
 * nombre primero; a igualdad, el orden original. Sin palabras útiles devuelve `[]`.
 */
export function searchProducts<T extends SearchItem>(query: string, items: T[], limit = 8): T[] {
  const words = tokens(query);
  if (words.length === 0) return [];
  const scored: { item: T; score: number; i: number }[] = [];
  items.forEach((item, i) => {
    const name = normalizeText(item.name);
    const rest = normalizeText([item.category, ...item.variants.flatMap((v) => [v.design, v.size, v.color])].join(" "));
    let score = 0;
    for (const w of words) {
      if (name.includes(w)) score += 3;
      else if (rest.includes(w)) score += 1;
      else return;
    }
    scored.push({ item, score, i });
  });
  return scored.sort((a, b) => b.score - a.score || a.i - b.i).slice(0, limit).map((s) => s.item);
}
