/*
 * Необязательный файл cookies: используется только если он есть и доступен; путь и содержимое не раскрываются.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

const here = path.dirname(fileURLToPath(import.meta.url));
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "suynd-ytc-"));
const cookies = path.join(stateDir, "private-yt-cookies.txt");
fs.writeFileSync(cookies, "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tvery-secret-value\n", { mode: 0o644 });
fs.chmodSync(cookies, 0o644);

process.env.BOT_TOKEN = "123456:TEST";
process.env.ALLOWED_USER_ID = "42";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "suynd-test-"));
process.env.BOT_DISABLED = "true";
process.env.YT_DLP_PATH = path.join(here, "fixtures", "fake-yt-dlp.mjs");
process.env.YT_DLP_COOKIES_FILE = cookies;
process.env.FAKE_STATE_DIR = stateDir;

const { buildApp } = await import("../src/app.js");
const { issueSession } = await import("../src/auth.js");
const { ytdlp, cookiesState } = await import("../src/providers/ytdlp.js");
const app = await buildApp();
const auth = { authorization: `Bearer ${issueSession(42).token}` };
after(() => app.close());

const lastCall = () => JSON.parse(fs.readFileSync(path.join(stateDir, "calls.jsonl"), "utf8").trim().split("\n").at(-1)!) as string[];

test("cookies: файл передаётся yt-dlp; открытые права — предупреждение; путь и содержимое не раскрываются", async () => {
  const r = await app.inject({ url: "/api/sources/status", headers: auth });
  const s = r.json().ytdlp;
  assert.equal(s.cookies.configured, true);
  assert.equal(s.cookies.usable, true);
  assert.match(s.warnings.join(" "), /chmod 600/);
  assert.doesNotMatch(r.body, /private-yt-cookies|very-secret-value/);
  await ytdlp.searchTracks("cookie check", 2);
  const call = lastCall();
  assert.equal(call[call.indexOf("--cookies") + 1], cookies);
});

test("cookies: при правах 600 предупреждения нет", () => {
  fs.chmodSync(cookies, 0o600);
  assert.deepEqual(cookiesState(), { configured: true, usable: true });
});

test("cookies: файл пропал — сервер работает без него и сообщает об этом", async () => {
  fs.rmSync(cookies);
  assert.equal(cookiesState().usable, false);
  await ytdlp.searchTracks("after removal", 2);
  assert.ok(!lastCall().includes("--cookies"), "отсутствующий файл не передаётся");
  const s = (await app.inject({ url: "/api/sources/status", headers: auth })).json().ytdlp;
  assert.equal(s.cookies.usable, false);
});
