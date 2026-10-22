/* Openverse (белый список хостов), кэш аудио (только подтверждённые полные файлы) и транслитерация */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.BOT_TOKEN = "123456:TEST";
process.env.ALLOWED_USER_ID = "42";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "suynd-extra-"));
process.env.BOT_DISABLED = "true";

const { encodeOpenverseId, openverseUrl } = await import("../src/providers/openverse.js");
const { fillCache, cachedPath } = await import("../src/services/audioCache.js");
const { queryVariants, translit } = await import("../src/services/translit.js");
const { isValidTrackId } = await import("../src/services/tracks.js");

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

test("Openverse: id хранит ссылку, но пропускает только разрешённые хосты", () => {
  const id = encodeOpenverseId("https://prod-1.storage.jamendo.com/?trackid=923463&format=mp32");
  assert.ok(isValidTrackId(id));
  assert.equal(openverseUrl(id.slice(3)), "https://prod-1.storage.jamendo.com/?trackid=923463&format=mp32");
  for (const bad of ["http://169.254.169.254/latest", "https://evil.example/a.mp3", "http://prod-1.storage.jamendo.com/x"]) {
    assert.equal(openverseUrl(encodeOpenverseId(bad).slice(3)), null, bad);
  }
});

test("кэш: полный файл сохраняется, обрезок — нет", async () => {
  const server = http.createServer((req, res) => {
    const body = req.url === "/full.wav" ? wav(60) : wav(20);
    res.writeHead(200, { "content-type": "audio/wav", "content-length": body.length });
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  try {
    assert.equal(await fillCache("ia:QUFBQS9mdWxs", `http://127.0.0.1:${port}/full.wav`, 60), true);
    assert.ok(cachedPath("ia:QUFBQS9mdWxs"));
    // Трек заявлен на 60 с, а файл — 20 с: в кэш не попадает
    assert.equal(await fillCache("ia:QUFBQS9jbGlw", `http://127.0.0.1:${port}/clip.wav`, 60), false);
    assert.equal(cachedPath("ia:QUFBQS9jbGlw"), null);
    // Audius не кэшируем (не CC)
    assert.equal(await fillCache("au:xyz", `http://127.0.0.1:${port}/full.wav`, 60), false);
  } finally {
    server.close();
  }
});

test("транслитерация: кириллический запрос получает латинские варианты", () => {
  assert.equal(translit("Скам"), "Skam");
  assert.deepEqual(queryVariants("Милано Скам"), ["Милано Скам", "Milano Скам", "Милано Skam", "Milano Skam"]);
  assert.deepEqual(queryVariants("daft punk"), ["daft punk"]);
});
