/*
 * yt-dlp не установлен: сервер не падает, YouTube отвечает понятной ошибкой, остальное работает.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

process.env.BOT_TOKEN = "123456:TEST";
process.env.ALLOWED_USER_ID = "42";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "suynd-test-"));
process.env.BOT_DISABLED = "true";
process.env.YT_DLP_PATH = path.join(os.tmpdir(), "definitely-not-installed", "yt-dlp");

const { buildApp } = await import("../src/app.js");
const { issueSession } = await import("../src/auth.js");
const { upsertTracks } = await import("../src/services/tracks.js");
const { ytdlp, YtDlpError } = await import("../src/providers/ytdlp.js");

const app = await buildApp();
const auth = { authorization: `Bearer ${issueSession(42).token}` };
after(() => app.close());

test("статус: yt-dlp не найден — диагностика, а не падение", async () => {
  const s = await ytdlp.status(true);
  assert.equal(s.available, false);
  assert.equal(s.code, "ytdlp_not_installed");
  const r = await app.inject({ url: "/api/sources/status", headers: auth });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().ytdlp.available, false);
  assert.doesNotMatch(r.body, /definitely-not-installed/, "путь на сервере не раскрывается");
});

test("поиск YouTube: понятная ошибка «не установлен», быстро", async () => {
  const started = Date.now();
  await assert.rejects(ytdlp.searchTracks("anything", 5), (e: unknown) => e instanceof YtDlpError && e.reason === "not_installed");
  assert.ok(Date.now() - started < 2000);
});

test("поток YouTube: 503 с кодом ytdlp_not_installed, остальные маршруты живы", async () => {
  upsertTracks([
    { id: "yt:okSong00001", source: "ytdlp", title: "T", artist: "A", artistId: null, album: null, albumId: null, cover: null, duration: 120, full: true, downloadable: false },
  ]);
  const r = await app.inject({ url: "/api/stream/yt:okSong00001", headers: auth });
  assert.equal(r.statusCode, 503);
  assert.equal(r.json().code, "ytdlp_not_installed");
  assert.match(r.json().message, /yt-dlp/);
  const check = await app.inject({ url: "/api/tracks/yt:okSong00001/download-check", headers: auth });
  assert.equal(check.statusCode, 200);
  assert.equal(check.json().downloadable, false);
  // Превью по-прежнему не играет, сервер отвечает
  assert.equal((await app.inject({ url: "/api/stream/dz:1", headers: auth })).statusCode, 410);
  assert.equal((await app.inject({ url: "/health" })).statusCode, 200);
  const fav = await app.inject({ url: "/api/favorites", headers: auth });
  assert.equal(fav.statusCode, 200);
});
