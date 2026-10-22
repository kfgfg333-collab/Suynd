import { env } from "./env.js";
import { getBot } from "./bot.js";

const pathCache = new Map<string, { path: string; expires: number }>();
export const TG_DOWNLOAD_LIMIT = 20 * 1024 * 1024;

/** Ссылка на файл в Telegram. Содержит токен бота — наружу её отдавать нельзя, только проксировать. */
export async function telegramFileUrl(fileId: string): Promise<string> {
  const hit = pathCache.get(fileId);
  if (hit && hit.expires > Date.now()) return `https://api.telegram.org/file/bot${env.botToken}/${hit.path}`;
  const file = await getBot().api.getFile(fileId);
  if (!file.file_path) throw new Error("Telegram не отдал путь к файлу");
  pathCache.set(fileId, { path: file.file_path, expires: Date.now() + 50 * 60 * 1000 });
  return `https://api.telegram.org/file/bot${env.botToken}/${file.file_path}`;
}
