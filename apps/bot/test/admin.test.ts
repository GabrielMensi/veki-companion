import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { FakeChatProvider, FakeSttProvider, copyAdmin, type AgentOutput } from "@veki/core";
import { D1ConversationStore } from "../src/actions/conversation-store";
import { d1ToolHost } from "../src/actions/pending";
import { ALERT_COOLDOWN_MS, claimAlert, scanAlerts, sendAlert } from "../src/admin/alerts";
import { handleAdminCommand, parseCommand } from "../src/admin/commands";
import { buildDigest, sendDailyDigest } from "../src/admin/digest";
import type { Env } from "../src/env";
import { handleUpdateMessage } from "../src/handlers/dispatch";
import { setRuntimeOverride } from "../src/runtime";

// Todo inventado: ids de chat, tokens y filas. Sin red.
const e = env as unknown as { DB: Env["DB"]; MEDIA: unknown };
const ADMIN = 9001;
const OWNER = 4242;
const NOW = Date.UTC(2026, 10, 17, 12, 0, 0);
const testEnv = (extra: Partial<Env> = {}) =>
  ({ DB: e.DB, MEDIA: e.MEDIA, Q_UPDATES: { send: async () => {} }, Q_JOBS: { send: async () => {} }, TELEGRAM_BOT_TOKEN: "t", TG_WEBHOOK_SECRET: "s", ALLOWED_CHAT_IDS: `${OWNER}:owner,${ADMIN}:admin`, ...extra }) as unknown as Env;
const run = (sql: string, ...b: unknown[]) => e.DB.prepare(sql).bind(...b).run();
const one = async <T>(sql: string, ...b: unknown[]) => e.DB.prepare(sql).bind(...b).first<T>();

beforeEach(async () => {
  for (const t of ["event_log", "pending_actions", "products", "updates", "nudge_policy", "nudges", "provider_usage", "provider_state", "content_jobs", "site_state", "conversations"]) await run(`DELETE FROM ${t}`);
  await run("DELETE FROM settings WHERE key LIKE 'alert_last:%' OR key = 'nudges_paused'");
});

describe("parseCommand", () => {
  it("separa comando y argumentos, ignora @bot y mayúsculas", () => {
    expect(parseCommand("/Log@VekiBot 5")).toEqual({ cmd: "log", args: ["5"] });
    expect(parseCommand("hola")).toBeNull();
  });
});

