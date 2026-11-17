/**
 * MANUAL script (no corre en CI). Corre los turnos de usuaria de los escenarios de T23
 * (apps/bot/test/scenarios/spec.ts, `EVAL_SCENARIOS`) contra la cadena de chat REAL de Groq (la misma del bot:
 * `createGroqChatChain` con los modelos y topes por defecto) y el agente real (`runAgent`). Para cada turno
 * imprime SOLO los nombres de las herramientas que el modelo eligio y si se cumplio la expectativa del guion
 * (PASS/FAIL). Nunca imprime claves, ni textos de la usuaria, ni textos del modelo.
 *
 * Uso (desde la raiz del repo o desde apps/bot):
 *   GROQ_API_KEY=... npm run eval:chat -w @veki/bot            # todos los escenarios
 *   npm run eval:chat -w @veki/bot -- --only cambiar-precio     # uno solo
 *   EVAL_PAUSE_MS=8000 npm run eval:chat -w @veki/bot           # pausa entre turnos (por defecto 6000; el plan gratis de Groq es chico)
 *   EVAL_MODEL=openai/gpt-oss-20b npm run eval:chat -w @veki/bot # un solo modelo (sin cadena): probar los respaldos
 *   EVAL_RUNS=3 npm run eval:chat -w @veki/bot                   # repite todo N veces y suma
 *
 * Al final imprime: tasa de turnos cumplidos, turnos "inseguros" (herramienta de escritura prohibida o con datos
 * incorrectos, o escritura donde habia que aclarar), tokens totales y los modelos que respondieron. Nunca textos.
 *
 * La clave se lee de la variable de entorno GROQ_API_KEY o de un `.env` en la raiz del repo. Sin clave no hace nada
 * (avisa y termina). Sale con codigo 1 si algun turno falla.
 *
 * Lo que NO cubre: los toques de boton ("Si", "Cambiar") no son turnos de chat y la base es un anfitrion en memoria
 * (el catalogo sembrado del guion); el criterio es solo "que herramientas elige el modelo".
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_CHAT_SETTINGS,
  InMemoryConversationStore,
  InMemoryStateStore,
  InMemoryUsageSink,
  clearDraft,
  createGroqChatChain,
  formatPrice,
  isProviderError,
  runAgent,
  searchProducts,
  toolDefs,
  toolKinds,
  type ChatProvider,
  type ChatSettings,
  type ToolName,
  type ToolHost,
} from "@veki/core";
import { EVAL_SCENARIOS, type EvalScenario, type EvalTurn, type SeedProduct } from "../test/scenarios/spec";

const KNOWN_TOOLS = new Set(toolDefs.map((t) => t.name));
const CHAT_ID = 1;

function loadKey(): string | undefined {
  if (process.env.GROQ_API_KEY) return process.env.GROQ_API_KEY;
  const path = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../.env");
  if (!existsSync(path)) return undefined;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?GROQ_API_KEY\s*=\s*(.*)\s*$/);
    if (m) return m[1]!.replace(/^['"]|['"]$/g, "") || undefined;
  }
  return undefined;
}

/** Anfitrion en memoria: lecturas sobre el catalogo del guion (mismo formato que `tools/catalog.ts`) y acciones solo anotadas. */
type Pending = { tool: string; args: Record<string, unknown> };
function memoryHost(catalog: SeedProduct[], onPending: (p: Pending) => void): ToolHost {
  const view = (p: SeedProduct) => ({
    id: p.id,
    nombre: p.name,
    categoria: p.category,
    precio: formatPrice(p.price_ars),
    estado: "active",
    variantes: p.variants.map((v) => ({ id: v.id, diseno: v.design, talle: v.size, color: v.color, stock: v.stock })),
  });
  let n = 0;
  return {
    createPendingAction: async (input) => {
      onPending({ tool: input.tool, args: input.args });
      return { id: `eval-action-${++n}` };
    },
    read: async (name, args) => {
      if (name === "buscar_productos") {
        const items = catalog.map((p) => ({ id: p.id, name: p.name, category: p.category, variants: p.variants, p }));
        const found = searchProducts(String(args.consulta ?? ""), items).map((i) => view(i.p));
        return found.length ? found : "No encontré productos con eso.";
      }
      if (name === "ver_producto") {
        const p = catalog.find((x) => x.id === args.producto_id);
        return p ? view(p) : "No encuentro ese producto.";
      }
      return "Esa consulta todavía no está disponible.";
    },
  };
}

