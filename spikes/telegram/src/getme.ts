import { Bot } from "grammy";
import { loadToken } from "./node-io.js";
const me = await new Bot(loadToken()).api.getMe();
console.log(`@${me.username}`);