describe("comandos de admin", () => {
  it("un chat que no es admin recibe null (sigue el flujo normal), también el owner", async () => {
    expect(await handleAdminCommand(testEnv(), OWNER, "/estado", { now: NOW })).toBeNull();
    expect(await handleAdminCommand(testEnv(), 777, "/log", { now: NOW })).toBeNull();
    expect(await handleAdminCommand(testEnv(), OWNER, "/pausa on", { now: NOW })).toBeNull();
    expect(await one("SELECT value FROM settings WHERE key = 'nudges_paused'")).toBeNull();
  });

  it("el admin con texto sin barra recibe null; con /desconocido recibe la ayuda", async () => {
    expect(await handleAdminCommand(testEnv(), ADMIN, "hola", { now: NOW })).toBeNull();
    expect(await handleAdminCommand(testEnv(), ADMIN, "/nada", { now: NOW })).toBe(copyAdmin.comandoDesconocido);
  });

  it("/estado cuenta pendientes, fallidos y errores", async () => {
    await run("INSERT INTO pending_actions (id, chat_id, tool, args, preview, status, created_at, expires_at) VALUES ('pa1', ?, 'cambiar_stock', '{}', 'x', 'pending', ?, ?)", OWNER, NOW, NOW + 1000);
    await run("INSERT INTO updates (update_id, chat_id, kind, status, received_at) VALUES (1, ?, 'text', 'failed', ?)", OWNER, NOW);
    await run("INSERT INTO event_log (id, ts, actor, type, severity) VALUES ('ev1', ?, 'bot', 'error', 'error')", NOW - 1000);
    const out = (await handleAdminCommand(testEnv(), ADMIN, "/estado", { now: NOW }))!;
    expect(out).toContain("esperando confirmación: 1");
    expect(out).toContain("fallidos (14 días): 1");
    expect(out).toContain("24 h: 1");
  });

  it("/log muestra tipo y severidad, nunca el campo data, y valida n", async () => {
    await run("INSERT INTO event_log (id, ts, actor, type, severity, entity, entity_id, data) VALUES ('ev1', ?, 'owner', 'product.created', 'info', 'product', 'p1', ?)", NOW, JSON.stringify({ secreto: "TEXTO-LIBRE" }));
    const out = (await handleAdminCommand(testEnv(), ADMIN, "/log 5", { now: NOW }))!;
    expect(out).toContain("[info] product.created (product p1)");
    expect(out).not.toContain("TEXTO-LIBRE");
    expect(await handleAdminCommand(testEnv(), ADMIN, "/log 0", { now: NOW })).toBe(copyAdmin.logUso);
    expect(await handleAdminCommand(testEnv(), ADMIN, "/log x", { now: NOW })).toBe(copyAdmin.logUso);
  });

  it("/deshacer <id> restaura la fila y registra al admin; luego dice que ya estaba deshecha", async () => {
    await run("INSERT INTO products (id, slug, name, category, status, created_at, updated_at) VALUES ('p1', 'a', 'Nuevo', 'otros', 'active', 1, 1)");
    const inverse = JSON.stringify({ ops: [{ op: "delete", table: "products", id: "p1" }], public: false });
    await run("INSERT INTO pending_actions (id, chat_id, tool, args, preview, status, inverse, created_at, expires_at, executed_at) VALUES ('pa9', ?, 'editar_producto', '{}', 'x', 'executed', ?, ?, ?, ?)", OWNER, inverse, NOW - 5000, NOW + 1000, NOW - 4000);
    expect(await handleAdminCommand(testEnv(), ADMIN, "/deshacer", { now: NOW })).toBe(copyAdmin.deshacerUso);
    expect(await handleAdminCommand(testEnv(), ADMIN, "/deshacer nope", { now: NOW })).toBe(copyAdmin.deshacerNoEncontrada);
    expect(await handleAdminCommand(testEnv(), ADMIN, "/deshacer pa9", { now: NOW })).toBe(copyAdmin.deshacerListo("pa9"));
    expect(await one("SELECT id FROM products WHERE id = 'p1'")).toBeNull();
    expect(await one<{ actor: string }>("SELECT actor FROM event_log WHERE type = 'action.undone'")).toEqual({ actor: "admin" });
    expect(await handleAdminCommand(testEnv(), ADMIN, "/deshacer pa9", { now: NOW })).toBe(copyAdmin.deshacerYaEstaba);
  });

  it("/reconstruir: sin cambios, sin hook, y con cambios llama al hook una vez", async () => {
    expect(await handleAdminCommand(testEnv(), ADMIN, "/reconstruir", { now: NOW })).toBe(copyAdmin.reconstruirSinCambios);
    await run("INSERT INTO site_state (id, dirty_since) VALUES (1, ?)", NOW - 1000);
    expect(await handleAdminCommand(testEnv(), ADMIN, "/reconstruir", { now: NOW })).toBe(copyAdmin.reconstruirSinHook);
    const calls: string[] = [];
    const fetchFn = (async (u: string) => (calls.push(u), new Response("ok"))) as unknown as typeof fetch;
    const withHook = testEnv({ DEPLOY_HOOK_URL: "https://example.invalid/hook" });
    expect(await handleAdminCommand(withHook, ADMIN, "/reconstruir", { now: NOW, fetch: fetchFn })).toBe(copyAdmin.reconstruirLlamado);
    expect(calls).toHaveLength(1);
  });

  it("/pausa on|off escribe el interruptor y /estado lo refleja", async () => {
    expect(await handleAdminCommand(testEnv(), ADMIN, "/pausa", { now: NOW })).toBe(copyAdmin.pausaUso);
    expect(await handleAdminCommand(testEnv(), ADMIN, "/pausa on", { now: NOW })).toBe(copyAdmin.pausaOn);
    expect(await handleAdminCommand(testEnv(), ADMIN, "/estado", { now: NOW })).toContain("pausados");
    expect(await handleAdminCommand(testEnv(), ADMIN, "/pausa off", { now: NOW })).toBe(copyAdmin.pausaOff);
    expect(await handleAdminCommand(testEnv(), ADMIN, "/estado", { now: NOW })).toContain("activos");
  });

  it("/avisos lista y reactiva un tipo apagado", async () => {
    expect(await handleAdminCommand(testEnv(), ADMIN, "/avisos", { now: NOW })).toBe(copyAdmin.avisosVacio);
    await run("INSERT INTO nudge_policy (type, enabled, ignored_streak, paused_until) VALUES ('inactividad', 0, 3, ?)", NOW + 86_400_000);
    expect(await handleAdminCommand(testEnv(), ADMIN, "/avisos", { now: NOW })).toContain("inactividad: apagado");
    expect(await handleAdminCommand(testEnv(), ADMIN, "/avisos inactividad on", { now: NOW })).toBe(copyAdmin.avisosReactivado("inactividad"));
    expect(await one("SELECT enabled, ignored_streak, paused_until FROM nudge_policy WHERE type = 'inactividad'")).toEqual({ enabled: 1, ignored_streak: 0, paused_until: null });
    expect(await handleAdminCommand(testEnv(), ADMIN, "/avisos zzz on", { now: NOW })).toBe(copyAdmin.avisosNoExiste("zzz"));
  });
});

