# Desplegar E1 (runbook)

Despliegue de la etapa 1 (`docs/03-plan-implementacion.md`, T24): Worker del bot con D1, R2 y colas, sitio en Cloudflare
Pages y webhook de Telegram. Los pasos se corren desde `apps/bot/` salvo que digan otra cosa.

**Antes de empezar:** el código de E1 tiene que estar en `main` (merge aprobado por Gabriel). El build de Pages sale de `main`,
y `wrangler deploy` despliega lo que tengas en tu checkout, así que desplegá desde un checkout de `main`.

Cada paso dice quién lo corre y si toca Cloudflare o Telegram:

- **Quién:** Gabriel, o Gabriel + ella (cuando hace falta su celular).
- **Toca Cloudflare / Telegram:** sí o no. Los pasos que tocan una cuenta real son los que hay que hacer con cuidado.

Ningún comando de este runbook imprime un secreto. Los valores de producción salen del `.env` del árbol principal
(`/home/gabrielmensi/personal-projects/veki-companion/.env`), en el bloque `PROD`, que está comentado. **Leelos ahí y no los
pegues en ningún chat ni en ningún archivo del repo.**

## 0. Lo que hay que tener a mano

Checklist antes del paso 1 (detalle al final, en "Lo que hay que darle al despliegue"):

- [ ] Cuenta de Cloudflare (plan Free) con D1, R2 (`veki-media`) y colas habilitados (U1).
- [ ] Bot de producción creado con BotFather; `TELEGRAM_BOT_TOKEN` en el bloque `PROD` del `.env` principal (U2).
- [ ] Chat ids de ella y de Gabriel (para `ALLOWED_CHAT_IDS`, paso 7).
- [ ] Número público de WhatsApp de la tienda, solo dígitos con código de país (paso 5).
- [ ] Clave de Groq (`GROQ_API_KEY`) en el bloque `PROD`.
- [ ] Repo conectado a un proyecto de Pages (paso 9).

## 1. Herramientas y login

**Quién:** Gabriel · **Toca Cloudflare:** sí (login) · **Toca Telegram:** no

```sh
npx wrangler --version      # solo versión; no toca la cuenta
```

El login abre el navegador, así que lo corre Gabriel en su propia terminal (en la sesión de Claude, con `! <comando>`):

```sh
npx wrangler login
```

## 2. Base D1 `veki`

**Quién:** Gabriel · **Toca Cloudflare:** sí · **Toca Telegram:** no

```sh
npx wrangler d1 create veki
```

El comando imprime un `database_id`. Copialo en `apps/bot/wrangler.toml`, en el bloque `[[d1_databases]]`:

```toml
database_id = "<id-que-imprimió-wrangler>"
```

El id de D1 **no es secreto**, así que sí se puede commitear. Commitealo junto con el resto de los cambios de `wrangler.toml`
(en un PR a `develop`, como cualquier cambio de código).

## 3. Bucket R2 `veki-media`

**Quién:** Gabriel · **Toca Cloudflare:** sí · **Toca Telegram:** no

R2 ya está habilitado en la cuenta (U1). Verificá que el bucket exista; solo si no aparece, crealo:

```sh
npx wrangler r2 bucket list
npx wrangler r2 bucket create veki-media      # solo si falta
```

Las fotos y los respaldos van a `veki-media` (ver `docs/02-diseno.md` §2.5 y §6.4). No hace falta un token R2 para E1:
el prefirmado es de E3.

## 4. Colas `q-updates` y `q-jobs`

**Quién:** Gabriel · **Toca Cloudflare:** sí · **Toca Telegram:** no

```sh
npx wrangler queues create q-updates
npx wrangler queues create q-jobs
```

Los productores y consumidores ya están en `wrangler.toml` (`max_batch_size` y `max_concurrency` de cada cola). No hay que
configurarlos a mano.

## 5. Migraciones y settings de producción