type Counted = { chain: ChatProvider; take(): string[] };
/** Envuelve la cadena para anotar los nombres de herramienta de cada llamada del turno (sin guardar textos). */
function recording(chain: ChatProvider): Counted {
  let names: string[] = [];
  return {
    chain: {
      agentLimits: chain.agentLimits?.bind(chain),
      complete: async (req) => {
        const res = await chain.complete(req);
        names.push(...res.toolCalls.map((t) => t.name));
        return res;
      },
    },
    take: () => {
      const out = names;
      names = [];
      return out;
    },
  };
}

const safeName = (n: string) => (KNOWN_TOOLS.has(n) ? n : "<desconocida>");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const WRITE_TOOLS = new Set(toolDefs.map((t) => t.name).filter((n) => toolKinds[n as ToolName] === "write"));

/** `expected` es subconjunto (recursivo) de `actual`. */
function subset(expected: unknown, actual: unknown): boolean {
  if (expected && typeof expected === "object" && !Array.isArray(expected)) {
    if (!actual || typeof actual !== "object") return false;
    return Object.entries(expected).every(([k, v]) => subset(v, (actual as Record<string, unknown>)[k]));
  }
  return expected === actual;
}

/** Modelo(s) pedidos: EVAL_MODEL (uno solo, con o sin prefijo "groq:") o la cadena por defecto del bot. */
function evalSettings(): ChatSettings {
  const m = process.env.EVAL_MODEL?.trim();
  if (!m) return DEFAULT_CHAT_SETTINGS;
  return { ...DEFAULT_CHAT_SETTINGS, models: [m.startsWith("groq:") ? m : `groq:${m}`] };
}

type Totals = { passed: number; total: number; unsafe: number; tokensIn: number; tokensOut: number; models: Map<string, number>; aborted: boolean };
const newTotals = (): Totals => ({ passed: 0, total: 0, unsafe: 0, tokensIn: 0, tokensOut: 0, models: new Map(), aborted: false });

async function runScenario(s: EvalScenario, key: string, pauseMs: number, t: Totals, first: boolean): Promise<void> {
  const settings = evalSettings();
  const usage = new InMemoryUsageSink();
  const real = createGroqChatChain(settings, { groqApiKey: key }, { state: new InMemoryStateStore(), usage });
  const rec = recording(real);
  let pending: Pending | null = null;
  const host = memoryHost(s.catalog, (p) => (pending = p));
  const store = new InMemoryConversationStore();
  let passed = 0;
  console.log(`\nescenario ${s.id} (criterio ${s.covers})`);

  for (const [i, turn] of s.turns.entries()) {
    if (i > 0 || !first) await sleep(pauseMs);
    const snap = await store.load(CHAT_ID);
    pending = null;
    t.total++;
    try {
      const res = await runAgent(
        { chat: rec.chain, host, maxLlmCalls: settings.toolCallCap, historyLength: settings.historyLength },
        { state: snap.state, history: snap.history, input: { chatId: CHAT_ID, text: turn.user, ...(turn.lowConfidence ? { lowConfidenceVoice: true } : {}) } },
      );
      t.tokensIn += res.tokensIn;
      t.tokensOut += res.tokensOut;
      const tools = rec.take();
      const outcome = res.output.pendingActionId ? "pending" : "reply";
      // Un "Si" simulado: una alta confirmada cierra el borrador, como el ejecutor real.
      await store.save(CHAT_ID, { state: outcome === "pending" ? clearDraft(res.state) : res.state, history: res.history }, snap.version);

      const { fails, unsafe } = judge(turn, tools, outcome, res.output.texto, res.state.draft?.campos.price_ars, pending);
      if (fails.length === 0) {
        passed++;
        t.passed++;
      }
      if (unsafe) t.unsafe++;
      console.log(`  turno ${i + 1}: herramientas=[${tools.map(safeName).join(", ")}] salida=${outcome} -> ${fails.length === 0 ? "PASS" : `FAIL${unsafe ? " INSEGURO" : ""} (${fails.join("; ")})`}`);
    } catch (e) {
      rec.take();
      // Solo la clase del error (nunca su mensaje: puede traer cuerpo de la respuesta).
      const kind = isProviderError(e) ? `${e.kind}${e.status ? ` ${e.status}` : ""}` : "error interno";
      console.log(`  turno ${i + 1}: sin respuesta del proveedor (${kind}) -> FAIL`);
      t.total += s.turns.length - i - 1;
      t.aborted = isProviderError(e) && e.kind === "rate_limit";
      break;
    }
  }
  for (const d of usage.deltas) t.models.set(d.providerModel, (t.models.get(d.providerModel) ?? 0) + d.requests);
  console.log(`  resultado: ${passed}/${s.turns.length}`);
}

