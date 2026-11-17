# Restaurar un backup de D1 (runbook)

Los respaldos diarios (`backups/YYYY-MM-DD.json` en el bucket R2 `veki-media`, ver `docs/02-diseno.md` §6.4) tienen las tablas
`products`, `variants`, `media`, `fairs`, `settings` y `nudge_policy`. **No** incluyen `conversations`, `updates` ni
`event_log` (minimización de datos): después de restaurar, esas tablas arrancan vacías.

Antes de tocar nada: D1 Time Travel cubre los últimos 7 días (`wrangler d1 time-travel restore veki --timestamp=…`).
Usá este runbook cuando Time Travel no alcance o cuando quieras rearmar la base en otra cuenta.

Los comandos se corren desde `apps/bot/`. Para probar sin riesgo, agregá `--local` en lugar de `--remote`
(y, si querés aislar el estado, `--persist-to <carpeta>`). Los nombres de ejemplo son inventados.

## 1. Bajar el JSON

```sh
wrangler r2 object get veki-media/backups/2026-11-17.json --remote --file /tmp/backup.json
```

Chequeo rápido (tiene que imprimir `1`, la fecha y los conteos por tabla):

```sh
node -e 'const f=JSON.parse(require("fs").readFileSync("/tmp/backup.json"));console.log(f.version,f.day,Object.entries(f.tables).map(([k,v])=>k+":"+v.length).join(" "))'
```

## 2. Crear la base nueva y aplicar el esquema

```sh
wrangler d1 create veki-restore          # anotá el database_id y ponelo en un wrangler.toml aparte (binding DB)
wrangler d1 migrations apply veki-restore --remote
```

Las migraciones también cargan los `settings` por defecto; el paso 4 los pisa con los del backup.

## 3. Convertir el JSON en SQL

Genera un `INSERT OR REPLACE` por fila, en orden de claves foráneas (productos antes que variantes). Valida los
nombres de tabla y de columna, y escapa el texto.

```sh
node - /tmp/backup.json > /tmp/restore.sql <<'JS'
const fs = require("fs");
const TABLES = ["products", "variants", "media", "fairs", "settings", "nudge_policy"];
const file = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (file.version !== 1) throw new Error("versión de backup desconocida: " + file.version);
const lit = (v) => (v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : "'" + String(v).replace(/'/g, "''") + "'");
for (const t of TABLES) {
  for (const row of file.tables[t] ?? []) {
    const cols = Object.keys(row);
    if (!cols.every((c) => /^[a-z_][a-z0-9_]*$/.test(c))) throw new Error("columna inválida en " + t);
    console.log(`INSERT OR REPLACE INTO ${t} (${cols.join(", ")}) VALUES (${cols.map((c) => lit(row[c])).join(", ")});`);
  }
}
JS
wc -l /tmp/restore.sql
```

## 4. Cargar y verificar

```sh
wrangler d1 execute veki-restore --remote --file /tmp/restore.sql
wrangler d1 execute veki-restore --remote --command "SELECT 'products' t, COUNT(*) n FROM products UNION ALL SELECT 'variants', COUNT(*) FROM variants UNION ALL SELECT 'media', COUNT(*) FROM media UNION ALL SELECT 'fairs', COUNT(*) FROM fairs UNION ALL SELECT 'settings', COUNT(*) FROM settings UNION ALL SELECT 'nudge_policy', COUNT(*) FROM nudge_policy"
```

Los conteos tienen que coincidir con los del paso 1. Controlá también un producto a ojo
(`ops/queries/producto.sql`).

## 5. Poner la base restaurada en producción

1. En `apps/bot/wrangler.toml` apuntá `database_id` / `database_name` a la base nueva y desplegá.
2. Marcá el sitio como pendiente para que se reconstruya: `UPDATE site_state SET dirty_since = <ahora en ms> WHERE id = 1;`
   (si la fila no existe: `INSERT INTO site_state (id, dirty_since) VALUES (1, <ahora en ms>);`) y mandá `/reconstruir` desde el chat de admin.
3. Las fotos viven en R2 (`orig/…`), no en D1: no hay que restaurarlas mientras el bucket siga intacto.
4. Revisá `/estado` y `/avisos`: `nudge_policy` vuelve como estaba en el backup.

## Backup manual mensual

```sh
wrangler d1 export veki --remote --output veki-2026-11.sql
```
