import { createHash } from "node:crypto";

/*
 * Структурные логи одной JSON-строкой. Тексты запросов, ключи и токены не пишем:
 * вместо запроса — короткий хэш, по которому можно сопоставить повторы.
 */
const quiet = Boolean(process.env.NODE_TEST_CONTEXT);

export function log(level: "info" | "warn", event: string, fields: Record<string, unknown> = {}) {
  if (quiet) return;
  const line = JSON.stringify({ level, time: new Date().toISOString(), event, ...fields });
  if (level === "warn") console.warn(line);
  else console.log(line);
}

export const queryHash = (q: string) => createHash("sha256").update(q.toLowerCase()).digest("hex").slice(0, 10);
