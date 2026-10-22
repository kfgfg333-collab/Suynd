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
  // Необязательно: веб-поиск страниц, где можно послушать трек (официальные поисковые API)
  webSearch: {
    // Tavily: бесплатно 1000 запросов в месяц без карты — https://app.tavily.com
    tavilyApiKey: process.env.TAVILY_API_KEY?.trim() || "",
    // Яндекс Search API (платный, лучше всех находит русскоязычные страницы) — ключ сервисного аккаунта и каталог
    yandexApiKey: process.env.YANDEX_SEARCH_API_KEY?.trim() || "",
    yandexFolderId: process.env.YANDEX_FOLDER_ID?.trim() || "",
    // Потолок запросов к поисковым API в месяц (защита бюджета); 0 — без ограничения
    monthlyLimit: Number(process.env.WEB_SEARCH_MONTHLY_LIMIT ?? 900),
    // Домены, которые никогда не показывать (через запятую)
    blockedDomains: (process.env.WEB_SEARCH_BLOCKED_DOMAINS ?? "")
      .split(",")
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean),
  },
};

if (!Number.isFinite(env.allowedUserId) || env.allowedUserId <= 0) {
  console.error("❌ ALLOWED_USER_ID должен быть числом — вашим Telegram ID.");
  process.exit(1);
}
