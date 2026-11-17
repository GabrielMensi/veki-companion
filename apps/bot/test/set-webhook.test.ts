import { describe, expect, it } from "vitest";
import {
  buildRequests,
  describeRequest,
  formatInfo,
  normalizeWorkerUrl,
  parseArgs,
  redact,
  resolveConfig,
  run,
  summarizeInfo,
  validateSecret,
  validateToken,
  type FetchLike,
  type SetWebhookEnv,
} from "../scripts/set-webhook";

// Valores falsos: no son credenciales reales. Los tests nunca hacen red: el fetch se inyecta.
const TOKEN = "123456:FAKE-token_value-abcdef";
const SECRET = "fake-secret-0123456789abcdef";
const WORKER = "https://veki-bot.example.workers.dev";
const ENV: SetWebhookEnv = { TELEGRAM_BOT_TOKEN: TOKEN, TG_WEBHOOK_SECRET: SECRET, WORKER_URL: WORKER };

interface Call {
  url: string;
  body: Record<string, unknown>;
}

/** fetch falso: responde segun el metodo de la URL y registra cada llamada. */
function fakeFetch(
  reply: (method: string) => { ok: boolean; result?: unknown; error_code?: number; description?: string } | "throw",
): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
    const method = url.split("/").pop() ?? "";
    const r = reply(method);
    if (r === "throw") throw new Error(`fetch failed for ${url}`);
    return { status: r.ok ? 200 : (r.error_code ?? 400), json: async () => r };
  };
  return { fetch, calls };
}

const INFO_OK = {
  ok: true,
  result: {
    url: `${WORKER}/tg/webhook`,
    has_custom_certificate: false,
    pending_update_count: 0,
    allowed_updates: ["message", "callback_query"],
    ip_address: "203.0.113.7",
  },
};

describe("parseArgs", () => {
  it("sin flags es dry-run", () => {
    expect(parseArgs([])).toEqual({ ok: true, value: "dry-run" });
  });

  it("reconoce cada modo", () => {
    expect(parseArgs(["--dry-run"])).toEqual({ ok: true, value: "dry-run" });
    expect(parseArgs(["--apply"])).toEqual({ ok: true, value: "apply" });
    expect(parseArgs(["--info"])).toEqual({ ok: true, value: "info" });
    expect(parseArgs(["--delete"])).toEqual({ ok: true, value: "delete" });
  });

  it("rechaza dos modos a la vez", () => {
    const r = parseArgs(["--apply", "--info"]);
    expect(r.ok).toBe(false);
  });

  it("rechaza un argumento desconocido sin repetirlo (podria ser un token pegado)", () => {
    const r = parseArgs([TOKEN]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).not.toContain(TOKEN);
  });
});

describe("normalizeWorkerUrl", () => {
  it("acepta https y devuelve solo el origen", () => {
    expect(normalizeWorkerUrl(WORKER)).toEqual({ ok: true, value: WORKER });
    expect(normalizeWorkerUrl(`${WORKER}/`)).toEqual({ ok: true, value: WORKER });
  });

  it("rechaza http, rutas, query, fragmento y credenciales", () => {
    for (const bad of [
      "http://veki-bot.example.workers.dev",
      `${WORKER}/tg/webhook`,
      `${WORKER}?x=1`,
      `${WORKER}#x`,
      "https://user:pass@veki-bot.example.workers.dev",
      "no es una url",
      "",
      undefined,
    ]) {
      expect(normalizeWorkerUrl(bad).ok).toBe(false);
    }
  });
});

describe("validacion de token y secret", () => {
  it("token con formato id:clave", () => {
    expect(validateToken(TOKEN).ok).toBe(true);
    expect(validateToken("sin-dos-puntos").ok).toBe(false);
  });

  it("secret: A-Z a-z 0-9 _ -, hasta 256", () => {
    expect(validateSecret(SECRET).ok).toBe(true);
    expect(validateSecret("con espacios").ok).toBe(false);
    expect(validateSecret("a".repeat(257)).ok).toBe(false);
    expect(validateSecret("").ok).toBe(false);
  });
});

describe("resolveConfig", () => {
  it("dry-run y apply exigen secret y WORKER_URL", () => {
    const r = resolveConfig("apply", { TELEGRAM_BOT_TOKEN: TOKEN });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("TG_WEBHOOK_SECRET, WORKER_URL");
  });

  it("info y delete solo exigen el token", () => {
    expect(resolveConfig("info", { TELEGRAM_BOT_TOKEN: TOKEN }).ok).toBe(true);
    expect(resolveConfig("delete", { TELEGRAM_BOT_TOKEN: TOKEN }).ok).toBe(true);
  });

  it("arma la URL del webhook con /tg/webhook", () => {
    const r = resolveConfig("apply", ENV);
    expect(r.ok && r.value.webhookUrl).toBe(`${WORKER}/tg/webhook`);
  });
});

describe("buildRequests", () => {
  const cfg = { token: TOKEN, secret: SECRET, webhookUrl: `${WORKER}/tg/webhook` };

  it("apply: setWebhook con secret, allowed_updates y drop_pending_updates; luego getWebhookInfo", () => {
    const reqs = buildRequests("apply", cfg);
    expect(reqs.map((r) => r.method)).toEqual(["setWebhook", "getWebhookInfo"]);
    expect(reqs[0]!.body).toEqual({
      url: `${WORKER}/tg/webhook`,
      secret_token: SECRET,
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: true,
    });
  });

  it("info y delete: un solo request", () => {
    expect(buildRequests("info", cfg).map((r) => r.method)).toEqual(["getWebhookInfo"]);
    expect(buildRequests("delete", cfg).map((r) => r.method)).toEqual(["deleteWebhook"]);
  });
});

