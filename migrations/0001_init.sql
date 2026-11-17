-- 0001_init: esquema inicial (docs/02-diseno.md §2.2). Solo hacia adelante.

-- Catálogo
CREATE TABLE products (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,              -- "rinonera-girasol"
  name TEXT NOT NULL,
  category TEXT NOT NULL,                 -- valor de settings.categories
  description TEXT,                       -- en tono Veky, confirmada por ella
  price_ars INTEGER,                      -- NULL = "consultar"
  status TEXT NOT NULL DEFAULT 'active',  -- draft|active|hidden|archived
  featured INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX idx_products_status ON products(status, updated_at);

CREATE TABLE variants (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id),
  design TEXT NOT NULL DEFAULT '',        -- "girasol"
  size TEXT NOT NULL DEFAULT '',          -- "chica"
  color TEXT NOT NULL DEFAULT '',         -- "lila"
  price_ars INTEGER,                      -- NULL = precio del producto
  stock INTEGER,                          -- NULL = no sabe / a pedido
  status TEXT NOT NULL DEFAULT 'active',  -- active|archived
  updated_at INTEGER NOT NULL,
  UNIQUE (product_id, design, size, color)
);
CREATE INDEX idx_variants_product ON variants(product_id);

CREATE TABLE media (
  id TEXT PRIMARY KEY,
  r2_key TEXT NOT NULL UNIQUE,            -- "orig/2026/11/<id>.jpg"
  kind TEXT NOT NULL,                     -- photo|video|render_flyer|render_reel|render_carousel
  mime TEXT NOT NULL, bytes INTEGER, width INTEGER, height INTEGER, duration_s REAL,
  tg_file_unique_id TEXT UNIQUE,          -- dedupe si reenvía la misma foto
  tg_small_file_id TEXT,                  -- tamaño ~800 px de Telegram, para visión
  product_id TEXT REFERENCES products(id),
  variant_id TEXT REFERENCES variants(id),
  position INTEGER,                       -- orden en la web; 0 = portada
  alt_text TEXT,
  status TEXT NOT NULL DEFAULT 'inbox',   -- inbox|attached|discarded
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_media_product ON media(product_id, position);
CREATE INDEX idx_media_status ON media(status, created_at);

-- Agenda
CREATE TABLE fairs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL, place TEXT NOT NULL, address TEXT, maps_url TEXT,
  starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'confirmed', -- confirmed|cancelled
  public INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX idx_fairs_start ON fairs(starts_at);

-- Telegram y conversación
CREATE TABLE updates (                    -- idempotencia del webhook; purga a 14 días
  update_id INTEGER PRIMARY KEY,
  chat_id INTEGER NOT NULL, kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',  -- queued|done|failed
  received_at INTEGER NOT NULL, processed_at INTEGER
);

CREATE TABLE inbox_groups (               -- agrupación de álbumes (§2.3)
  media_group_id TEXT PRIMARY KEY,
  chat_id INTEGER NOT NULL,
  item_count INTEGER NOT NULL,
  first_at INTEGER NOT NULL, last_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open'     -- open|flushed
);

CREATE TABLE conversations (
  chat_id INTEGER PRIMARY KEY,
  role TEXT NOT NULL,                     -- owner|admin
  state TEXT NOT NULL DEFAULT '{}',       -- JSON: borrador, pregunta pendiente, contador de malentendidos
  history TEXT NOT NULL DEFAULT '[]',     -- JSON: últimos 12 turnos, recortado
  last_user_msg_at INTEGER,
  version INTEGER NOT NULL DEFAULT 0,     -- bloqueo optimista
  updated_at INTEGER NOT NULL
);

CREATE TABLE pending_actions (
  id TEXT PRIMARY KEY,                    -- va en callback_data: "pa:<id>:yes|chg|no"
  chat_id INTEGER NOT NULL,
  tool TEXT NOT NULL, args TEXT NOT NULL, -- JSON validado
  preview TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending|executed|cancelled|expired|undone
  inverse TEXT,                           -- JSON para deshacer, se llena al ejecutar
  tg_message_id INTEGER,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, executed_at INTEGER
);
CREATE INDEX idx_pa_chat ON pending_actions(chat_id, status, created_at);

-- Contenido
CREATE TABLE content_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                     -- flyer|carousel|reel
  template TEXT NOT NULL,                 -- producto|feria|novedad
  product_id TEXT, fair_id TEXT,
  input TEXT NOT NULL,                    -- JSON: media_ids, textos confirmados
  status TEXT NOT NULL,                   -- ranking|awaiting_choice|writing|awaiting_copy_ok|rendering|delivering|delivered|failed|cancelled
  attempts INTEGER NOT NULL DEFAULT 0,
  provider TEXT, gh_run_id TEXT, error TEXT,
  output TEXT,                            -- JSON: r2 keys
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX idx_jobs_status ON content_jobs(status, updated_at);

-- Proactividad
CREATE TABLE nudges (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,                     -- ver §3.6
  ref_id TEXT,                            -- fair_id, product_id…
  due_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled', -- scheduled|sent|answered|ignored|snoozed|skipped|cancelled
  sent_at INTEGER, answered_at INTEGER, tg_message_id INTEGER,
  UNIQUE (type, ref_id, due_at)
);
CREATE INDEX idx_nudges_due ON nudges(status, due_at);

CREATE TABLE nudge_policy (
  type TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  ignored_streak INTEGER NOT NULL DEFAULT 0,
  paused_until INTEGER
);

-- Operación
CREATE TABLE event_log (
  id TEXT PRIMARY KEY, ts INTEGER NOT NULL,
  actor TEXT NOT NULL,                    -- owner|admin|bot|cron|render
  type TEXT NOT NULL,                     -- "product.created", "provider.fallback", "error"…
  severity TEXT NOT NULL DEFAULT 'info',  -- info|warn|error
  entity TEXT, entity_id TEXT,
  data TEXT                               -- JSON sin datos personales ni transcripciones
);
CREATE INDEX idx_event_ts ON event_log(ts);
CREATE INDEX idx_event_entity ON event_log(entity, entity_id, ts);

CREATE TABLE provider_state (            -- circuit breaker
  provider_model TEXT PRIMARY KEY,        -- "gemini:gemini-3.5-flash-lite"
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  cooldown_until INTEGER
);
CREATE TABLE provider_usage (
  day TEXT NOT NULL, provider_model TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0, tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0, audio_s INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, provider_model)
);

