# Spike: Groq Whisper for Rioplatense Spanish voice notes

Question: is Groq Whisper a viable free primary speech-to-text for the bot (decision in `docs/00-vision-y-decisiones.md`, section 5)?

This README holds metrics only. Transcript quality is reviewed by ear, locally, in `out/transcripts.md` (gitignored).

## Run

Requires Node 20+, `GROQ_API_KEY` in the repo-root `.env`, and the private `samples/*.ogg` in the repo root (both gitignored).

```sh
cd spikes/whisper
npm install
npm run transcribe   # 10 files x 2 models x prompt on/off = 40 requests
npm run typecheck    # tsc --noEmit
```

Outputs (gitignored, under `out/`): `results.json` (per-request status, latency, rate-limit headers, errors) and `transcripts.md` (4 variants side by side per audio).

Request: `POST https://api.groq.com/openai/v1/audio/transcriptions`, multipart, `language=es`, `temperature=0`, `response_format=json`. The hint prompt is a list of domain words (neceser, mantel, cartuchera, tela, bordado, feria, puesto). 429 responses are retried up to 4 times, honouring `retry-after` (capped at 120 s).

## Metrics (run of 2026-11-17, 10 notes of 8-13 s, sequential requests)

| Model | Prompt | n | Mean latency | Max latency | Errors | 429 retries |
|---|---|---|---|---|---|---|
| whisper-large-v3 | off | 10 | 472 ms | 598 ms | 0 | 0 |
| whisper-large-v3 | on | 10 | 457 ms | 569 ms | 0 | 0 |
| whisper-large-v3-turbo | off | 10 | 438 ms | 748 ms | 0 | 0 |
| whisper-large-v3-turbo | on | 10 | 429 ms | 643 ms | 0 | 0 |

All 40 requests returned HTTP 200. Latency differences between models and prompt settings are within noise at n=10.

### Rate-limit headers observed (all 200 responses; `retry-after` only appears on 429, never triggered)

| Header | Observed |
|---|---|
| `x-ratelimit-limit-requests` | 2000 (reset header counts down 43.2 s per request, i.e. 86400 s / 2000: a per-day budget) |
| `x-ratelimit-remaining-requests` | decremented by 1 per request |
| `x-ratelimit-limit-audio-seconds` | 7200 |
| `x-ratelimit-remaining-audio-seconds` | decremented by roughly 8-12 per request (about the audio duration) |
| `x-ratelimit-reset-audio-seconds` | a few seconds up to ~20 s, rising as the window fills |

Groq docs: minimum billed length is 10 s per request, max file 25 MB on free tier, prompt limit 224 tokens. The exact free-tier table was not on the fetched docs pages, so the numbers above come from the live headers of this account. Note the audio-seconds header may be an hourly window (docs name ASH/ASD limits); verify in the Groq console.

## Conclusions on viability

- **Quota:** the expected load is 20-100 notes/day of ~10-15 s. That is at most 100 requests (5% of the 2000 request budget) and about 1500 audio seconds a day, roughly 20% of one 7200 s window even if all arrived within one hour. Free tier is ample.
- **Latency:** about 0.4-0.5 s per 10 s note, no meaningful difference between models. Fits easily in a webhook plus background flow.
- **Reliability:** 0 errors, 0 rate-limit hits in 40 requests. Headers give enough information to back off cleanly, and the chain should still fall back to Workers AI Whisper (decision in section 5) on 429 or 5xx.
- **Model choice:** `whisper-large-v3-turbo` is as fast and has at most the same quota cost; choose between it and `whisper-large-v3` based on the by-ear review of `out/transcripts.md`. The prompt hint is cheap (no latency cost) and can be kept if the review shows it helps domain words.
- **Open items:** (1) quality verdict pending the user's listening review; (2) confirm the audio-seconds window (hour vs day) and the free plan limits in the Groq console; (3) data privacy: audio is sent to Groq, consistent with section 5 which keeps it as primary.
