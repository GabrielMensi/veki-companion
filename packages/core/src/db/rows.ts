import { z } from "zod";
import { tables } from "./schema";
export * from "./schema";
export * from "./ids";

/** Tipos de fila (lo que devuelve D1) inferidos de los schemas zod. */
export type ProductRow = z.infer<typeof tables.products>;
export type VariantRow = z.infer<typeof tables.variants>;
export type MediaRow = z.infer<typeof tables.media>;
export type FairRow = z.infer<typeof tables.fairs>;
export type UpdateRow = z.infer<typeof tables.updates>;
export type InboxGroupRow = z.infer<typeof tables.inbox_groups>;
export type ConversationRow = z.infer<typeof tables.conversations>;
export type PendingActionRow = z.infer<typeof tables.pending_actions>;
export type ContentJobRow = z.infer<typeof tables.content_jobs>;
export type NudgeRow = z.infer<typeof tables.nudges>;
export type NudgePolicyRow = z.infer<typeof tables.nudge_policy>;
export type EventLogRow = z.infer<typeof tables.event_log>;
export type ProviderStateRow = z.infer<typeof tables.provider_state>;
export type ProviderUsageRow = z.infer<typeof tables.provider_usage>;
export type SiteStateRow = z.infer<typeof tables.site_state>;
export type SettingRow = z.infer<typeof tables.settings>;

/** JSON guardado en columnas TEXT: valida al leer. */
export const conversationState = z.object({}).passthrough();
export const conversationHistory = z.array(z.object({ role: z.string(), content: z.string() }).passthrough());

export function parseJson<T extends z.ZodTypeAny>(schema: T, text: string): z.infer<T> {
  return schema.parse(JSON.parse(text));
}

/** Valida los valores de `settings` conocidos. */
export const settingSchemas = {
  categories: z.array(z.string().min(1)).min(1),
  providers: z.object({
    chat: z.array(z.string()), vision: z.array(z.string()), stt: z.array(z.string()),
  }),
  quiet_hours: z.object({
    start: z.string(), end: z.string(), tz: z.string(), sunday_only_fair_nudges: z.boolean(),
  }),
  whatsapp_number: z.string(),
  max_builds_per_day: z.number().int().positive(),
  min_build_interval_min: z.number().int().positive(),
  nudge_cadence: z.object({}).passthrough(),
} as const;
