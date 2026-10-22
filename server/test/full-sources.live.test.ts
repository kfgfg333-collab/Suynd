/* 6. Полные треки реально играют и скачиваются (живая сеть). Запуск: npm run test:live */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.BOT_TOKEN ??= "123456:TEST";
process.env.ALLOWED_USER_ID ??= "42";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "suynd-live-"));
process.env.BOT_DISABLED = "true";

const { buildApp } = await import("../src/app.js");
const { issueSession } = await import("../src/auth.js");
const { parseBuffer } = await import("music-metadata");
type Track = import("../src/types.js").Track;

const app = await buildApp();
const auth = { authorization: `Bearer ${issueSession(42).token}` };

test("поиск возвращает только подтверждённые полные треки", async () => {
  const res = await app.inject({ method: "GET", url: "/api/search?q=lofi", headers: auth });
  const items = res.json().items as Track[];
  assert.ok(items.length > 0);
  for (const t of items) {
    assert.ok(["audius", "archive", "jamendo", "library"].includes(t.source), `${t.id} из ${t.source}`);
    assert.ok(t.full && t.duration >= 45, `${t.id}: ${t.duration} с`);
  }
});

test("полный трек Audius воспроизводится: поток отдаёт MP3, длительность совпадает", async () => {
  const items = (await app.inject({ method: "GET", url: "/api/trending", headers: auth })).json().items as Track[];
  const t = items.find((x) => x.duration > 60 && x.duration < 400)!;
  const res = await app.inject({ method: "GET", url: `/api/stream/${t.id}`, headers: auth });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers["content-type"]), /audio/);
  const meta = await parseBuffer(res.rawPayload, { mimeType: "audio/mpeg" }, { duration: true });
  const actual = meta.format.duration ?? 0;
  assert.ok(Math.abs(actual - t.duration) <= Math.max(5, t.duration * 0.05), `ожидали ${t.duration} с, получили ${actual}`);
});

test("полный трек Internet Archive скачивается целиком", async () => {
  const items = (await app.inject({ method: "GET", url: "/api/search?q=satie", headers: auth })).json().items as Track[];
  const t = items.find((x) => x.source === "archive" && x.downloadable && x.duration < 400);
  assert.ok(t, "нет подходящего трека Internet Archive");
  const res = await app.inject({ method: "GET", url: `/api/download/${t!.id}`, headers: auth });
  assert.equal(res.statusCode, 200);
  const meta = await parseBuffer(res.rawPayload, { mimeType: "audio/mpeg" }, { duration: true });
  assert.ok((meta.format.duration ?? 0) >= t!.duration * 0.9, `скачано ${meta.format.duration} из ${t!.duration} с`);
});