**Quién:** Gabriel · **Toca Cloudflare:** sí · **Toca Telegram:** no

Migraciones (aplica `migrations/` a la base remota):

```sh
npx wrangler d1 migrations apply veki --remote
```

Settings: `ops/queries/seed-settings.sql` trae el número de WhatsApp como `CHANGE-ME`. El número real **no se commitea**: se
inyecta en un archivo temporal fuera del repo, que se borra al terminar.

```sh
read -rs WA_NUMBER && export WA_NUMBER      # escribí el número (solo dígitos, con código de país); no se muestra
sed "s/CHANGE-ME/${WA_NUMBER}/" ../../ops/queries/seed-settings.sql > "$HOME/veki-seed-settings.sql"
if grep -q CHANGE-ME "$HOME/veki-seed-settings.sql"; then
  echo "falta el número"
else
  npx wrangler d1 execute veki --remote --file "$HOME/veki-seed-settings.sql"
fi
rm -f "$HOME/veki-seed-settings.sql"
unset WA_NUMBER
```

Verificación sin mostrar el número:

```sh
npx wrangler d1 execute veki --remote --command "SELECT key FROM settings WHERE key = 'whatsapp_number' AND value NOT LIKE '%CHANGE-ME%'"
```

Tiene que devolver una fila. Si no, el seed no se aplicó.

## 6. Secretos del Worker (`wrangler secret put`)

**Quién:** Gabriel · **Toca Cloudflare:** sí · **Toca Telegram:** no (el token se usa en el paso 10, no acá)

La forma de cargar cada secreto es **siempre por stdin, desde una variable de entorno**, nunca con el valor escrito en la línea
de comandos (quedaría en el historial de la shell). Primero cargá la variable sin imprimirla, por ejemplo con
`read -rs NOMBRE && export NOMBRE` y pegando el valor del bloque `PROD`:

```sh
printf '%s' "$NOMBRE_DE_LA_VARIABLE" | npx wrangler secret put NOMBRE_DEL_SECRETO
```

Secretos que el código lee hoy (`apps/bot/src/env.ts`):

| Secreto | De dónde sale | Obligatorio en E1 |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Bloque `PROD` del `.env` | Sí |
| `TG_WEBHOOK_SECRET` | Lo genera este paso (abajo) | Sí |
| `GROQ_API_KEY` | Bloque `PROD` del `.env` | Sí (chat y voz) |
| `GEMINI_API_KEY` | Bloque `PROD` del `.env` | **No se carga en E1.** Está declarada en `env.ts`, pero hoy el bot no la pasa a ningún proveedor; se carga cuando se conecte el respaldo |
| `ALLOWED_CHAT_IDS` | Línea `ALLOWED_CHAT_IDS=` del `.env` del árbol principal (paso 7) | Sí |
| `DEPLOY_HOOK_URL` | Paso 9 (Pages) | Sí, para que el sitio se reconstruya. Sin él, el cron se salta el build |

Ejemplos:

```sh
read -rs TELEGRAM_BOT_TOKEN && export TELEGRAM_BOT_TOKEN          # pegá el valor del bloque PROD
printf '%s' "$TELEGRAM_BOT_TOKEN" | npx wrangler secret put TELEGRAM_BOT_TOKEN

read -rs GROQ_API_KEY && export GROQ_API_KEY                     # pegá el valor del bloque PROD
printf '%s' "$GROQ_API_KEY" | npx wrangler secret put GROQ_API_KEY
```

**`TG_WEBHOOK_SECRET`** lo genera el runbook. Es el mismo valor que va en `setWebhook` (paso 10), y Telegram lo manda de vuelta
en cada update para que el Worker lo valide:

