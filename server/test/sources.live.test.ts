/* Живая проверка источников: реальные запросы, длительность и отдача аудио. Запуск: npm run test:live */
import assert from "node:assert/strict";
import { test } from "node:test";

process.env.BOT_TOKEN ??= "123456:TEST";
process.env.ALLOWED_USER_ID ??= "42";
process.env.DATA_DIR = process.env.TEST_DATA_DIR ?? "./data-test";
process.env.BOT_DISABLED = "true";

const { archive } = await import("../src/providers/archive.js");
const { audius } = await import("../src/providers/audius.js");
const { deezer } = await import("../src/providers/deezer.js");
const { jamendo } = await import("../src/providers/jamendo.js");
const { probeAudio } = await import("../src/services/search.js");
const { splitId } = await import("../src/services/tracks.js");

test("Deezer: только каталог — его треки никогда не помечены как полные", async () => {
  const list = await deezer.searchTracks("daft punk", 5);
  assert.ok(list.length > 0);
  assert.ok(list.every((t) => t.full === false));
});

test("Audius: полный трек, поток отдаёт аудио, длительность > 60 с", async () => {
  const list = await audius.trending(null, 10);
  const t = list.find((x) => x.duration > 60)!;
  assert.ok(t.full);
  assert.ok(await probeAudio(audius.streamUrl(splitId(t.id)[1])), "поток Audius не отдаётся");
});

test("Internet Archive: полные CC-файлы, файл реально скачивается", async () => {
  const list = await archive.searchTracks("jazz", 6);
  assert.ok(list.length > 0, "нет результатов");
  const t = list[0];
  assert.ok(t.full && t.duration >= 30);
  assert.ok(await probeAudio(archive.fileUrl(splitId(t.id)[1])!), "файл не отдаётся");
});

test("Jamendo: работает только с JAMENDO_CLIENT_ID", { skip: !jamendo.enabled() && "JAMENDO_CLIENT_ID не задан" }, async () => {
  const [t] = await jamendo.searchTracks("rock", 3);
  assert.ok(t.full && t.duration > 60);
});
