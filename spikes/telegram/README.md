# Spike: Telegram bot

Minimal grammY bot that exercises what Veki depends on (docs/00, D1, sections 6 and 8): photo albums, voice notes, short videos, confirm-with-buttons, proactive messages.

## Layout

- `src/handlers.ts`: portable logic (grammY + web-standard APIs only). Movable to a Cloudflare Workers webhook.
- `src/node-io.ts`, `poll.ts`, `ping.ts`: Node-only edges (env, `out/chat.json`, long polling).
- Porting note: album grouping uses an in-memory debounce; on Workers it needs a Durable Object or D1 (isolates don't share memory).

## Run

Needs `TELEGRAM_BOT_TOKEN` in the repo-root `.env` (gitignored). Node 20+.

```sh
cd spikes/telegram
npm install
npm start        # long polling; send /start to the bot first
npm run ping     # proactive message to the stored chat
npm run check    # tsc --noEmit
```

## Manual test checklist (needs a phone)

1. `/start` to the bot: friendly greeting; `out/chat.json` is created.
2. Send a photo album (3+ photos): ONE reply with the count after ~2 s, then a preview with Sí / Cambiar / Cancelar.
3. Press each button (repeat the album per button): the message is edited with the result.
4. Send a single photo: same flow with count 1.
5. Send a voice note: reply that it was received; console logs size and duration.
6. Send a short video (<20 MB): reply with size and duration; console logs size.
7. Send a video over 20 MB: friendly "send a shorter clip" reply, no crash.
8. Send text/sticker: polite fallback reply.
9. Stop the bot and run `npm run ping`: message with buttons arrives; press a button.

## Results

| Test | Result (OK / fail) | Notes |
|---|---|---|
| /start + chat.json | OK | User test |
| Album grouped into one reply | OK | User test |
| Buttons Sí / Cancelar edit message | OK | User test |
| Button Cambiar | Not implemented, on purpose | Needs an LLM, out of scope for this spike |
| Single photo | OK | User test |
| Voice note (size, duration logged) | OK | Received and downloaded |
| Video (short and ~24.5 MB, camera and gallery) | Fail, being fixed | Bot answered the generic fallback; handler now covers video, document video/*, video_note, animation and media groups, and logs unknown shapes. Re-test needed |
| Video > 20 MB handled | Pending re-test | Simulated OK (`npm run test:sim`) |
| Unexpected update (text/sticker) | | |
| `npm run ping` with bot stopped | Sent | User is checking |
| Telegram video size limit in real fair videos | | |

Offline simulation (no network, no phone): `npm run test:sim`.
