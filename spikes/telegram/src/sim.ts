// Offline simulation: no polling, no network. API calls are stubbed via a transformer.
import assert from "node:assert/strict";
import { Bot } from "grammy";
import { registerHandlers } from "./handlers.js";

const MB = 1024 * 1024;
type Call = { method: string; payload: any };

async function run(name: string, updates: any[], opts: { getFileTooBig?: boolean } = {}) {
  const calls: Call[] = [];
  const bot = new Bot("123:FAKE", {
    botInfo: ({ id: 1, is_bot: true, first_name: "t", username: "t", can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false }) as any,
  });
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload });
    if (method === "getFile" && opts.getFileTooBig) return { ok: false, error_code: 400, description: "Bad Request: file is too big" } as any;
    return { ok: true, result: { message_id: 1, date: 0, chat: { id: 1, type: "private" }, file_id: "x", file_unique_id: "x", file_path: "p" } } as any;
  });
  registerHandlers(bot, { saveChatId: async () => {}, log: () => {}, albumDebounceMs: 30 });
  let id = 0;
  for (const u of updates) await bot.handleUpdate({ update_id: ++id, message: { message_id: id, date: 0, chat: { id: 1, type: "private" }, from: { id: 1, is_bot: false, first_name: "u" }, ...u } });
  await new Promise((r) => setTimeout(r, 120));
  const replies = calls.filter((c) => c.method === "sendMessage").map((c) => String(c.payload.text));
  console.log(`\n[${name}]`);
  replies.forEach((r) => console.log("  reply:", r));
  return replies;
}
const vid = (extra: object) => ({ file_id: "f", file_unique_id: "u", duration: 10, ...extra });

let r = await run("video 5 MB", [{ video: vid({ width: 1, height: 1, file_size: 5 * MB }) }]);
assert.equal(r.length, 1); assert.match(r[0]!, /Recibí 1 video.*5\.0 MB/);

r = await run("document video/mp4 5 MB", [{ document: vid({ mime_type: "video/mp4", file_size: 5 * MB, file_name: "a.mp4" }) }]);
assert.equal(r.length, 1); assert.match(r[0]!, /Recibí 1 video/);

r = await run("document video/mp4 24.5 MB", [{ document: vid({ mime_type: "video/mp4", file_size: 24.5 * MB }) }]);
assert.equal(r.length, 1); assert.match(r[0]!, /24\.5 MB.*20 MB/);

r = await run("video 24.5 MB", [{ video: vid({ width: 1, height: 1, file_size: 24.5 * MB }) }]);
assert.match(r[0]!, /24\.5 MB.*20 MB/);

r = await run("video_note", [{ video_note: vid({ length: 240, file_size: 1 * MB }) }]);
assert.match(r[0]!, /Recibí 1 video/);

r = await run("animation", [{ animation: vid({ width: 1, height: 1, file_size: 1 * MB }) }]);
assert.match(r[0]!, /Recibí 1 video/);

r = await run("video, size metadata missing, getFile 400 too big", [{ video: vid({ width: 1, height: 1 }) }], { getFileTooBig: true });
assert.equal(r.length, 1); assert.match(r[0]!, /más de 20 MB/);

r = await run("album of 2 videos (grouped, one reply)", [
  { media_group_id: "g", video: vid({ width: 1, height: 1, file_size: 3 * MB }) },
  { media_group_id: "g", document: vid({ mime_type: "video/quicktime", file_size: 4 * MB }) },
]);
assert.equal(r.length, 1); assert.match(r[0]!, /Recibí 2 videos/);

r = await run("album: 2 photos + 1 video", [
  { media_group_id: "h", photo: [{ file_id: "p", file_unique_id: "p", width: 1, height: 1, file_size: 100 }] },
  { media_group_id: "h", photo: [{ file_id: "p", file_unique_id: "p", width: 1, height: 1, file_size: 100 }] },
  { media_group_id: "h", video: vid({ width: 1, height: 1, file_size: 3 * MB }) },
]);
assert.equal(r.length, 3); assert.match(r[0]!, /2 fotos/); assert.match(r[2]!, /Recibí 1 video/);

r = await run("text", [{ text: "hola" }]);
assert.equal(r.length, 1); assert.match(r[0]!, /Por ahora entiendo/);

r = await run("non-video document", [{ document: vid({ mime_type: "application/pdf", file_size: 1000 }) }]);
assert.match(r[0]!, /Por ahora entiendo/);

console.log("\nALL ASSERTIONS PASSED");
