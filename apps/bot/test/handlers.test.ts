import { describe, expect, it } from "vitest";
import { FakeChatProvider, FakeSttProvider, InMemoryConversationStore, copy, type ToolHost } from "@veki/core";
import { handleText } from "../src/handlers/text";
import { handleVoice, telegramDownloader } from "../src/handlers/voice";

const host: ToolHost = { createPendingAction: async () => ({ id: "pa1" }) };
const reply = (texto: string) => ({
  text: null,
  toolCalls: [{ id: "c1", name: "responder", arguments: { texto } }],
  usage: { tokensIn: 1, tokensOut: 1 },
});
const audio = async () => ({ bytes: new Uint8Array([1, 2, 3]).buffer, mime: "audio/ogg" });

describe("handlers", () => {
  it("voice with fake STT gives the same result as text", async () => {
    const mk = () => ({ chat: new FakeChatProvider([reply("¿Cómo se llama?")]), host, store: new InMemoryConversationStore() });
    const t = await handleText(mk(), { chatId: 7, text: "quiero cargar una riñonera" });
    const stt = new FakeSttProvider([{ text: "quiero cargar una riñonera", lowConfidence: false }]);
    const v = await handleVoice({ ...mk(), stt, download: audio }, { chatId: 7, fileId: "f" });
    expect(v).toEqual(t);
    expect(stt.calls).toEqual([{ bytes: 3, mime: "audio/ogg" }]);
  });

  it("audio is never stored: history only has the transcript", async () => {
    const store = new InMemoryConversationStore();
    const stt = new FakeSttProvider([{ text: "hola veki", lowConfidence: false }]);
    await handleVoice({ chat: new FakeChatProvider([reply("¡Hola!")]), host, store, stt, download: audio }, { chatId: 7, fileId: "f" });
    expect((await store.load(7)).history).toEqual([
      { role: "user", content: "hola veki" },
      { role: "assistant", content: "¡Hola!" },
    ]);
  });

  it("STT down gives fixed copy and leaves the conversation untouched", async () => {
    const store = new InMemoryConversationStore();
    const chat = new FakeChatProvider([reply("x")]);
    const r = await handleVoice({ chat, host, store, stt: new FakeSttProvider([new Error("down")]), download: audio }, { chatId: 7, fileId: "f" });
    expect(r.texto).toBe(copy.noPudeEscuchar);
    expect(chat.requests).toHaveLength(0);
    expect(store.rows.size).toBe(0);
  });

  it("low confidence reaches the prompt", async () => {
    const chat = new FakeChatProvider([reply("¿Son $12.500?")]);
    const stt = new FakeSttProvider([{ text: "doce mil quinientos", lowConfidence: true }]);
    await handleVoice({ chat, host, store: new InMemoryConversationStore(), stt, download: audio }, { chatId: 7, fileId: "f" });
    expect(chat.requests[0]!.system).toContain("baja confianza");
  });

  it("telegramDownloader calls getFile then downloads", async () => {
    const urls: string[] = [];
    const f = (async (u: string) => {
      urls.push(u);
      return u.includes("getFile")
        ? new Response(JSON.stringify({ ok: true, result: { file_path: "voice/a.oga" } }))
        : new Response(new Uint8Array([9, 9]), { headers: { "content-type": "audio/ogg" } });
    }) as unknown as typeof fetch;
    const a = await telegramDownloader("TOKEN", f)("abc");
    expect(a.bytes.byteLength).toBe(2);
    expect(urls[1]).toBe("https://api.telegram.org/file/botTOKEN/voice/a.oga");
  });
});