/** Juzga un turno solo por herramientas, salida y datos. `fails` son descripciones fijas (nunca texto de nadie). */
function judge(turn: EvalTurn, tools: string[], outcome: string, replyText: string, draftPrice: unknown, pending: Pending | null) {
  const fails: string[] = [];
  const missing = (turn.includes ?? []).filter((x) => !tools.includes(x));
  const forbidden = (turn.excludes ?? []).filter((x) => tools.includes(x));
  if (missing.length) fails.push(`faltan: ${missing.join(",")}`);
  if (forbidden.length) fails.push(`no debia: ${forbidden.join(",")}`);
  const wrongOutcome = turn.outcome !== undefined && turn.outcome !== outcome;
  if (wrongOutcome) fails.push(`salida: ${outcome}, esperada: ${turn.outcome}`);
  const badArgs = turn.pendingArgs !== undefined && (!pending || !subset(turn.pendingArgs, pending.args));
  if (badArgs) fails.push(pending ? "datos de la accion incorrectos" : "no hubo accion pendiente");
  const badPrice = turn.draftPrice !== undefined && draftPrice !== turn.draftPrice;
  if (badPrice) fails.push("precio del borrador incorrecto");
  const questions = (replyText.match(/\?/g) ?? []).length;
  const badQuestions = turn.oneQuestion === true && outcome === "reply" && questions !== 1;
  if (badQuestions) fails.push(`preguntas: ${questions}, esperada: 1`);
  // Inseguro = fallar ESCRIBIENDO mal (herramienta prohibida, datos erroneos, accion donde habia que aclarar), no por charlar.
  const wroteWhereNot = turn.outcome === "reply" && outcome === "pending";
  const unsafe = forbidden.some((x) => WRITE_TOOLS.has(x)) || badArgs && pending !== null || badPrice || wroteWhereNot;
  return { fails, unsafe };
}

async function main() {
  const key = loadKey();
  if (!key) {
    console.log("eval-chat: no encontré GROQ_API_KEY (variable de entorno o .env en la raíz del repo). No corrí nada.");
    return;
  }
  const onlyIdx = process.argv.indexOf("--only");
  const only = onlyIdx >= 0 ? process.argv[onlyIdx + 1] : undefined;
  const scenarios = EVAL_SCENARIOS.filter((s) => !only || s.id === only);
  if (scenarios.length === 0) {
    console.log(`eval-chat: no hay un escenario con ese id. Disponibles: ${EVAL_SCENARIOS.map((s) => s.id).join(", ")}`);
    process.exitCode = 1;
    return;
  }
  const pauseMs = Number(process.env.EVAL_PAUSE_MS ?? 6000) || 0;
  const runs = Math.max(1, Math.floor(Number(process.env.EVAL_RUNS ?? 1)) || 1);
  const settings = evalSettings();
  console.log(`modelos pedidos: ${settings.models.join(" -> ")}; corridas: ${runs}`);

  const all = newTotals();
  for (let r = 1; r <= runs && !all.aborted; r++) {
    const t = newTotals();
    if (runs > 1) console.log(`\n=== corrida ${r}/${runs} ===`);
    for (const s of scenarios) {
      await runScenario(s, key, pauseMs, t, r === 1 && s === scenarios[0]);
      if (t.aborted) {
        console.log("\neval-chat: todos los modelos están limitados (429); corto acá. Probá de nuevo en unos minutos o subí EVAL_PAUSE_MS.");
        break;
      }
    }
    console.log(`corrida ${r}: ${t.passed}/${t.total} (${pct(t.passed, t.total)}), inseguros: ${t.unsafe}`);
    all.passed += t.passed;
    all.total += t.total;
    all.unsafe += t.unsafe;
    all.tokensIn += t.tokensIn;
    all.tokensOut += t.tokensOut;
    all.aborted = t.aborted;
    for (const [m, n] of t.models) all.models.set(m, (all.models.get(m) ?? 0) + n);
  }
  const models = [...all.models].map(([m, n]) => `${m} x${n}`).join(", ") || "ninguno";
  console.log(`\ntotal: ${all.passed}/${all.total} turnos cumplieron (${pct(all.passed, all.total)})${all.passed === all.total ? "" : " (hay FAIL)"}`);
  console.log(`inseguros (escritura incorrecta o sin confirmar): ${all.unsafe}`);
  console.log(`tokens: entrada=${all.tokensIn} salida=${all.tokensOut}; modelos que respondieron: ${models}`);
  if (all.passed !== all.total || all.unsafe > 0) process.exitCode = 1;
}

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "n/a");

main().catch((e) => {
  console.log(`eval-chat: falló la ejecución (${e instanceof Error ? e.name : "error"}).`);
  process.exitCode = 1;
});
