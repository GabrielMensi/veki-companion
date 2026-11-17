// Spike: vision LLM for ranking product photos and describing products.
// Usage: tsx src/run.ts [gemini|groq|all] [model]
// Reads ../../.env (GEMINI_API_KEY, GROQ_API_KEY). Inputs/outputs live in out/ (gitignored).
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const out = join(root, "out");
const framesDir = join(out, "frames");

function loadEnv(): void {
  for (const p of [join(root, "..", "..", ".env"), join(root, ".env")]) {
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}
loadEnv();

const RUNS = 3;
const MAX_RETRIES = 3;
const GEMINI_MODEL = process.argv[3] ?? "gemini-3.5-flash-lite";
const GROQ_MODEL = "qwen/qwen3.8-27b";
const GROQ_MAX_IMAGES = 3; // documented limit per request

type Provider = "gemini" | "groq";
interface Call {
  provider: Provider; model: string; task: "rank" | "describe"; video: string; run: number;
  status: number; latencyMs: number; retries: number; rateLimited429: number;
  inTokens?: number; outTokens?: number; thoughtTokens?: number; valid: boolean;
  error?: string; rlHeaders?: Record<string, string>;
}
const calls: Call[] = [];
const results: Record<string, any> = {};

const exclusions: string[] = JSON.parse(readFileSync(join(out, "exclusions.json"), "utf8")).excluded;
const allFrames = readdirSync(framesDir).filter((f) => f.endsWith(".jpg")).sort();
const videos: Record<string, string[]> = {};
for (const f of allFrames) {
  if (exclusions.includes(f)) continue; // privacy gate: never upload excluded frames
  (videos[f.split("_")[0]] ??= []).push(f);
}

const BRAND =
  "Veky es una marca argentina de accesorios textiles artesanales (carteras, riñoneras, neceseres) con diseño creativo y colorido. " +
  "Tono: alegre, cálido, cercano, creativo, espontáneo; nunca minimalista ni frío. Español de Argentina, informal, con 'vos'.";

const rankPrompt = (files: string[], k: number) =>
  `${BRAND}\nSon fotos sacadas de un video de un puesto de feria. Elegí las ${k} mejores fotos para un posteo de Instagram, ` +
  `ordenadas de mejor a peor. Criterios: nitidez, luz, composición, visibilidad del producto. ` +
  `Para cada una dá el nombre de archivo exacto (uno de: ${files.join(", ")}) y un motivo corto (máx 20 palabras). ` +
  `Respondé solo JSON: {"best":[{"file":"...","reason":"..."}]}`;

const describePrompt = (file: string) =>
  `${BRAND}\nMirá la foto ${file}. Respondé solo JSON con estas claves: ` +
  `product_type (string), colors (array de strings), pattern_or_material (string), probable_use (string), ` +
  `caption_es (epígrafe de Instagram en el tono de la marca, máx 40 palabras, con 3 a 5 hashtags al final), alt_text_es (string).`;

const rankSchema = {
  type: "OBJECT",
  properties: { best: { type: "ARRAY", items: { type: "OBJECT",
    properties: { file: { type: "STRING" }, reason: { type: "STRING" } }, required: ["file", "reason"] } } },
  required: ["best"],
};
const describeSchema = {
  type: "OBJECT",
  properties: {
    product_type: { type: "STRING" }, colors: { type: "ARRAY", items: { type: "STRING" } },
    pattern_or_material: { type: "STRING" }, probable_use: { type: "STRING" },
    caption_es: { type: "STRING" }, alt_text_es: { type: "STRING" },
  },
  required: ["product_type", "colors", "pattern_or_material", "probable_use", "caption_es", "alt_text_es"],
};

const b64 = (f: string) => readFileSync(join(framesDir, f)).toString("base64");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withRetry(
  meta: Omit<Call, "status" | "latencyMs" | "retries" | "rateLimited429" | "valid">,
  doFetch: () => Promise<Response>,
  parse: (j: any) => { text: string; inT?: number; outT?: number; thT?: number },
  check: (o: any) => boolean,
): Promise<any | null> {
  let retries = 0, n429 = 0;
  const t0 = Date.now();
  for (let attempt = 0; ; attempt++) {
    let res: Response | undefined, body: any, err: string | undefined;
    try { res = await doFetch(); body = await res.json().catch(() => ({})); } catch (e) { err = String(e).slice(0, 120); }
    const retryable = !res || res.status === 429 || res.status >= 500;
    if (res?.status === 429) n429++;
    console.log(`  [${meta.provider}/${meta.task}/${meta.video}/r${meta.run}] attempt ${attempt} status=${res?.status ?? 0} ${err ?? ""}`);
    if (retryable && attempt < MAX_RETRIES) {
      retries++;
      const ra = Number(res?.headers.get("retry-after"));
      const wait = Math.min(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 4000 * 2 ** attempt, 65000);
      await sleep(wait);
      continue;
    }
    const rl: Record<string, string> = {};
    res?.headers.forEach((v, k) => { if (/ratelimit|retry-after/i.test(k)) rl[k] = v; });
    let parsed: any = null, valid = false;
    let u: ReturnType<typeof parse> | undefined;
    if (res?.ok) {
      try { u = parse(body); parsed = JSON.parse(u.text.replace(/^```json\s*|```\s*$/g, "")); valid = check(parsed); } catch { valid = false; }
    }
    calls.push({ ...meta, status: res?.status ?? 0, latencyMs: Date.now() - t0, retries, rateLimited429: n429,
      inTokens: u?.inT, outTokens: u?.outT, thoughtTokens: u?.thT, valid,
      error: err ?? (res && !res.ok ? JSON.stringify(body?.error?.status ?? body?.error?.code ?? res.status) : undefined),
      rlHeaders: Object.keys(rl).length ? rl : undefined });
    return valid ? parsed : null;
  }
}

function gemini(files: string[], prompt: string, schema: object, meta: any) {
  const key = process.env.GEMINI_API_KEY!;
  const parts: any[] = [{ text: prompt }];
  for (const f of files) {
    parts.push({ text: `Archivo: ${f}` });
    parts.push({ inlineData: { mimeType: "image/jpeg", data: b64(f) } });
  }
  const body = JSON.stringify({ contents: [{ role: "user", parts }],
    generationConfig: { responseMimeType: "application/json", responseSchema: schema, temperature: 0.7 } });
  return withRetry({ ...meta, provider: "gemini", model: GEMINI_MODEL },
    () => fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": key }, body }),
    (j) => ({ text: j.candidates[0].content.parts.filter((p: any) => !p.thought).map((p: any) => p.text).join(""),
      inT: j.usageMetadata?.promptTokenCount, outT: j.usageMetadata?.candidatesTokenCount, thT: j.usageMetadata?.thoughtsTokenCount }),
    meta.check);
}

function groq(files: string[], prompt: string, meta: any) {
  const key = process.env.GROQ_API_KEY!;
  const content: any[] = [{ type: "text", text: prompt }];
  for (const f of files) {
    content.push({ type: "text", text: `Archivo: ${f}` });
    content.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64(f)}` } });
  }
  const body = JSON.stringify({ model: GROQ_MODEL, messages: [{ role: "user", content }],
    response_format: { type: "json_object" }, temperature: 0.7 });
  return withRetry({ ...meta, provider: "groq", model: GROQ_MODEL },
    () => fetch("https://api.groq.com/openai/v1/chat/completions",
      { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body }),
    (j) => ({ text: j.choices[0].message.content, inT: j.usage?.prompt_tokens, outT: j.usage?.completion_tokens }),
    meta.check);
}

async function runProvider(p: Provider): Promise<void> {
  for (const [video, usable] of Object.entries(videos)) {
    if (usable.length < 3) { console.log(`${video}: only ${usable.length} usable frames, skipped`); continue; }
    // Groq accepts max 3 images: use 3 evenly spaced usable frames.
    const files = p === "groq" && usable.length > GROQ_MAX_IMAGES
      ? [0, Math.floor((usable.length - 1) / 2), usable.length - 1].map((i) => usable[i]) : usable;
    const k = 3;
    for (let run = 1; run <= RUNS; run++) {
      const rcheck = (o: any) => Array.isArray(o?.best) && o.best.length >= 1 && o.best.every((b: any) => files.includes(b.file));
      const meta = { task: "rank" as const, video, run, check: rcheck };
      const rank = p === "gemini"
        ? await gemini(files, rankPrompt(files, k), rankSchema, meta)
        : await groq(files, rankPrompt(files, k), meta);
      results[`${p}|${video}|rank|${run}`] = { files, rank };
      const best: string | undefined = rank?.best?.[0]?.file;
      if (!best) continue;
      const dcheck = (o: any) => typeof o?.caption_es === "string" && Array.isArray(o?.colors) && typeof o?.alt_text_es === "string";
      const dmeta = { task: "describe" as const, video, run, check: dcheck };
      const desc = p === "gemini"
        ? await gemini([best], describePrompt(best), describeSchema, dmeta)
        : await groq([best], describePrompt(best), dmeta);
      results[`${p}|${video}|describe|${run}`] = { file: best, desc };
      process.stdout.write(`${p} ${video} run${run} ok\n`);
    }
  }
}

const which = process.argv[2] ?? "all";
if (which === "gemini" || which === "all") await runProvider("gemini");
if (which === "groq" || which === "all") await runProvider("groq");

mkdirSync(out, { recursive: true });
const tag = which === "gemini" ? `gemini-${GEMINI_MODEL}` : which;
writeFileSync(join(out, `raw-${tag}.json`), JSON.stringify({ calls, results }, null, 1));

// ---- metrics (no model text) ----
const summary: any[] = [];
for (const p of ["gemini", "groq"] as Provider[]) {
  const cs = calls.filter((c) => c.provider === p);
  if (!cs.length) continue;
  const lat = cs.map((c) => c.latencyMs);
  const perVideo: any = {};
  for (const v of Object.keys(videos)) {
    const rs = [1, 2, 3].map((r) => results[`${p}|${v}|rank|${r}`]?.rank?.best?.map((b: any) => b.file) as string[] | undefined).filter(Boolean) as string[][];
    if (!rs.length) continue;
    const top1 = rs.map((r) => r[0]);
    const sets = rs.map((r) => new Set(r));
    let j = 0, pairs = 0;
    for (let a = 0; a < sets.length; a++) for (let b = a + 1; b < sets.length; b++) {
      const inter = [...sets[a]].filter((x) => sets[b].has(x)).length;
      j += inter / new Set([...sets[a], ...sets[b]]).size; pairs++;
    }
    perVideo[v] = { runs: rs.length, top1Same: new Set(top1).size === 1, distinctTop1: new Set(top1).size,
      meanJaccardTop3: pairs ? +(j / pairs).toFixed(2) : null };
  }
  summary.push({
    provider: p, model: cs[0].model, requests: cs.length,
    ok: cs.filter((c) => c.status === 200).length, validJson: cs.filter((c) => c.valid).length,
    http429: cs.reduce((s, c) => s + c.rateLimited429, 0), retries: cs.reduce((s, c) => s + c.retries, 0),
    errors: cs.filter((c) => c.status !== 200).map((c) => `${c.task}/${c.video}/r${c.run}:${c.status}${c.error ? ":" + c.error : ""}`),
    latencyMeanMs: Math.round(lat.reduce((a, b) => a + b, 0) / lat.length), latencyMaxMs: Math.max(...lat),
    meanInTokens: Math.round(cs.reduce((s, c) => s + (c.inTokens ?? 0), 0) / cs.length),
    meanOutTokens: Math.round(cs.reduce((s, c) => s + (c.outTokens ?? 0), 0) / cs.length),
    meanThoughtTokens: Math.round(cs.reduce((s, c) => s + (c.thoughtTokens ?? 0), 0) / cs.length),
    rateLimitHeaders: cs.find((c) => c.rlHeaders)?.rlHeaders, consistency: perVideo,
  });
}
writeFileSync(join(out, `metrics-${tag}.json`), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
