-- Ver un producto con sus variantes y fotos. Uso:
--   wrangler d1 execute veki --remote --file ops/queries/producto.sql
-- Cambiá el slug de abajo.
SELECT p.id, p.slug, p.name, p.status, p.price_ars,
       v.id AS variant_id, v.design, v.size, v.color, v.stock,
       (SELECT COUNT(*) FROM media m WHERE m.product_id = p.id AND m.status = 'attached') AS fotos
FROM products p
LEFT JOIN variants v ON v.product_id = p.id AND v.status = 'active'
WHERE p.slug = 'rinonera-girasol';
