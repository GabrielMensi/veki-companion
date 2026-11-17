-- Mover una foto a otro producto (queda al final de la galería). Editá los dos ids.
--   wrangler d1 execute veki --remote --file ops/queries/mover-foto.sql
UPDATE media
SET product_id = 'ID_PRODUCTO_NUEVO',
    status = 'attached',
    position = COALESCE((SELECT MAX(position) + 1 FROM media WHERE product_id = 'ID_PRODUCTO_NUEVO'), 0)
WHERE id = 'ID_FOTO';
INSERT INTO site_state (id, dirty_since) VALUES (1, CAST(strftime('%s','now') AS INTEGER) * 1000)
  ON CONFLICT(id) DO UPDATE SET dirty_since = COALESCE(dirty_since, excluded.dirty_since);