describe("dispatch: comandos solo para admin", () => {
  function setup() {
    const sent: { chatId: number; out: AgentOutput }[] = [];
    const chat = new FakeChatProvider([() => ({ text: null, toolCalls: [{ id: "c1", name: "responder", arguments: { texto: "Dale" } }], usage: { tokensIn: 1, tokensOut: 1 } })]);
    setRuntimeOverride((en) => ({ chat, stt: new FakeSttProvider([]), store: new D1ConversationStore(en.DB), host: d1ToolHost(en) }));
    return { sent, chat, send: async (chatId: number, out: AgentOutput) => void sent.push({ chatId, out }) };
  }
  const textUpdate = (chatId: number, text: string) => ({ update_id: 1, update: { message: { message_id: 1, date: 0, chat: { id: chatId, type: "private" }, from: { id: chatId }, text } } });

  it("el admin con /estado recibe el estado y el agente no corre", async () => {
    const s = setup();
    await handleUpdateMessage(textUpdate(ADMIN, "/estado"), testEnv(), { send: s.send });
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]!.out.texto).toContain("Estado:");
    expect(s.chat.requests).toHaveLength(0);
  });

  it("el owner con /estado va al flujo normal (agente), sin datos de operación", async () => {
    const s = setup();
    await handleUpdateMessage(textUpdate(OWNER, "/estado"), testEnv(), { send: s.send });
    expect(s.chat.requests.length).toBeGreaterThan(0);
    expect(s.sent.map((m) => m.out.texto).join(" ")).not.toContain("Estado:");
  });
});

