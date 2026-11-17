/**
 * MANUAL script (not run by CI). Measures input tokens of the chat system prompt + tools and
 * prints the Groq rate-limit headers for gpt-oss-120b. Prints numbers only, never keys.
 *
 *   GROQ_API_KEY in the environment or in a repo-root .env, then:
 *   npx tsx packages/core/scripts/measure-chat-tokens.ts
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MODEL = "openai/gpt-oss-120b";
const BUDGET = 2500;

// ---- PLACEHOLDER until T16 exists: replace with the real system prompt and tool definitions. ----
const PLACEHOLDER_SYSTEM = "PLACEHOLDER (T16 pending). Sos Veki, la asistente de un emprendimiento de bolsos y neceseres. Hablás en rioplatense con vos. Usá las herramientas para guardar productos, variantes, precios y ferias.";
const PLACEHOLDER_TOOLS = [
  { type: "function", function: { name: "guardar_producto", description: "PLACEHOLDER: guarda o actualiza un borrador de producto.", parameters: { type: "object", properties: { nombre: { type: "string" }, precio: { type: "number" } }, required: ["nombre"] } } },
];
// -------------------------------------------------------------------------------------------------

function loadKey(): string | undefined {
  if (process.env.GROQ_API_KEY) return process.env.GROQ_API_KEY;
  const path = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../.env");
  if (!existsSync(path)) return undefined;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?GROQ_API_KEY\s*=\s*(.*)\s*$/);
    if (m) return m[1]!.replace(/^['"]|['"]$/g, "");
  }
  return undefined;
}

async function probe(key: string, body: Record<string, unknown>) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: MODEL, max_completion_tokens: 16, ...body }),
  });
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => { if (k.startsWith("x-ratelimit-") || k === "retry-after") headers[k] = v; });
  const j = (await res.json().catch(() => ({}))) as { usage?: { prompt_tokens?: number } };
  return { status: res.status, promptTokens: j.usage?.prompt_tokens, headers };
}

async function main() {
  const key = loadKey();
  if (!key) {
    console.error("GROQ_API_KEY not found (env or repo-root .env). Nothing measured.");
    process.exit(1);
  }
  const user = { role: "user", content: "hola" };
  const base = await probe(key, { messages: [user] });
  const full = await probe(key, { messages: [{ role: "system", content: PLACEHOLDER_SYSTEM }, user], tools: PLACEHOLDER_TOOLS });
  console.log(`baseline (user "hola" only) prompt_tokens=${base.promptTokens} status=${base.status}`);
  console.log(`system+tools prompt_tokens=${full.promptTokens} status=${full.status} (budget ${BUDGET})`);
  if (full.promptTokens !== undefined && base.promptTokens !== undefined) {
    console.log(`system+tools overhead=${full.promptTokens - base.promptTokens}`);
  }
  console.log("NOTE: prompt/tools are T16 PLACEHOLDERS; re-run once T16 lands.");
  console.log("rate-limit headers:");
  for (const [k, v] of Object.entries(full.headers)) console.log(`  ${k}: ${v}`);
  const daily = Object.keys(full.headers).some((k) => /tokens/.test(k));
  console.log(daily ? "token limits present above (compare with ~480K tokens/day estimate)" : "no token limit header found");
}

main().catch((e) => { console.error((e as Error).message); process.exit(1); });
