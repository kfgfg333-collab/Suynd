import { buildApp } from "./app.js";
import { startBot } from "./bot.js";
import { env } from "./env.js";
import { startJobs } from "./jobs.js";

const app = await buildApp();
await app.listen({ port: env.port, host: "0.0.0.0" });
console.log(`🚀 API слушает порт ${env.port}`);

if (env.botDisabled) console.log("ℹ️ BOT_DISABLED=true — бот не запущен");
else await startBot().catch((err) => console.error("❌ Бот не запустился (проверьте BOT_TOKEN):", err.message));
startJobs();