```sh
export TG_WEBHOOK_SECRET="$(openssl rand -hex 32)"               # no lo imprimas
printf '%s' "$TG_WEBHOOK_SECRET" | npx wrangler secret put TG_WEBHOOK_SECRET
# Guardalo también en el .env del árbol principal (gitignored), para no perderlo:
printf 'TG_WEBHOOK_SECRET=%s\n' "$TG_WEBHOOK_SECRET" >> /home/gabrielmensi/personal-projects/veki-companion/.env
```

Si ya existe una línea `TG_WEBHOOK_SECRET=` en el `.env`, editala en lugar de agregar otra.

**No cargar en E1** (son de etapas posteriores, y el código todavía no los lee): `GITHUB_DISPATCH_TOKEN`, `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY` (ver `docs/02-diseno.md` §6.3).

## 7. `ALLOWED_CHAT_IDS`

**Quién:** Gabriel, con ella · **Toca Cloudflare:** no (se usa en el paso 8) · **Toca Telegram:** no

Formato: `id:rol`, separados por coma. `owner` es ella; `admin` es Gabriel (recibe los avisos y el resumen diario, y tiene los
comandos de admin). Un id sin rol es `owner`.

Es un **secret**, no una var del Worker: el repo es público y los chat ids son datos personales. Ponelo en el `.env` del
árbol principal (gitignored), sin escribirlo en ningún archivo versionado:

```sh
ALLOWED_CHAT_IDS=<id-de-ella>:owner,<id-de-gabriel>:admin
```

Cargalo igual que los otros secretos (paso 6), por stdin y sin imprimirlo:

```sh
read -rs ALLOWED_CHAT_IDS && export ALLOWED_CHAT_IDS             # pegá el valor de la línea del .env
printf '%s' "$ALLOWED_CHAT_IDS" | npx wrangler secret put ALLOWED_CHAT_IDS
unset ALLOWED_CHAT_IDS
```

Para desarrollo local, la misma línea va en `apps/bot/.dev.vars` (gitignored).

Un chat que no está en la lista no recibe respuesta (`docs/02-diseno.md` §3.5): el Worker responde 200 y no encola nada.

## 8. Desplegar el Worker

**Quién:** Gabriel · **Toca Cloudflare:** sí · **Toca Telegram:** no

```sh
npx wrangler deploy
```

Al terminar imprime la URL del Worker, con la forma `https://veki-bot.<subdominio>.workers.dev`. Anotala: la usan los pasos 9,
10 y 11.

Chequeo de humo sin secretos (el catálogo público debe responder JSON; un 500 o un JSON con `whatsapp_number` vacío
indica que el paso 5 no se aplicó):

```sh
curl -s -o /dev/null -w '%{http_code}\n' https://veki-bot.<subdominio>.workers.dev/public/catalog.json
```

## 9. Sitio en Cloudflare Pages

**Quién:** Gabriel · **Toca Cloudflare:** sí · **Toca Telegram:** no

1. **Crear el proyecto.** Conectá el repo de GitHub. Rama de producción: **`main`**. Desactivá los despliegues de preview
   (solo `main` despliega).
2. **Build.** Directorio raíz: `/` (el repo). Comando de build: `npm ci && npm run build -w @veki/web`. Directorio de salida:
   `apps/web/dist`.
3. **Variables de entorno de Pages** (en el build, no en el Worker):

   | Variable | Valor |
   |---|---|
   | `CATALOG_URL` | `https://veki-bot.<subdominio>.workers.dev/public/catalog.json` |
   | `SITE_URL` | `https://<proyecto>.pages.dev` (la URL que muestra Pages) |
   | `NODE_VERSION` | `22` (el repo pide Node >= 22) |

   **Si falta `CATALOG_URL`, el build usa el fixture** (productos de prueba), sin avisar. Si el sitio muestra productos que no
   cargaste, revisá esta variable antes que nada.
4. **Deploy hook.** En el proyecto: *Settings → Builds & deployments → Deploy hooks*. Creá uno para la rama `main` y copiá la
   URL. Esa URL la puede usar cualquiera que la tenga: tratala como secreto.
