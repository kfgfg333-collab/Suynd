/* Веб-поиск в живой сети. Запуск: npm run test:live */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.BOT_TOKEN ??= "123456:TEST";
process.env.ALLOWED_USER_ID ??= "42";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "suynd-weblive-"));
process.env.BOT_DISABLED = "true";
const hasTavily = Boolean(process.env.TAVILY_API_KEY);
const hasYandex = Boolean(process.env.YANDEX_SEARCH_API_KEY && process.env.YANDEX_FOLDER_ID);

const { checkPage, scoreHit, tavily, yandex, webSearch } = await import("../src/services/web.js");
const target = { title: "Скам", artist: "Scally Milano", duration: 153, cover: null };

test("реальная страница трека Deezer: открывается, разметка песни, длительность совпадает с каталогом", async () => {
  const page = await checkPage("https://www.deezer.com/en/track/1409013642");
  assert.equal(page.status, "ok");
  assert.equal(page.songPage, true);
  assert.equal(page.duration, 153);
  assert.ok(scoreHit(target, { url: "https://www.deezer.com/en/track/1409013642", title: "Scally Milano - Скам | Deezer", snippet: "", backend: "live" }, page) > 1);
});

test("реальная страница Spotify с другой песней («Scam», 188 с) отсекается", async () => {
  const url = "https://open.spotify.com/track/42ElbuYwDwtbccQQRUMyuu";
  const page = await checkPage(url);
  assert.equal(page.status, "ok");
  assert.equal(scoreHit(target, { url, title: "Scam - song and lyrics by Scally Milano, Tatarin | Spotify", snippet: "", backend: "live" }, page), 0);
});

test("поисковые API отвечают «неверный ключ» понятной ошибкой (реальные запросы с заведомо неверным ключом)", { skip: (hasTavily || hasYandex) && "заданы настоящие ключи" }, async () => {
  const { env } = await import("../src/env.js");
  env.webSearch.tavilyApiKey = "tvly-invalid";
  env.webSearch.yandexApiKey = "invalid";
  env.webSearch.yandexFolderId = "b1ginvalid";
  await assert.rejects(tavily.search("test"), /Tavily: неверный ключ API \(HTTP 401\)/);
  await assert.rejects(yandex.search("test"), /Yandex: неверный ключ API \(HTTP 401\)/);
  env.webSearch.tavilyApiKey = env.webSearch.yandexApiKey = env.webSearch.yandexFolderId = "";
});

test("реальный веб-поиск: находит открывающуюся страницу с Kevin MacLeod — Monkeys Spinning Monkeys", { skip: !hasTavily && !hasYandex && "не заданы TAVILY_API_KEY или YANDEX_SEARCH_API_KEY + YANDEX_FOLDER_ID" }, async () => {
  const started = Date.now();
  const r = await webSearch.search("Kevin MacLeod Monkeys Spinning Monkeys");
  console.log(`веб-поиск: ${Date.now() - started} мс, запросов к API: ${r.queries}, лучший: ${r.best?.url} [${r.best?.verified}]`);
  assert.ok(r.best, "результат найден");
  assert.ok(!/youtube|youtu\.be/.test(r.best!.url));
});
