/*
 * Доказательства, что превью в Suynd не воспроизводятся, не сохраняются и не скачиваются.
 * Сервер поднимается в памяти (app.inject), сеть не нужна.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.BOT_TOKEN = "123456:TEST";
process.env.ALLOWED_USER_ID = "42";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "suynd-test-"));
process.env.BOT_DISABLED = "true";

const { buildApp } = await import("../src/app.js");
const { issueSession } = await import("../src/auth.js");
const { db, schema } = await import("../src/db/index.js");
const { upsertTracks } = await import("../src/services/tracks.js");
const { onlyFull, isConfirmedFull, isFullLengthAudio } = await import("../src/services/fullOnly.js");
const { findFullVersion } = await import("../src/services/fullVersion.js");
const { dedupeFull } = await import("../src/routes/catalog.js");
const { verifyAudio } = await import("../src/services/importAudio.js");
type Track = import("../src/types.js").Track;

const base = { artistId: null, album: null, albumId: null, cover: null, downloadable: false } as const;
const preview: Track = { ...base, id: "dz:111", source: "deezer", title: "Hit Song", artist: "Star", duration: 30, full: false };
const deezerFullLen: Track = { ...base, id: "dz:112", source: "deezer", title: "Hit Song", artist: "Star", duration: 205, full: false };
const shortAudius: Track = { ...base, id: "au:short", source: "audius", title: "Hit Song (snippet)", artist: "Star", duration: 30, full: true };
const fullAudius: Track = { ...base, id: "au:full1", source: "audius", title: "Hit Song", artist: "Star", duration: 207, full: true, downloadable: true };
const fullArchive: Track = { ...base, id: "ia:QUJDRC9maWxlLm1wMw", source: "archive", title: "Hit Song", artist: "Star", duration: 204, full: true, downloadable: true };

const app = await buildApp();
const auth = { authorization: `Bearer ${issueSession(42).token}` };

function wav(seconds: number) {
  const rate = 8000;
  const n = rate * seconds;
  const b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + n * 2, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(n * 2, 40);
  return b;
}

test("1. 30-секундное превью не проходит как полноценный трек", () => {
  assert.equal(isConfirmedFull(preview), false);
  assert.equal(isConfirmedFull(deezerFullLen), false, "Deezer — только превью, даже если в метаданных длина песни");
  assert.equal(isConfirmedFull(shortAudius), false, "короткий фрагмент с флагом full не считается песней");
  assert.equal(isConfirmedFull(fullAudius), true);
  assert.deepEqual(onlyFull([preview, shortAudius, fullAudius, fullArchive]).map((t) => t.id), ["au:full1", "ia:QUJDRC9maWxlLm1wMw"]);
});

test("1b. Дубликаты из разных источников объединяются, остаётся одна полная версия", () => {
  const out = dedupeFull([fullArchive, fullAudius, preview]);
  assert.deepEqual(out.map((t) => t.id), ["au:full1"]);
});

test("2. Если первый источник даёт только превью, поиск идёт дальше и находит полную версию", async () => {
  const calls: string[] = [];
  const result = await findFullVersion(deezerFullLen, {
    providers: [
      async () => (calls.push("preview-source"), [preview, shortAudius]),
      async () => (calls.push("full-source"), [fullAudius]),
    ],
    library: () => [],
    streamUrlOf: async () => "https://example.test/audio.mp3",
    probe: async () => true,
  });
  assert.ok(calls.includes("preview-source") && calls.includes("full-source"));
  assert.equal(result.track?.id, "au:full1");
});

test("2b. Найденная ссылка не считается доказательством: недоступный поток отклоняется", async () => {
  const result = await findFullVersion(deezerFullLen, {
    providers: [async () => [fullAudius]],
    library: () => [],
    streamUrlOf: async () => "https://example.test/dead.mp3",
    probe: async () => false,
  });
  assert.equal(result.track, null);
  assert.equal(result.checked[0]?.ok, false);
});

test("2c. Если полной версии нигде нет — результат пустой, превью не подставляется", async () => {
  const result = await findFullVersion(deezerFullLen, {
    providers: [async () => [preview, shortAudius]],
    library: () => [],
    streamUrlOf: async () => "https://example.test/a.mp3",
    probe: async () => true,
  });
  assert.equal(result.track, null);
});

test("3. Плеер не получает поток для превью: /api/stream отвечает «полная версия недоступна»", async () => {
  for (const id of ["dz:3135556", "it:1440857781"]) {
    const res = await app.inject({ method: "GET", url: `/api/stream/${id}`, headers: auth });
    assert.equal(res.statusCode, 410, id);
    assert.match(res.json().message, /Полная версия недоступна/);
  }
});

test("4. Превью нельзя добавить в избранное, историю и плейлист", async () => {
  const fav = await app.inject({ method: "PUT", url: "/api/favorites/dz:111", headers: auth, payload: { track: preview } });
  assert.equal(fav.statusCode, 422);
  const play = await app.inject({ method: "POST", url: "/api/plays", headers: auth, payload: { track: preview } });
  assert.equal(play.statusCode, 422);
  const pl = await app.inject({ method: "POST", url: "/api/playlists", headers: auth, payload: { name: "T" } });
  const { playlist } = pl.json();
  const add = await app.inject({ method: "POST", url: `/api/playlists/${playlist.id}/tracks`, headers: auth, payload: { track: preview } });
  assert.equal(add.statusCode, 422);
});

test("4b. Старые записи превью в избранном и плейлистах скрываются из выдачи", async () => {
  upsertTracks([preview, fullAudius]);
  const now = Date.now();
  db.insert(schema.favorites).values([{ trackId: preview.id, createdAt: now }, { trackId: fullAudius.id, createdAt: now }]).onConflictDoNothing().run();
  const favs = (await app.inject({ method: "GET", url: "/api/favorites", headers: auth })).json().items as Track[];
  assert.deepEqual(favs.map((t) => t.id), ["au:full1"]);
  const ids = (await app.inject({ method: "GET", url: "/api/favorites/ids", headers: auth })).json().ids as string[];
  assert.deepEqual(ids, ["au:full1"]);

  const { playlist } = (await app.inject({ method: "POST", url: "/api/playlists", headers: auth, payload: { name: "Old" } })).json();
  db.insert(schema.playlistTracks).values([{ playlistId: playlist.id, trackId: preview.id, position: 0 }, { playlistId: playlist.id, trackId: fullAudius.id, position: 1 }]).run();
  const tracks = (await app.inject({ method: "GET", url: `/api/playlists/${playlist.id}`, headers: auth })).json().tracks as Track[];
  assert.deepEqual(tracks.map((t) => t.id), ["au:full1"]);
});

test("5. Загрузчик не отдаёт и не сохраняет фрагменты", async () => {
  const dl = await app.inject({ method: "GET", url: "/api/download/dz:111", headers: auth });
  assert.equal(dl.statusCode, 403);
  // Импорт короткого файла отклоняется проверкой реальной длительности аудио
  await assert.rejects(verifyAudio(wav(30), "audio/wav"), /фрагмент/);
  const ok = await verifyAudio(wav(60), "audio/wav");
  assert.equal(ok.duration, 60);
  // Правило, которым клиент проверяет скачанный файл
  assert.equal(isFullLengthAudio(205, 30), false);
  assert.equal(isFullLengthAudio(205, 120), false, "обрезка 120 из 205 с — не полный трек");
  assert.equal(isFullLengthAudio(205, 204), true);
});

test("5b. Загрузка короткого файла через приложение отклоняется сервером", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/library/upload",
    headers: { ...auth, "content-type": "application/octet-stream", "x-file-name": "clip.wav", "x-file-type": "audio/wav" },
    payload: wav(20),
  });
  assert.equal(res.statusCode, 422);
  assert.match(res.json().message, /фрагмент/);
});
