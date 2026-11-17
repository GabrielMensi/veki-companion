-- Últimos errores y avisos del registro (sin el campo data: puede tener detalles internos).
--   wrangler d1 execute veki --remote --file ops/queries/errores-recientes.sql
SELECT datetime(ts / 1000, 'unixepoch', '-3 hours') AS hora_art, severity, type, entity, entity_id
FROM event_log
WHERE severity IN ('warn', 'error')
ORDER BY ts DESC
LIMIT 50;
