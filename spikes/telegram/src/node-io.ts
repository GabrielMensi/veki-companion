// Node-only edge: env loading, file storage, logging.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import type { Deps } from "./handlers.js";

const here = dirname(fileURLToPath(import.meta.url));
export const OUT = resolve(here, "../out");
const CHAT_FILE = resolve(OUT, "chat.json");

export function loadToken(): string {
  // .env lives at the repo/worktree root (two levels above spikes/telegram)
  for (const p of [resolve(here, "../../../.env"), resolve(here, "../.env")]) {
    try { process.loadEnvFile(p); break; } catch { /* try next */ }
  }
  const t = process.env.TELEGRAM_BOT_TOKEN;
  if (!t) throw new Error("TELEGRAM_BOT_TOKEN missing (expected in .env)");
  return t;
}

export async function readChatId(): Promise<number | undefined> {
  try { return JSON.parse(await readFile(CHAT_FILE, "utf8")).chatId; } catch { return undefined; }
}

export const nodeDeps: Deps = {
  async saveChatId(id) {
    await mkdir(OUT, { recursive: true });
    await writeFile(CHAT_FILE, JSON.stringify({ chatId: id }));
  },
  log: (msg, data) => console.log(new Date().toISOString(), msg, data ? JSON.stringify(data) : ""),
};