describe("alertas: tope de 1 cada 30 min por tipo", () => {
  it("claimAlert: la segunda dentro de la ventana no pasa, otro tipo sí, y pasada la ventana vuelve", async () => {
    expect(await claimAlert(e.DB, "error", NOW)).toBe(true);
    expect(await claimAlert(e.DB, "error", NOW + 1000)).toBe(false);
    expect(await claimAlert(e.DB, "error", NOW + ALERT_COOLDOWN_MS - 1)).toBe(false);
    expect(await claimAlert(e.DB, "render_fallido", NOW + 1000)).toBe(true);
    expect(await claimAlert(e.DB, "error", NOW + ALERT_COOLDOWN_MS)).toBe(true);
  });

  it("sendAlert envía una sola vez dentro de la ventana", async () => {
    const out: string[] = [];
    const send = async (t: string) => void out.push(t);
    expect(await sendAlert(testEnv(), "malentendidos", copyAdmin.alerta.malentendidos, NOW, send)).toBe(true);
    expect(await sendAlert(testEnv(), "malentendidos", copyAdmin.alerta.malentendidos, NOW + 60_000, send)).toBe(false);
    expect(out).toEqual([copyAdmin.alerta.malentendidos]);
  });

  it("scanAlerts: errores recientes alertan una vez; el texto no lleva el contenido del evento", async () => {
    await run("INSERT INTO event_log (id, ts, actor, type, severity, data) VALUES ('e1', ?, 'bot', 'update.error', 'error', ?)", NOW - 1000, JSON.stringify({ texto: "CONTENIDO-PRIVADO" }));
    await run("INSERT INTO content_jobs (id, kind, template, input, status, created_at, updated_at) VALUES ('j1', 'flyer', 'producto', '{}', 'failed', ?, ?)", NOW - 2000, NOW - 1000);
    await run("INSERT INTO provider_state (provider_model, consecutive_failures, cooldown_until) VALUES ('groq:x', 5, ?)", NOW + 2 * 3600_000);
    const out: string[] = [];
    const send = async (t: string) => void out.push(t);
    expect(await scanAlerts(testEnv(), NOW, send)).toEqual(["error", "render_fallido", "proveedor_cooldown"]);
    expect(await scanAlerts(testEnv(), NOW + 60_000, send)).toEqual([]);
    expect(out).toHaveLength(3);
    expect(out.join("\n")).not.toContain("CONTENIDO-PRIVADO");
  });

  it("un cooldown corto de proveedor (< 1 h) no alerta", async () => {
    await run("INSERT INTO provider_state (provider_model, consecutive_failures, cooldown_until) VALUES ('groq:x', 2, ?)", NOW + 10 * 60_000);
    expect(await scanAlerts(testEnv(), NOW, async () => {})).toEqual([]);
  });
});

describe("resumen diario", () => {
  it("cuenta acciones, errores, uso, builds, avisos ignorados y pausados", async () => {
    await run("INSERT INTO pending_actions (id, chat_id, tool, args, preview, status, created_at, expires_at, executed_at) VALUES ('a1', ?, 't', '{}', 'x', 'executed', ?, ?, ?)", OWNER, NOW - 5000, NOW + 1000, NOW - 4000);
    await run("INSERT INTO event_log (id, ts, actor, type, severity) VALUES ('e1', ?, 'bot', 'error', 'error')", NOW - 1000);
    await run("INSERT INTO provider_usage (day, provider_model, requests, tokens_in, tokens_out) VALUES ('2026-11-17', 'groq:m', 3, 100, 50)");
    await run("INSERT INTO site_state (id, builds_day, builds_today) VALUES (1, '2026-11-17', 2)");
    await run("INSERT INTO nudges (id, type, due_at, status) VALUES ('n1', 'inactividad', ?, 'ignored')", NOW - 1000);
    await run("INSERT INTO nudge_policy (type, enabled, paused_until) VALUES ('inactividad', 1, ?)", NOW + 86_400_000);
    const d = await buildDigest(testEnv(), NOW);
    expect(d).toMatchObject({ acciones: 1, errores: 1, builds: 2, ignorados: 1, pausados: ["inactividad"] });
    expect(d.uso).toEqual([expect.objectContaining({ modelo: "groq:m", usados: 150 })]);
    const out: string[] = [];
    const text = await sendDailyDigest(testEnv(), NOW, async (t) => void out.push(t));
    expect(out).toEqual([text]);
    expect(text).toContain("Resumen del día");
  });
});
