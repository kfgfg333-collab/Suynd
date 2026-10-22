import { config } from "dotenv";
import path from "node:path";

config({ quiet: true });

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`❌ Переменная ${name} не задана. Скопируйте .env.example в .env и заполните её.`);
    process.exit(1);
  }
  return value;
}

function clamp(n: number, min: number, max: number, fallback: number) {
  return Number.isFinite(n) ? Math.max(min, Math.min(Math.floor(n), max)) : fallback;
}

const isProd = process.env.NODE_ENV === "production";

export const env = {
  isProd,
  botToken: required("BOT_TOKEN"),
  allowedUserId: Number(required("ALLOWED_USER_ID")),
  webappUrl: (process.env.WEBAPP_URL ?? "http://localhost:5173").replace(/\/$/, ""),
  port: Number(process.env.PORT ?? 3000),
  dataDir: path.resolve(process.env.DATA_DIR ?? "./data"),
  sessionSecret: process.env.SESSION_SECRET || required("BOT_TOKEN"),
  devAuthBypass: !isProd && process.env.DEV_AUTH_BYPASS === "true",
  // Отключить бота (например, для локальных тестов без интернета до Telegram)
  botDisabled: process.env.BOT_DISABLED === "true",
  // Необязательно: бесплатный ключ Jamendo (https://devportal.jamendo.com) — ещё один источник полных треков
  jamendoClientId: process.env.JAMENDO_CLIENT_ID?.trim() || "",
  // Кэш полных аудиофайлов на диске сервера (CC-источники и ваши файлы). 0 — выключить
  audioCacheMb: Number(process.env.AUDIO_CACHE_MB ?? 1024),
  // Необязательно: YouTube через yt-dlp. Без бинарника остальные источники работают как обычно
  ytDlp: {
    enabled: process.env.YT_DLP_ENABLED !== "false",
    path: process.env.YT_DLP_PATH?.trim() || "yt-dlp",
    timeoutMs: clamp(Number(process.env.YT_DLP_TIMEOUT_MS ?? 18_000), 5_000, 60_000, 18_000),
    maxConcurrency: clamp(Number(process.env.YT_DLP_MAX_CONCURRENCY ?? 2), 1, 8, 2),
    // Файл cookies в формате Netscape на диске сервера (своего аккаунта). Никогда не кладите его в репозиторий
    cookiesFile: process.env.YT_DLP_COOKIES_FILE?.trim() || "",
  },
};

if (!Number.isFinite(env.allowedUserId) || env.allowedUserId <= 0) {
  console.error("❌ ALLOWED_USER_ID должен быть числом — вашим Telegram ID.");
  process.exit(1);
}
