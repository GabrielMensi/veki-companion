-- Settings de producción que hay que cambiar respecto del seed de migrations/0001_init.sql.
-- Idempotente: se puede correr de nuevo sin efectos extra (INSERT ... ON CONFLICT(key) DO UPDATE).
-- Solo se incluye lo que de verdad difiere del seed: el resto queda con los valores por defecto de 0001.
--
-- Uso (desde apps/bot). NO commitear un archivo con el número real: ver ops/DEPLOY.md, paso 5.
--   wrangler d1 execute veki --remote --file ../../ops/queries/seed-settings.sql
--
-- CHANGE-ME: reemplazar por el número público de WhatsApp de la tienda ANTES de correr este archivo.
-- Formato: solo dígitos con código de país, sin "+" ni espacios (p. ej. 54 + área + número), dentro de comillas JSON.
-- Mientras quede CHANGE-ME el valor no pasa el schema del catálogo (packages/core/src/public/catalog-schema.ts:
-- whatsapp_number exige dígitos). Verificalo en el smoke test del runbook antes de dar el sitio por bueno.
INSERT INTO settings (key, value) VALUES
  ('whatsapp_number', '"CHANGE-ME"')
ON CONFLICT(key) DO UPDATE SET value = excluded.value;
