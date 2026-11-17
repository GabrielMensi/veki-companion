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
  type ChatProvider,
  type ToolHost,
} from "@veki/core";
import { EVAL_SCENARIOS, type EvalScenario, type SeedProduct } from "../test/scenarios/spec";

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
function memoryHost(catalog: SeedProduct[]): ToolHost {
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
    createPendingAction: async () => ({ id: `eval-action-${++n}` }),
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

async function runScenario(s: EvalScenario, key: string, pauseMs: number): Promise<{ passed: number; total: number; aborted: boolean }> {
  const settings = DEFAULT_CHAT_SETTINGS;
  const real = createGroqChatChain(settings, { groqApiKey: key }, { state: new InMemoryStateStore(), usage: new InMemoryUsageSink() });
  const rec = recording(real);
  const host = memoryHost(s.catalog);
  const store = new InMemoryConversationStore();
  let passed = 0;
  console.log(`\nescenario ${s.id} (criterio ${s.covers})`);

  for (const [i, turn] of s.turns.entries()) {
    if (i > 0) await sleep(pauseMs);
    const snap = await store.load(CHAT_ID);
    try {
      const res = await runAgent(
        { chat: rec.chain, host, maxLlmCalls: settings.toolCallCap, historyLength: settings.historyLength },
        { state: snap.state, history: snap.history, input: { chatId: CHAT_ID, text: turn.user } },
      );
      const tools = rec.take();
      const outcome = res.output.pendingActionId ? "pending" : "reply";
      // Un "Si" simulado: una alta confirmada cierra el borrador, como el ejecutor real.
      await store.save(CHAT_ID, { state: outcome === "pending" ? clearDraft(res.state) : res.state, history: res.history }, snap.version);

      const missing = (turn.includes ?? []).filter((t) => !tools.includes(t));
      const forbidden = (turn.excludes ?? []).filter((t) => tools.includes(t));
      const wrongOutcome = turn.outcome !== undefined && turn.outcome !== outcome;
      const ok = missing.length === 0 && forbidden.length === 0 && !wrongOutcome;
      if (ok) passed++;
      const why = [
        ...(missing.length ? [`faltan: ${missing.join(",")}`] : []),
        ...(forbidden.length ? [`no debia: ${forbidden.join(",")}`] : []),
        ...(wrongOutcome ? [`salida: ${outcome}, esperada: ${turn.outcome}`] : []),
      ];
      console.log(`  turno ${i + 1}: herramientas=[${tools.map(safeName).join(", ")}] salida=${outcome} -> ${ok ? "PASS" : `FAIL (${why.join("; ")})`}`);
    } catch (e) {
      rec.take();
      // Solo la clase del error (nunca su mensaje: puede traer cuerpo de la respuesta).
      const kind = isProviderError(e) ? `${e.kind}${e.status ? ` ${e.status}` : ""}` : "error interno";
      console.log(`  turno ${i + 1}: sin respuesta del proveedor (${kind}) -> FAIL`);
      return { passed, total: s.turns.length, aborted: isProviderError(e) && e.kind === "rate_limit" };
    }
  }
  console.log(`  resultado: ${passed}/${s.turns.length}`);
  return { passed, total: s.turns.length, aborted: false };
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

  let passed = 0;
  let total = 0;
  for (const s of scenarios) {
    const r = await runScenario(s, key, pauseMs);
    passed += r.passed;
    total += r.total;
    if (r.aborted) {
      console.log("\neval-chat: todos los modelos están limitados (429); corto acá. Probá de nuevo en unos minutos o subí EVAL_PAUSE_MS.");
      process.exitCode = 1;
      break;
    }
  }
  console.log(`\ntotal: ${passed}/${total} turnos cumplieron${passed === total ? "" : " (hay FAIL)"}`);
  if (passed !== total) process.exitCode = 1;
}

main().catch((e) => {
  console.log(`eval-chat: falló la ejecución (${e instanceof Error ? e.name : "error"}).`);
  process.exitCode = 1;
});
