-- Corregir el precio de un producto y avisar al sitio que hay cambios. Editá slug y precio.
--   wrangler d1 execute veki --remote --file ops/queries/corregir-precio.sql
-- Mejor: pedirlo por el chat (queda en el registro y se puede deshacer).
UPDATE products SET price_ars = 12500, updated_at = CAST(strftime('%s','now') AS INTEGER) * 1000 WHERE slug = 'rinonera-girasol';
INSERT INTO site_state (id, dirty_since) VALUES (1, CAST(strftime('%s','now') AS INTEGER) * 1000)
  ON CONFLICT(id) DO UPDATE SET dirty_since = COALESCE(dirty_since, excluded.dirty_since);