5. Cargá la URL como secreto del Worker (paso 6):

   ```sh
   read -rs DEPLOY_HOOK_URL && export DEPLOY_HOOK_URL
   printf '%s' "$DEPLOY_HOOK_URL" | npx wrangler secret put DEPLOY_HOOK_URL
   ```

6. Esperá el primer build de Pages en verde. El sitio queda en `https://<proyecto>.pages.dev`.

## 10. Registrar el webhook de Telegram

**Quién:** Gabriel · **Toca Cloudflare:** no · **Toca Telegram:** sí (`setWebhook`)

El script `apps/bot/scripts/set-webhook.ts` lee `TELEGRAM_BOT_TOKEN`, `TG_WEBHOOK_SECRET` y `WORKER_URL` del entorno. Nunca
imprime el token, el secret ni la URL completa de la API de Telegram.

```sh
export WORKER_URL="https://veki-bot.<subdominio>.workers.dev"   # sin ruta
# TELEGRAM_BOT_TOKEN y TG_WEBHOOK_SECRET ya están exportados desde el paso 6 (si no, cargalos igual que ahí)

npm run webhook:set -- --dry-run     # muestra lo que enviaría; no llama a la red (es el default)
npm run webhook:set -- --apply       # setWebhook + getWebhookInfo; drop_pending_updates = true
```

`--apply` imprime solo `url`, `pending_update_count`, `last_error_message` y `last_error_date` (si hay), y `allowed_updates`.
Lo esperado: `url` con `/tg/webhook`, `pending_update_count: 0`, `allowed_updates: message, callback_query`, sin error.

Para volver a mirar el estado en cualquier momento: `npm run webhook:set -- --info`.

## 11. Smoke test (con ella, en su celular)

**Quién:** Gabriel + ella · **Toca Cloudflare:** sí (`wrangler tail`) · **Toca Telegram:** sí

Criterios de aceptación de T24: `wrangler deploy` OK, `getWebhookInfo` sin errores, un producto de prueba visible en la web,
`wrangler tail` con el CPU de una invocación, y producto de prueba borrado.

1. **Webhook.** `npm run webhook:set -- --info`: sin `last_error_message`, `pending_update_count` en 0.
2. **Primer contacto.** Ella manda `/start` al bot (U2). Tiene que responder. Si no responde, mirá `npx wrangler tail` y
   revisá `ALLOWED_CHAT_IDS` (paso 7).
3. **Producto de prueba.** Desde el celular, mandá 1 o 2 fotos y un audio con un nombre que se reconozca como de prueba (por
   ejemplo, *"producto de prueba smoke"*, precio 1000). Confirmá la vista previa con "Sí". Anotá el `slug` que propone el bot.
4. **Web.** Esperá el próximo build (hasta 30 min por el cron de 15 min, o mandá `/reconstruir` desde el chat de admin). Abrí
   `https://<proyecto>.pages.dev/p/<slug>/`: foto, precio y botón de WhatsApp que abre el chat con el mensaje prellenado.
5. **CPU del consumidor (R4 de `docs/02-diseno.md` §8).** Con `npx wrangler tail --format json` abierto, mandá un mensaje más al
   bot. En el evento del consumidor de la cola (`q-updates`), anotá el campo `cpuTime` (ms). El umbral de diseño es 10 ms. Ese
   número va en la descripción del PR de despliegue, no en el repo.
6. **Borrar el producto de prueba.** No hay consulta de borrado en `ops/queries/`; se archiva, que lo saca del catálogo público
   (`status = 'archived'`, ver `docs/02-diseno.md` §5.3):

   ```sh
   npx wrangler d1 execute veki --remote --command "UPDATE products SET status = 'archived', updated_at = CAST(strftime('%s','now') AS INTEGER) * 1000 WHERE slug = '<slug-de-prueba>'"
   ```

   Las fotos de prueba quedan en R2 (`orig/…`) y hay que borrarlas a mano si hace falta (`wrangler r2 object delete`).

