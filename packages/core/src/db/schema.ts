import { z } from "zod";

/** Enums de columnas TEXT con valores acotados (docs/02 §2.2). */
export const productStatus = z.enum(["draft", "active", "hidden", "archived"]);
export const variantStatus = z.enum(["active", "archived"]);
export const mediaKind = z.enum(["photo", "video", "render_flyer", "render_reel", "render_carousel"]);
export const mediaStatus = z.enum(["inbox", "attached", "discarded"]);
export const fairStatus = z.enum(["confirmed", "cancelled"]);
export const updateStatus = z.enum(["queued", "done", "failed"]);
export const groupStatus = z.enum(["open", "flushed"]);
export const conversationRole = z.enum(["owner", "admin"]);
export const pendingStatus = z.enum(["pending", "executed", "cancelled", "expired", "undone"]);
export const jobKind = z.enum(["flyer", "carousel", "reel"]);
export const jobTemplate = z.enum(["producto", "feria", "novedad"]);
export const jobStatus = z.enum([
  "ranking", "awaiting_choice", "writing", "awaiting_copy_ok",
  "rendering", "delivering", "delivered", "failed", "cancelled",
]);
export const nudgeStatus = z.enum(["scheduled", "sent", "answered", "ignored", "snoozed", "skipped", "cancelled"]);
export const logActor = z.enum(["owner", "admin", "bot", "cron", "render"]);
export const logSeverity = z.enum(["info", "warn", "error"]);

const id = z.string().min(1);
const ms = z.number().int();
const int = z.number().int();
const nullable = <T extends z.ZodTypeAny>(t: T) => t.nullable();

/** Una entrada por tabla; las claves son exactamente las columnas (las compara el test con PRAGMA table_info). */
export const tables = {
  products: z.object({
    id, slug: z.string().min(1), name: z.string().min(1), category: z.string().min(1),
    description: nullable(z.string()), price_ars: nullable(int.nonnegative()),
    status: productStatus, featured: z.union([z.literal(0), z.literal(1)]),
    created_at: ms, updated_at: ms,
  }),
  variants: z.object({
    id, product_id: id, design: z.string(), size: z.string(), color: z.string(),
    price_ars: nullable(int.nonnegative()), stock: nullable(int.nonnegative()),
    status: variantStatus, updated_at: ms,
  }),
  media: z.object({
    id, r2_key: z.string().min(1), kind: mediaKind, mime: z.string().min(1),
    bytes: nullable(int.nonnegative()), width: nullable(int.positive()), height: nullable(int.positive()),
    duration_s: nullable(z.number().nonnegative()),
    tg_file_unique_id: nullable(z.string()), tg_small_file_id: nullable(z.string()),
    product_id: nullable(id), variant_id: nullable(id), position: nullable(int.nonnegative()),
    alt_text: nullable(z.string()), status: mediaStatus, created_at: ms,
  }),
  fairs: z.object({
    id, name: z.string().min(1), place: z.string().min(1),
    address: nullable(z.string()), maps_url: nullable(z.string()),
    starts_at: ms, ends_at: ms, status: fairStatus,
    public: z.union([z.literal(0), z.literal(1)]), created_at: ms, updated_at: ms,
  }).refine((f) => f.ends_at >= f.starts_at, { message: "ends_at < starts_at" }),
  updates: z.object({
    update_id: int, chat_id: int, kind: z.string().min(1), status: updateStatus,
    received_at: ms, processed_at: nullable(ms),
  }),
  inbox_groups: z.object({
    media_group_id: z.string().min(1), chat_id: int, item_count: int.nonnegative(),
    first_at: ms, last_at: ms, status: groupStatus,
  }),
  conversations: z.object({
    chat_id: int, role: conversationRole, state: z.string(), history: z.string(),
    last_user_msg_at: nullable(ms), version: int.nonnegative(), updated_at: ms,
  }),
  pending_actions: z.object({
    id, chat_id: int, tool: z.string().min(1), args: z.string(), preview: z.string(),
    status: pendingStatus, inverse: nullable(z.string()), tg_message_id: nullable(int),
    created_at: ms, expires_at: ms, executed_at: nullable(ms),
  }),
  content_jobs: z.object({
    id, kind: jobKind, template: jobTemplate, product_id: nullable(id), fair_id: nullable(id),
    input: z.string(), status: jobStatus, attempts: int.nonnegative(),
    provider: nullable(z.string()), gh_run_id: nullable(z.string()), error: nullable(z.string()),
    output: nullable(z.string()), created_at: ms, updated_at: ms,
  }),
  nudges: z.object({
    id, type: z.string().min(1), ref_id: nullable(z.string()), due_at: ms, status: nudgeStatus,
    sent_at: nullable(ms), answered_at: nullable(ms), tg_message_id: nullable(int),
  }),
  nudge_policy: z.object({
    type: z.string().min(1), enabled: z.union([z.literal(0), z.literal(1)]),
    ignored_streak: int.nonnegative(), paused_until: nullable(ms),
  }),
  event_log: z.object({
    id, ts: ms, actor: logActor, type: z.string().min(1), severity: logSeverity,
    entity: nullable(z.string()), entity_id: nullable(z.string()), data: nullable(z.string()),
  }),
  provider_state: z.object({
    provider_model: z.string().min(1), consecutive_failures: int.nonnegative(), cooldown_until: nullable(ms),
  }),
  provider_usage: z.object({
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), provider_model: z.string().min(1),
    requests: int.nonnegative(), tokens_in: int.nonnegative(), tokens_out: int.nonnegative(),
    audio_s: int.nonnegative(), errors: int.nonnegative(),
  }),
  site_state: z.object({
    id: z.literal(1), dirty_since: nullable(ms), last_build_at: nullable(ms),
    builds_day: nullable(z.string()), builds_today: int.nonnegative(),
  }),
  settings: z.object({ key: z.string().min(1), value: z.string() }),
} as const;

export type TableName = keyof typeof tables;
