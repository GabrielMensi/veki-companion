import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(HERE, "../../..");
const OUT = resolve(HERE, "../out");
const ENDPOINT = "https://api.groq.com/openai/v1/audio/transcriptions";
const MODELS = ["whisper-large-v3", "whisper-large-v3-turbo"] as const;
const PROMPT = "neceser, mantel, cartuchera, tela, bordado, feria, puesto";
const MAX_RETRIES = 4;
const MAX_WAIT_S = 120;

type Variant = { model: string; prompt: boolean };
type Result = {
  file: string;
  model: string;
  prompt: boolean;
  status: number | null;
  latencyMs: number;
  attempts: number;
  retried429: number;
  error: string | null;
  text: string | null;
  rateLimitHeaders: Record<string, string>;
};

async function loadKey(): Promise<string> {
  const raw = await readFile(resolve(ROOT, ".env"), "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?GROQ_API_KEY\s*=\s*(.*)\s*$/);
    if (m) return m[1].replace(/^['"]|['"]$/g, "");
  }
  throw new Error("GROQ_API_KEY not found in root .env");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function pickHeaders(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    if (k.startsWith("x-ratelimit-") || k === "retry-after") out[k] = v;
  });
  return out;
}

async function transcribe(key: string, file: string, bytes: Buffer, v: Variant): Promise<Result> {
  const res: Result = {
    file, model: v.model, prompt: v.prompt, status: null, latencyMs: 0,
    attempts: 0, retried429: 0, error: null, text: null, rateLimitHeaders: {},
  };
  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    res.attempts = attempt;
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(bytes)], { type: "audio/ogg" }), "audio.ogg");
    form.append("model", v.model);
    form.append("language", "es");
    form.append("temperature", "0");
    form.append("response_format", "json");
    if (v.prompt) form.append("prompt", PROMPT);
    const t0 = performance.now();
    try {
      const r = await fetch(ENDPOINT, { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form });
      res.latencyMs = Math.round(performance.now() - t0);
      res.status = r.status;
      res.rateLimitHeaders = pickHeaders(r.headers);
      const body = await r.text();
      if (r.ok) {
        res.text = (JSON.parse(body) as { text: string }).text;
        res.error = null;
        return res;
      }
      let msg = body.slice(0, 300);
      try { msg = (JSON.parse(body) as { error?: { message?: string } }).error?.message ?? msg; } catch { /* keep raw */ }
      res.error = `HTTP ${r.status}: ${msg}`;
      if (r.status === 429 && attempt <= MAX_RETRIES) {
        res.retried429++;
        const ra = Number(r.headers.get("retry-after"));
        const wait = Math.min(Number.isFinite(ra) && ra > 0 ? ra : 2 ** attempt, MAX_WAIT_S);
        console.log(`  429, waiting ${wait}s (retry ${attempt}/${MAX_RETRIES})`);
        await sleep(wait * 1000 + 250);
        continue;
      }
      return res;
    } catch (e) {
      res.latencyMs = Math.round(performance.now() - t0);
      res.error = `network: ${(e as Error).message}`;
      if (attempt <= MAX_RETRIES) { await sleep(1000 * attempt); continue; }
      return res;
    }
  }
  return res;
}

async function main() {
  const key = await loadKey();
  const dir = resolve(ROOT, "samples");
  const files = (await readdir(dir)).filter((f) => f.toLowerCase().endsWith(".ogg")).sort();
  if (!files.length) throw new Error("no samples/*.ogg found");
  await mkdir(OUT, { recursive: true });

  const variants: Variant[] = MODELS.flatMap((model) => [{ model, prompt: false }, { model, prompt: true }]);
  const results: Result[] = [];
  for (const [i, f] of files.entries()) {
    const bytes = await readFile(resolve(dir, f));
    for (const v of variants) {
      const r = await transcribe(key, `sample-${String(i + 1).padStart(2, "0")}`, bytes, v);
      r.file = f;
      results.push(r);
      console.log(`${String(i + 1).padStart(2, "0")} ${v.model} prompt=${v.prompt ? "on " : "off"} status=${r.status} ${r.latencyMs}ms${r.error ? " ERR" : ""}`);
    }
  }

  await writeFile(resolve(OUT, "results.json"), JSON.stringify(results, null, 2));

  let md = "# Transcripts (local review only, do not commit)\n\n";
  for (const [i, f] of files.entries()) {
    md += `## ${i + 1}. ${f}\n\n| Variant | Transcript |\n|---|---|\n`;
    for (const r of results.filter((x) => x.file === f)) {
      const t = (r.text ?? `ERROR: ${r.error}`).replace(/\|/g, "\\|").replace(/\n/g, " ");
      md += `| ${r.model} / prompt ${r.prompt ? "on" : "off"} | ${t} |\n`;
    }
    md += "\n";
  }
  await writeFile(resolve(OUT, "transcripts.md"), md);

  // Metrics only (no transcript text)
  console.log("\nMETRICS");
  for (const v of variants) {
    const rs = results.filter((r) => r.model === v.model && r.prompt === v.prompt);
    const lat = rs.map((r) => r.latencyMs);
    const mean = Math.round(lat.reduce((a, b) => a + b, 0) / lat.length);
    const errs = rs.filter((r) => r.error).length;
    const retried = rs.reduce((a, r) => a + r.retried429, 0);
    console.log(`${v.model} prompt=${v.prompt ? "on" : "off"} n=${rs.length} mean=${mean}ms max=${Math.max(...lat)}ms errors=${errs} retries429=${retried}`);
  }
  const hdrs = new Map<string, Set<string>>();
  for (const r of results) for (const [k, val] of Object.entries(r.rateLimitHeaders)) {
    if (!hdrs.has(k)) hdrs.set(k, new Set());
    hdrs.get(k)!.add(val);
  }
  console.log("\nRATE-LIMIT HEADERS (distinct values, first 4)");
  for (const [k, s] of hdrs) console.log(`${k}: ${[...s].slice(0, 4).join(" | ")}`);
  console.log(`\nwrote ${basename(OUT)}/results.json and transcripts.md`);
}

main().catch((e) => { console.error((e as Error).message); process.exit(1); });