Cuando los seis pasos estén bien, E1 está desplegado. Recién entonces se le puede mandar el catálogo real (U7).

## 12. Rollback

Orden de menor a mayor impacto. Ninguno de estos pasos borra secretos.

- **Dejar de recibir updates (webhook).** Corta el bot sin tocar el Worker:

  ```sh
  npm run webhook:set -- --delete
  ```

  Para volver a registrarlo: `npm run webhook:set -- --apply` (con las mismas variables del paso 10).

- **Volver el Worker a una versión anterior.** Rollback de código y configuración. No revierte datos de D1 ni migraciones:

  ```sh
  npx wrangler deployments list
  npx wrangler rollback <version-id>          # te pide confirmación
  ```

- **Volver la base a un momento anterior.** D1 Time Travel cubre los últimos 7 días (ver `ops/RESTORE.md`):

  ```sh
  npx wrangler d1 time-travel restore veki --timestamp=<ISO-8601>
  ```

- **Volver el sitio a un build anterior.** En el dashboard de Pages: *Deployments → Rollback to this deployment* (no hay comando de
  wrangler para Pages en este runbook).

- **Rotar secretos.** Después de sospechar una filtración, o al cambiar de proveedor:

  | Secreto | Cómo rotarlo | Después |
  |---|---|---|
  | `TELEGRAM_BOT_TOKEN` | BotFather: `/revoke` del bot → token nuevo | Cargar el secret (paso 6) y volver a correr `--apply` (el token va en la URL de la API) |
  | `TG_WEBHOOK_SECRET` | `openssl rand -hex 32` | Cargar el secret y correr `--apply` **seguido**: entre los dos pasos, los updates fallan con 401 |
  | `GROQ_API_KEY` / `GEMINI_API_KEY` | Revocar la clave en el panel del proveedor y crear otra | Cargar el secret (paso 6) |
  | `DEPLOY_HOOK_URL` | Borrar el hook en Pages y crear otro | Cargar el secret (paso 9) |

  Tras rotar, `npm run webhook:set -- --info` y el smoke test del paso 11 (punto 2) confirman que todo sigue andando.

## Lo que hay que darle al despliegue

Lo que tiene que aportar Gabriel (o ella), con el paso en el que se usa:

| Dato | Dónde se usa | Notas |
|---|---|---|
| Chat id de ella (`owner`) y de Gabriel (`admin`) | Paso 7 (secret) | Datos personales: no van al repo ni al chat |
| Número público de WhatsApp (solo dígitos, con código de país) | Paso 5 | Se inyecta en el archivo temporal; no se commitea |
| `TELEGRAM_BOT_TOKEN` (bloque `PROD`) | Pasos 6 y 10 | Nunca se pega |
| `GROQ_API_KEY` (bloque `PROD`) | Paso 6 | Nunca se pega |
| URL del deploy hook de Pages | Paso 9 | Tratarla como secreto |
| Subdominio de `workers.dev` | Pasos 8 a 11 | Lo imprime `wrangler deploy` |

## Riesgos abiertos

- **R-1. `ALLOWED_CHAT_IDS` en un repo público.** Resuelto: es un secret (pasos 6 y 7), no está en `wrangler.toml` ni en ningún
  archivo versionado.
- **R-2. Fixture silencioso.** Sin `CATALOG_URL` en Pages, el sitio muestra datos de prueba sin error (ver paso 9).
- **R-3. Número placeholder.** Si `whatsapp_number` queda `CHANGE-ME`, el catálogo no pasa el schema. Verificalo en el paso 11.
- **R-4. CPU del consumidor.** Se mide en el paso 11 (punto 5). Si supera el límite de Free, hay que revisar el diseño (`docs/02-diseno.md` §8, R4).