CREATE TABLE site_state (                 -- una sola fila, id = 1
  id INTEGER PRIMARY KEY CHECK (id = 1),
  dirty_since INTEGER, last_build_at INTEGER,
  builds_day TEXT, builds_today INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); -- JSON

-- Seed de settings (docs/02 §2.2, §3.6, §4.6, §5.4, Q6, Q7). Valores JSON.
INSERT INTO settings (key, value) VALUES
  ('categories', '["carteras","riñoneras","neceseres","cartucheras","otros"]'),
  ('providers', '{"chat":["groq:openai/gpt-oss-120b","gemini:gemini-3.5-flash-lite"],"vision":["gemini:gemini-3.5-flash-lite","groq:qwen/qwen3.8-27b"],"stt":["groq:whisper-large-v3","workersai:@cf/openai/whisper"]}'),
  ('quiet_hours', '{"start":"21:00","end":"09:00","tz":"America/Argentina/Buenos_Aires","sunday_only_fair_nudges":true}'),
  ('whatsapp_number', '""'),
  ('max_builds_per_day', '12'),
  ('min_build_interval_min', '10'),
  ('nudge_cadence', '{"feria_previa":{"at":"18:00","days_before":1},"feria_posterior":{"at":"11:00","days_after":1},"resumen_semanal":{"weekday":1,"at":"10:00"},"agenda_vacia":{"weekday":2,"at":"11:00","every_weeks":2,"horizon_days":14},"inactividad":{"after_days":7,"at":"11:00"},"max_per_day":1,"snooze_hours":3,"ignored_after_hours":24,"pause_days":30}');