describe("enmascarado", () => {
  it("redact quita el token de la URL de la API y los secrets literales", () => {
    const text = `fallo en https://api.telegram.org/bot${TOKEN}/setWebhook con ${SECRET}`;
    const out = redact(text, [SECRET]);
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain(SECRET);
    expect(out).toContain("bot***/setWebhook");
  });

  it("describeRequest no muestra token ni secret", () => {
    const req = buildRequests("apply", { token: TOKEN, secret: SECRET, webhookUrl: `${WORKER}/tg/webhook` })[0]!;
    const text = describeRequest(req, SECRET).join("\n");
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(SECRET);
    expect(text).toContain("bot***/setWebhook");
    expect(text).toContain(`${WORKER}/tg/webhook`);
  });

  it("summarizeInfo descarta campos que no pide el runbook", () => {
    const s = summarizeInfo(INFO_OK.result, [TOKEN]);
    expect(Object.keys(s).sort()).toEqual(["allowed_updates", "pending_update_count", "url"]);
    expect(JSON.stringify(s)).not.toContain("203.0.113.7");
  });
});

describe("run", () => {
  it("dry-run no llama a la red y no imprime token ni secret", async () => {
    const { fetch, calls } = fakeFetch(() => "throw");
    const lines: string[] = [];
    const code = await run([], ENV, fetch, (l) => lines.push(l));
    expect(code).toBe(0);
    expect(calls).toHaveLength(0);
    const out = lines.join("\n");
    expect(out).toContain("DRY-RUN");
    expect(out).toContain("setWebhook");
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain(SECRET);
  });

  it("apply registra el webhook y muestra solo los campos del resumen", async () => {
    const { fetch, calls } = fakeFetch((m) => (m === "setWebhook" ? { ok: true, result: true } : INFO_OK));
    const lines: string[] = [];
    const code = await run(["--apply"], ENV, fetch, (l) => lines.push(l));
    expect(code).toBe(0);
    expect(calls.map((c) => c.url.split("/").pop())).toEqual(["setWebhook", "getWebhookInfo"]);
    expect(calls[0]!.url).toBe(`https://api.telegram.org/bot${TOKEN}/setWebhook`);
    const out = lines.join("\n");
    expect(out).toContain("setWebhook: ok");
    expect(out).toContain(`url: ${WORKER}/tg/webhook`);
    expect(out).toContain("pending_update_count: 0");
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain("203.0.113.7");
  });

  it("apply con error de Telegram: codigo 1 y el token no sale por consola", async () => {
    const { fetch } = fakeFetch(() => ({ ok: false, error_code: 401, description: `Unauthorized (${TOKEN})` }));
    const lines: string[] = [];
    const code = await run(["--apply"], ENV, fetch, (l) => lines.push(l));
    expect(code).toBe(1);
    const out = lines.join("\n");
    expect(out).toContain("error 401");
    expect(out).not.toContain(TOKEN);
  });

  it("un fetch que lanza con la URL del token no filtra el token", async () => {
    const { fetch } = fakeFetch(() => "throw");
    const lines: string[] = [];
    const code = await run(["--info"], ENV, fetch, (l) => lines.push(l));
    expect(code).toBe(1);
    expect(lines.join("\n")).not.toContain(TOKEN);
  });

  it("info muestra last_error_message redactado", async () => {
    const { fetch } = fakeFetch(() => ({
      ok: true,
      result: { url: `${WORKER}/tg/webhook`, pending_update_count: 3, last_error_message: `timeout en bot${TOKEN}`, last_error_date: 1_700_000_000 },
    }));
    const lines: string[] = [];
    await run(["--info"], ENV, fetch, (l) => lines.push(l));
    const out = lines.join("\n");
    expect(out).toContain("last_error_message: timeout en bot***");
    expect(out).toContain("pending_update_count: 3");
    expect(out).not.toContain(TOKEN);
  });

  it("delete llama solo a deleteWebhook", async () => {
    const { fetch, calls } = fakeFetch(() => ({ ok: true, result: true }));
    const lines: string[] = [];
    const code = await run(["--delete"], ENV, fetch, (l) => lines.push(l));
    expect(code).toBe(0);
    expect(calls.map((c) => c.url.split("/").pop())).toEqual(["deleteWebhook"]);
    expect(lines).toContain("deleteWebhook: ok");
  });

  it("falta una variable: codigo 2 y se nombra la variable, no su valor", async () => {
    const { fetch, calls } = fakeFetch(() => "throw");
    const lines: string[] = [];
    const code = await run(["--apply"], { TELEGRAM_BOT_TOKEN: TOKEN, TG_WEBHOOK_SECRET: SECRET }, fetch, (l) => lines.push(l));
    expect(code).toBe(2);
    expect(calls).toHaveLength(0);
    expect(lines.join("\n")).toContain("WORKER_URL");
    expect(lines.join("\n")).not.toContain(TOKEN);
  });

  it("formatInfo muestra 'vacia' si no hay webhook", () => {
    const lines = formatInfo(summarizeInfo({}, []));
    expect(lines[0]).toContain("no hay webhook registrado");
  });
});
