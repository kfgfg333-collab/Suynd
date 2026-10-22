import cron from "node-cron";
import { notifyRelease } from "./bot.js";
import { env } from "./env.js";
import { runRadar } from "./services/radar.js";
import { pruneOld } from "./services/wave.js";

export function startJobs() {
  // Каждый час: чистим историю старше 3 дней
  cron.schedule("5 * * * *", () => {
    const r = pruneOld();
    if (r.plays || r.seen) console.log(`🧹 Удалено из истории: ${r.plays}, из волны: ${r.seen}`);
  });
  pruneOld();

  // Каждый час: радар релизов
  cron.schedule("17 * * * *", async () => {
    try {
      const n = await runRadar(env.botDisabled ? undefined : notifyRelease);
      if (n) console.log(`📡 Новых релизов: ${n}`);
    } catch (err) {
      console.error("Радар упал:", err);
    }
  });
}
