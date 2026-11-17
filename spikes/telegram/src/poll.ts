import { Bot } from "grammy";
import { registerHandlers } from "./handlers.js";
import { loadToken, nodeDeps } from "./node-io.js";

const bot = new Bot(loadToken());
registerHandlers(bot, nodeDeps);

process.once("SIGINT", () => bot.stop());
process.once("SIGTERM", () => bot.stop());

await bot.start({
  allowed_updates: ["message", "callback_query"],
  onStart: (me) => nodeDeps.log(`polling as @${me.username}`),
});
