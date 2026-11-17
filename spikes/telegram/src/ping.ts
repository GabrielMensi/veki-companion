import { Bot } from "grammy";
import { sendPing } from "./handlers.js";
import { loadToken, nodeDeps, readChatId } from "./node-io.js";

const chatId = await readChatId();
if (!chatId) {
  console.error("No chat id stored. Send /start to the bot first (npm start).");
  process.exit(1);
}
await sendPing(new Bot(loadToken()), chatId);
nodeDeps.log("ping sent");
