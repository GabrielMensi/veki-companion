# Spike 4: vision (Gemini free tier + Groq fallback)

Question: can a free vision LLM (1) pick the best photos for a post and (2) describe a product in Veky's tone and extract catalog attributes?
This README contains only metrics and conclusions. Inputs (frames), raw outputs and `out/review.md` are private and gitignored.

## Run

```sh
# needs ../../.env with GEMINI_API_KEY and GROQ_API_KEY, and frames in out/frames/ (<video>_f<N>.jpg)
# plus out/exclusions.json {"excluded": [...]} listing frames that must NOT be uploaded (privacy gate)
npm i
npm run typecheck
npx tsx src/run.ts gemini [model]   # default model gemini-3.5-flash-lite
npx tsx src/run.ts groq             # qwen/qwen3.8-27b
npx tsx src/review.ts               # builds out/review.md for human review
```

Frames come from `ffmpeg -ss <t> -i video -frames:v 1 -vf scale='min(1024,iw)':-2` (8 evenly spaced per video, 3 videos).
Every frame was inspected by a person before upload; frames with a visible person, or any doubt, were excluded (8 of 24).
Each request is repeated 3 times; bounded retry (3 retries, honours `retry-after`, exponential otherwise) on 429/5xx.

## Verified model facts (2026-11-17)

- Gemini: current stable Flash models per https://aistudio.google.com/docs/models: `gemini-3.8-flash`, `gemini-3.6-flash`, `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite`. `gemini-2.5-flash` is deprecated (auto-routed to `gemini-3.5-flash-lite` on 2026-12-01); `gemini-2.0-*` and `gemini-3.1-flash-lite-preview` are shut down. Free-tier numbers are not published on https://aistudio.google.com/docs/rate-limits (it points to the AI Studio dashboard), so limits were not verified.
- Chosen: `gemini-3.5-flash-lite` (cheapest stable tier; accepted images and `responseSchema` JSON in this spike).
- `gemini-2.5-flash-lite` is still listed by the models endpoint, but every request returned 404 NOT_FOUND with this key, so it is not a usable comparison.
- Groq: https://console.groq.com/docs/vision lists a single generally available vision model, `qwen/qwen3.8-27b` (max 3 images per request, JSON mode, 2048 tokens per image); `meta-models/muse-spark-open` is limited preview (needs contacting Groq). The live `/models` list matches (`qwen/qwen3.8-27b` is the only vision id). Free-tier limits seen in response headers for this model: 8,000 tokens/min, 1,000 requests/day (https://console.groq.com/docs/rate-limits).

## Metrics (24 frames, 16 usable: v1=5, v2=4, v3=7; 3 runs per task)

| Provider / model | Requests | OK + valid JSON | 429 | Other errors | Latency mean / max | Latency median | Mean tokens in / out |
|---|---|---|---|---|---|---|---|
| Gemini `gemini-3.5-flash-lite` | 17 | 16 | 0 | 503 UNAVAILABLE on 13 of 29 attempts (12 retries issued; 1 request failed after 3 retries) | 45.3 s / 378.8 s (incl. retries) | 14.4 s | 3,359 / 158 |
| Groq `qwen/qwen3.8-27b` | 18 | 17 | 21 attempts (token-per-minute cap, 8K TPM) | 1 request failed (429 after 3 retries) | 46.0 s / 195.8 s (incl. retries) | 38.8 s | 1,677 / 163 |

Latency includes retry waits. Gemini requests with no retry took 3.5 to 35 s (median of all 17 requests 14.4 s; fastest five 3.5 to 8 s).

Consistency of Task A across 3 runs (same top-1 frame? mean pairwise Jaccard of the top-3 sets):

| Video | Gemini top-1 stable | Gemini Jaccard | Groq top-1 stable | Groq Jaccard |
|---|---|---|---|---|
| v1 (5 usable) | yes (2 runs, 1 failed on 503) | 0.50 | yes | 1.00 |
| v2 (4 usable) | no (2 distinct top-1 in 3 runs) | 1.00 | yes | 1.00 |
| v3 (7 usable) | yes | 1.00 | yes | 1.00 |

Caveats: Groq accepts at most 3 images per request, so it ranked 3 evenly spaced usable frames per video; its top-3 set is always the same 3 frames, so its Jaccard of 1.00 is trivial and only the top-1 stability is informative. Gemini ranked all usable frames of a video in one request. For Task B each run described the best frame of that run's ranking. Quality of picks and captions needs human judgment on `out/review.md`; the metrics above say nothing about quality. Task B returned schema-valid JSON in every successful call (all keys present, caption and alt text in Spanish); caption length and hashtag count were not machine-checked.

## Recommendation

1. Keep Gemini as primary vision provider, with `gemini-3.5-flash-lite`: structured JSON output was valid in every successful request and multi-image ranking works in one request. Do not rely on it to be fast or always up: in this spike its 503 rate was high (13 of 29 attempts), so the bot must retry with backoff (3.5 to 8 s is the best case; a single request needed 379 s with retries) and answer the user asynchronously ("estoy mirando tus fotos") instead of blocking.
2. Fallback: Groq `qwen/qwen3.8-27b` works with the same prompts and valid JSON, but the free tier is tight for images (8K tokens/min gave 21 retried 429s in only 18 requests; max 3 images per request, so the bot would need to pre-select 3 frames or chunk). Treat it as a degraded fallback. OpenRouter `:free` vision (the docs' original fallback) was not tested here.
3. Top-1 pick stability is not guaranteed (Gemini changed top-1 in one of three videos). Product flow should show the top 3 and let the user confirm, which already matches principle 3 (nothing is published without confirmation).
4. Run the human review of `out/review.md` before locking the decision on caption quality and tone.

## Risks

- **Data use on the free tier:** Gemini free tier data may be used to improve Google products and reviewed by humans. Only product photos should be sent; never frames with people, personal text or the personal chat. This spike enforced that by manual frame review (8 of 24 excluded).
- **Deprecations:** model ids churn quickly (2.0 shut down, 2.5-flash deprecated with a 2026-12-01 reroute, a 2.5-flash-lite id that 404s despite being listed). Make the model id configuration, not code, and re-check before launch.
- **Unverified limits:** Gemini free-tier RPM/RPD are not published in the docs page and were not measured beyond 29 attempts; check the AI Studio dashboard.
- **Small sample:** 3 videos, 16 frames, 3 runs each. Consistency numbers are indicative only.
- **Groq vision availability:** one GA vision model; Groq has retired free models before.
