/*
 * YouTube через yt-dlp: поиск, поток с Range, истёкшие ссылки, ошибки видео, скачивание только по лицензии.
 * Вместо настоящего yt-dlp — test/fixtures/fake-yt-dlp.mjs, вместо googlevideo — локальный сервер с тестовым WAV.
 * Сеть не нужна, чужая музыка не скачивается.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

const here = path.dirname(fileURLToPath(import.meta.url));
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "suynd-ytdlp-"));

/* Тестовый «googlevideo»: 70 секунд тишины в WAV с поддержкой Range */
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
const audioFile = wav(70);
const mediaRequests: { url: string; headers: http.IncomingHttpHeaders }[] = [];
const media = http.createServer((req, res) => {
  mediaRequests.push({ url: req.url ?? "", headers: req.headers });
  if (req.url?.startsWith("/expired")) {
    res.writeHead(403).end("expired");
    return;
  }
  const m = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
  if (m) {
    const start = Number(m[1]);
    const end = m[2] ? Math.min(Number(m[2]), audioFile.length - 1) : audioFile.length - 1;
    res.writeHead(206, {
      "content-type": "audio/wav",
      "content-length": String(end - start + 1),
      "content-range": `bytes ${start}-${end}/${audioFile.length}`,
      "accept-ranges": "bytes",
    });
    res.end(audioFile.subarray(start, end + 1));
    return;
  }
  res.writeHead(200, { "content-type": "audio/wav", "content-length": String(audioFile.length), "accept-ranges": "bytes" });
  res.end(audioFile);
});
await new Promise<void>((r) => media.listen(0, "127.0.0.1", r));
const mediaBase = `http://127.0.0.1:${(media.address() as AddressInfo).port}`;

const fake = path.join(here, "fixtures", "fake-yt-dlp.mjs");
fs.chmodSync(fake, 0o755);
process.env.BOT_TOKEN = "123456:TEST";
process.env.ALLOWED_USER_ID = "42";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "suynd-test-"));
process.env.BOT_DISABLED = "true";
process.env.YT_DLP_PATH = fake;
process.env.YT_DLP_TIMEOUT_MS = "5000";
process.env.YT_DLP_MAX_CONCURRENCY = "2";
process.env.FAKE_STATE_DIR = stateDir;
process.env.FAKE_MEDIA_BASE = mediaBase;

const { buildApp } = await import("../src/app.js");
const { issueSession } = await import("../src/auth.js");
const { upsertTracks, getTracks, isValidTrackId } = await import("../src/services/tracks.js");
const { ytdlp, ytdlpTesting, classifyYtDlpError, mapVideo, parseVideoTitle, YtDlpError } = await import("../src/providers/ytdlp.js");
const { isConfirmedFull } = await import("../src/services/fullOnly.js");
const { findFullVersion } = await import("../src/services/fullVersion.js");
const { dedupeFull, preferLicensed } = await import("../src/routes/catalog.js");
const { scoreCandidate, variantMarks } = await import("../src/services/fullVersion.js");
type Track = import("../src/types.js").Track;

ytdlpTesting.allowMediaUrl((u) => u.protocol === "http:" && u.hostname === "127.0.0.1");
ytdlpTesting.setRetryDelays([20, 20]);
const app = await buildApp();
const auth = { authorization: `Bearer ${issueSession(42).token}` };

after(async () => {
  await app.close();
  media.close();
});

const calls = () =>
  fs.existsSync(path.join(stateDir, "calls.jsonl"))
    ? fs.readFileSync(path.join(stateDir, "calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[])
    : [];
const resolveCalls = (id: string) => calls().filter((a) => a.includes("--print") && a.at(-1)!.endsWith(id)).length;

const ytTrack = (id: string, duration = 70): Track => ({
  id: `yt:${id}`,
  source: "ytdlp",
  title: "Test Song",
  artist: "Test Artist",
  artistId: null,
  album: null,
  albumId: null,
  cover: null,
  duration,
  full: true,
  downloadable: false,
});

test("yt-dlp: статус показывает установленную версию", async () => {
  const s = await ytdlp.status(true);
  assert.equal(s.available, true);
  assert.equal(s.version, "2026.10.21");
  // Node, на котором работает сервер, передаётся yt-dlp как JS-рантайм для YouTube
  const r = await app.inject({ url: "/api/sources/status", headers: auth });
  assert.equal(r.json().ytdlp.available, true);
});

test("поиск: только публичные полные ролики, без превью, эфиров, дублей и чужих сайтов", async () => {
  const items = await ytdlp.searchTracks("test song", 10);
  assert.deepEqual(
    items.map((t) => t.id),
    ["yt:okSong00001", "yt:topic000001"],
  );
  const [first, topic] = items;
  assert.equal(first.source, "ytdlp");
  assert.equal(first.artist, "Test Artist");
  assert.equal(first.title, "Test Song", "мусор вроде (Official Video) убран");
  assert.equal(topic.artist, "Some Band", "канал «… - Topic» → имя артиста");
  assert.equal(first.downloadable, false, "право на скачивание не подразумевается");
  assert.ok(items.every(isConfirmedFull));
  assert.ok(items.every((t) => isValidTrackId(t.id)));
});

test("поиск: пользовательский ввод — один аргумент процесса, без оболочки", async () => {
  const evil = `x"; rm -rf / $(id) \`whoami\` --exec touch`;
  await ytdlp.searchTracks(evil, 3);
  const call = calls().find((a) => a.some((x) => x.includes("rm -rf")))!;
  assert.ok(call, "yt-dlp вызван");
  assert.equal(call.at(-1), `ytsearch3:${evil}`, "запрос целиком в одном аргументе с префиксом ytsearch");
  assert.ok(!call.includes("--exec"), "строка запроса не превратилась в опцию");
  assert.ok(call.includes("--ignore-config"));
});

test("поиск: повторный запрос берётся из кэша, без нового процесса", async () => {
  const before = calls().length;
  await ytdlp.searchTracks("test song", 10);
  assert.equal(calls().length, before);
});

test("поиск: пустая выдача — пустой список", async () => {
  assert.deepEqual(await ytdlp.searchTracks("empty", 5), []);
  assert.deepEqual(await ytdlp.searchTracks("   ", 5), []);
});

test("тайм-аут: зависший yt-dlp убивается, ошибка понятная", async () => {
  const started = Date.now();
  await assert.rejects(ytdlp.searchTracks("slow query", 5), (e: unknown) => e instanceof YtDlpError && e.reason === "timeout" && e.status === 504);
  assert.ok(Date.now() - started < 9000);
  assert.equal(ytdlpTesting.active, 0, "слот процесса освобождён");
});

test("параллельность ограничена: не больше 2 процессов, лишние ждут или получают «занято»", async () => {
  let peak = 0;
  const timer = setInterval(() => (peak = Math.max(peak, ytdlpTesting.active)), 5);
  const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => ytdlp.searchTracks(`wait ${i}`, 2)));
  clearInterval(timer);
  assert.ok(peak <= 2, `одновременно было ${peak}`);
  const busy = results.filter((r) => r.status === "rejected" && r.reason instanceof YtDlpError && r.reason.reason === "busy");
  assert.ok(busy.length >= 1, "очередь ограничена");
  assert.ok(results.some((r) => r.status === "fulfilled"));
});

test("поток: Range, Content-Range, Content-Length и тип; Cookie источнику не пересылается", async () => {
  upsertTracks([ytTrack("okSong00001")]);
  const r = await app.inject({ url: "/api/stream/yt:okSong00001", headers: { ...auth, range: "bytes=0-99" } });
  assert.equal(r.statusCode, 206);
  assert.equal(r.headers["content-range"], `bytes 0-99/${audioFile.length}`);
  assert.equal(r.headers["content-length"], "100");
  assert.equal(r.headers["accept-ranges"], "bytes");
  assert.match(String(r.headers["content-type"]), /^audio\//);
  assert.equal(r.rawPayload.length, 100);
  const sent = mediaRequests.at(-1)!;
  assert.equal(sent.headers["user-agent"], "FakeAgent/1.0", "заголовки yt-dlp переданы");
  assert.equal(sent.headers.cookie, undefined, "cookie не утекает");
});

test("перемотка: следующий Range идёт по той же ссылке, yt-dlp не запускается заново", async () => {
  const before = resolveCalls("okSong00001");
  const r = await app.inject({ url: "/api/stream/yt:okSong00001", headers: { ...auth, range: "bytes=500000-500999" } });
  assert.equal(r.statusCode, 206);
  assert.equal(r.rawPayload.length, 1000);
  assert.equal(resolveCalls("okSong00001"), before);
});

test("истёкшая ссылка: источник ответил 403 — берём свежую и играем", async () => {
  upsertTracks([ytTrack("expired0001")]);
  const r = await app.inject({ url: "/api/stream/yt:expired0001", headers: { ...auth, range: "bytes=0-9" } });
  assert.equal(r.statusCode, 206);
  assert.equal(resolveCalls("expired0001"), 2);
});

test("ошибки видео: удалено, регион, приватное, проверка на бота, возраст, DRM — понятные коды, сервер жив", async () => {
  const cases: [string, number, string][] = [
    ["removed0001", 410, "ytdlp_unavailable"],
    ["geo00000001", 451, "ytdlp_geo"],
    ["private0001", 403, "ytdlp_private"],
    ["botcheck001", 503, "ytdlp_bot_check"],
    ["agegate0001", 403, "ytdlp_age"],
    ["drm00000001", 451, "ytdlp_drm"],
    ["liveNow0001", 422, "ytdlp_live"],
    ["shortClip01", 422, "ytdlp_too_short"],
    ["evilHost001", 502, "ytdlp_no_audio"],
    ["huge0000001", 502, "ytdlp_failed"],
  ];
  for (const [id, status, code] of cases) {
    const r = await app.inject({ url: `/api/stream/yt:${id}`, headers: auth });
    assert.equal(r.statusCode, status, id);
    assert.equal(r.json().code, code, id);
    assert.ok(r.json().message.length > 10, id);
    assert.doesNotMatch(r.body, /ERROR:|must-not-leak/, "сырой stderr и секреты не попадают в ответ");
  }
  // Повтор той же ошибки берётся из короткого кэша, без нового процесса
  const before = resolveCalls("removed0001");
  await app.inject({ url: "/api/stream/yt:removed0001", headers: auth });
  assert.equal(resolveCalls("removed0001"), before);
  assert.equal((await app.inject({ url: "/health" })).statusCode, 200);
});

test("невалидный id: 400 без запуска yt-dlp", async () => {
  const before = calls().length;
  for (const bad of ["yt:short", "yt:..%2F..%2Fetc", "yt:-rf%20%2F%20aa"]) {
    const r = await app.inject({ url: `/api/stream/${bad}`, headers: auth });
    assert.equal(r.statusCode, 400, bad);
  }
  assert.equal(calls().length, before);
  assert.equal(isValidTrackId("yt:okSong00001"), true);
  assert.equal(isValidTrackId("yt:okSong0000"), false);
});

test("ролик короче заявленного трека не выдаётся за полную версию", async () => {
  upsertTracks([ytTrack("mismatch001", 240)]);
  const r = await app.inject({ url: "/api/stream/yt:mismatch001", headers: auth });
  assert.equal(r.statusCode, 422);
  assert.equal(r.json().code, "not_full");
});

test("скачивание: обычный ролик — запрещено, ролик под Creative Commons — разрешено с верным расширением", async () => {
  upsertTracks([ytTrack("okSong00001"), ytTrack("ccSong00001")]);
  const denied = await app.inject({ url: "/api/download/yt:okSong00001", headers: auth });
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json().code, "ytdlp_download_forbidden");
  const check = await app.inject({ url: "/api/tracks/yt:okSong00001/download-check", headers: auth });
  assert.equal(check.json().downloadable, false);

  const okCheck = await app.inject({ url: "/api/tracks/yt:ccSong00001/download-check", headers: auth });
  assert.equal(okCheck.json().downloadable, true);
  assert.equal(getTracks(["yt:ccSong00001"])[0].downloadable, true, "лицензия запомнена");
  const ok = await app.inject({ url: "/api/download/yt:ccSong00001", headers: auth });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.rawPayload.length, audioFile.length);
  assert.match(String(ok.headers["content-disposition"]), /\.wav$/, "расширение по типу файла, не «всегда .mp3»");
});

test("избранное и история принимают трек YouTube; флаги клиента не принимаются на веру", async () => {
  const fav = await app.inject({ method: "PUT", url: "/api/favorites/yt:topic000001", headers: auth, payload: { track: { ...ytTrack("topic000001"), downloadable: true } } });
  assert.equal(fav.statusCode, 200, fav.body);
  assert.equal(getTracks(["yt:topic000001"])[0].downloadable, false, "клиент не может объявить ролик скачиваемым");
  const plays = await app.inject({ method: "POST", url: "/api/plays", headers: auth, payload: { track: ytTrack("okSong00001") } });
  assert.equal(plays.statusCode, 200, plays.body);
  // Превью Deezer под видом полного трека Audius
  const fake = { ...ytTrack("x"), id: "dz:777", source: "audius", full: true, duration: 200 };
  const forged = await app.inject({ method: "POST", url: "/api/plays", headers: auth, payload: { track: fake } });
  assert.equal(forged.statusCode, 422);
});

test("поиск полной версии: YouTube спрашивается один раз, найденная версия проверяется реальным потоком", async () => {
  const target: Track = { ...ytTrack("x"), id: "dz:1", source: "deezer", full: false, title: "Test Song", artist: "Test Artist", duration: 120 };
  let ytQueries = 0;
  const yt = Object.assign(
    async (q: string) => {
      ytQueries++;
      return ytdlp.searchTracks(q, 5);
    },
    { firstQueryOnly: true },
  );
  const r = await findFullVersion(target, {
    providers: [async () => [], yt],
    streamUrlOf: async (t) => (t.id.startsWith("yt:") ? ytdlp.streamUrl(t.id.slice(3)) : null),
    probe: async (url) => {
      const res = await fetch(url, { headers: { range: "bytes=0-1023" } });
      await res.body?.cancel();
      return res.status === 206 && (res.headers.get("content-type") ?? "").startsWith("audio/");
    },
    library: () => [],
  });
  assert.equal(ytQueries, 1);
  assert.equal(r.track?.id, "yt:okSong00001");
});

test("разбор ошибок и названий", () => {
  assert.equal(classifyYtDlpError("ERROR: Sign in to confirm you’re not a bot. Use --cookies"), "bot_check");
  assert.equal(classifyYtDlpError("ERROR: This video is available to this channel's members"), "auth");
  assert.equal(classifyYtDlpError("ERROR: Join this channel to get access to members-only content"), "auth");
  assert.equal(classifyYtDlpError("ERROR: HTTP Error 429: Too Many Requests"), "rate_limited");
  assert.equal(classifyYtDlpError("ERROR: Video unavailable"), "unavailable");
  assert.deepEqual(parseVideoTitle("Artist — Song [Official Music Video]", "ArtistVEVO"), { artist: "Artist", title: "Song" });
  assert.deepEqual(parseVideoTitle("Song", "Artist - Topic"), { artist: "Artist", title: "Song" });
  assert.equal(mapVideo({ id: "abcdefghijk", title: "Song (Snippet)", duration: 90 }), null);
  assert.equal(mapVideo({ id: "abcdefghijk", title: "Song #shorts", duration: 50 }), null);
  assert.equal(mapVideo({ id: "abcdefghijk", title: "Song", duration: 44 }), null);
  assert.ok(mapVideo({ id: "abcdefghijk", title: "Song", duration: 180 }));
  assert.equal(mapVideo({ id: "abcdefghijk", title: "Song [1 HOUR]", duration: 3750 }), null, "зацикленная версия — не трек");
  assert.equal(mapVideo({ id: "abcdefghijk", title: "Song", duration: 36_000 }), null);
  assert.deepEqual(parseVideoTitle("Kevin MacLeod: Monkeys", "Kevin MacLeod Archive"), { artist: "Kevin MacLeod", title: "Monkeys" });
  assert.deepEqual(parseVideoTitle("Part 1: Intro", "Some Channel"), { artist: "Some Channel", title: "Part 1: Intro" });
  assert.deepEqual(parseVideoTitle("Monkeys - Kevin MacLeod (No Copyright Music)", "Kevin MacLeod"), { artist: "Kevin MacLeod", title: "Monkeys" });
});

test("одна запись из Internet Archive и YouTube показывается один раз (видео на пару секунд длиннее)", () => {
  const ia: Track = { ...ytTrack("x"), id: "ia:QUJDRC9maWxl", source: "archive", artist: "Kevin MacLeod", title: "Monkeys Spinning Monkeys", duration: 125, downloadable: true };
  const yt: Track = { ...ytTrack("LrM_Y39Gmhk"), artist: "Kevin MacLeod", title: "Monkeys Spinning Monkeys", duration: 131 };
  const ytCover: Track = { ...ytTrack("coverVer001"), artist: "Kevin MacLeod", title: "Monkeys Spinning Monkeys", duration: 240 };
  assert.deepEqual(dedupeFull([yt, ia, ytCover]).map((t) => t.id), ["ia:QUJDRC9maWxl", "yt:coverVer001"]);
});

test("диагностика: версия, yt-dlp-ejs и JS-рантайм видны, прокси и его пароль — нет", async () => {
  const r = await app.inject({ url: "/api/sources/status", headers: auth });
  const s = r.json().ytdlp;
  assert.equal(s.version, "2026.10.21");
  assert.equal(s.jsChallengeSolver, true);
  assert.equal(s.jsRuntime, "node-22.0.0");
  assert.deepEqual(s.cookies, { configured: false, usable: false });
  assert.doesNotMatch(r.body, /proxy-secret|Proxy map/);
});

test("временная сетевая ошибка: ограниченные повторы с паузой, затем успех", async () => {
  upsertTracks([ytTrack("flaky000001")]);
  const r = await app.inject({ url: "/api/stream/yt:flaky000001", headers: { ...auth, range: "bytes=0-9" } });
  assert.equal(r.statusCode, 206);
  assert.equal(resolveCalls("flaky000001"), 3, "две неудачи + успешная попытка");
});

test("постоянная сетевая ошибка: не больше 3 попыток, понятный код, без бесконечных повторов", async () => {
  const r = await app.inject({ url: "/api/stream/yt:netdown0001", headers: auth });
  assert.equal(r.statusCode, 503);
  assert.equal(r.json().code, "ytdlp_network");
  assert.equal(resolveCalls("netdown0001"), 3);
  // Сразу повторный запрос (обновление страницы) — ответ из кэша неудач, без нового процесса
  await app.inject({ url: "/api/stream/yt:netdown0001", headers: auth });
  assert.equal(resolveCalls("netdown0001"), 3);
});

test("постоянная ошибка (видео удалено) не повторяется", async () => {
  ytdlpTesting.reset();
  const before = resolveCalls("removed0001");
  const r = await app.inject({ url: "/api/stream/yt:removed0001", headers: auth });
  assert.equal(r.json().code, "ytdlp_unavailable");
  assert.equal(resolveCalls("removed0001") - before, 1);
});

test("медиасервер отвечает 403 и на свежую ссылку: код ytdlp_forbidden, неудача запомнена", async () => {
  upsertTracks([ytTrack("forbid00001")]);
  const r = await app.inject({ url: "/api/stream/yt:forbid00001", headers: { ...auth, range: "bytes=0-" } });
  assert.equal(r.statusCode, 502);
  assert.equal(r.json().code, "ytdlp_forbidden");
  assert.match(r.json().message, /403/);
  assert.equal(resolveCalls("forbid00001"), 2, "одна свежая ссылка после 403 — и всё");
  // Перемотка и обновление страницы не запускают yt-dlp снова
  for (const range of ["bytes=1000-", "bytes=50000-"]) {
    const again = await app.inject({ url: "/api/stream/yt:forbid00001", headers: { ...auth, range } });
    assert.equal(again.json().code, "ytdlp_forbidden");
  }
  assert.equal(resolveCalls("forbid00001"), 2);
  const st = (await app.inject({ url: "/api/sources/status", headers: auth })).json().ytdlp;
  assert.equal(st.lastStreamError.code, "ytdlp_forbidden");
});

test("медиасервер недоступен по сети: временная ошибка ytdlp_network, не «видео удалено»", async () => {
  upsertTracks([ytTrack("deadHost001")]);
  ytdlpTesting.allowMediaUrl((u) => u.protocol === "http:" && u.hostname === "127.0.0.1");
  const r = await app.inject({ url: "/api/stream/yt:deadHost001", headers: auth });
  assert.equal(r.statusCode, 503);
  assert.equal(r.json().code, "ytdlp_network");
});

test("одновременные запросы одного трека запускают один процесс yt-dlp", async () => {
  upsertTracks([ytTrack("parallel001")]);
  const rs = await Promise.all(
    Array.from({ length: 5 }, (_, i) => app.inject({ url: "/api/stream/yt:parallel001", headers: { ...auth, range: `bytes=${i * 10}-${i * 10 + 9}` } })),
  );
  assert.ok(rs.every((r) => r.statusCode === 206));
  assert.equal(resolveCalls("parallel001"), 1);
});

test("разбор stderr: 403, сеть, тайм-аут сокета", () => {
  assert.equal(classifyYtDlpError("ERROR: unable to download video data: HTTP Error 403: Forbidden"), "forbidden");
  assert.equal(classifyYtDlpError("ERROR: [youtube] x: Unable to download webpage: <urlopen error timed out>"), "network");
  assert.equal(classifyYtDlpError("ERROR: Unable to download API page: HTTP Error 503: Service Unavailable"), "network");
  assert.equal(classifyYtDlpError("ERROR: Sign in to confirm you’re not a bot. Unable to download webpage"), "bot_check");
});

test("оригинал не подменяется ремиксом, кавером или утечкой", () => {
  assert.equal(variantMarks("Скам"), "");
  assert.equal(variantMarks("Scam (Leaked)"), "leak");
  assert.equal(variantMarks("Скам (ремикс)"), "ремикс");
  const target = { title: "Скам", artist: "Scally Milano", duration: 154 };
  const mk = (id: string, title: string, source: Track["source"], duration = 154): Track => ({ ...ytTrack("x"), id, source, title, artist: "Scally Milano", duration });
  assert.ok(scoreCandidate(target, mk("au:a", "Скам", "audius")) > 0);
  assert.equal(scoreCandidate(target, mk("au:b", "Скам (Remix)", "audius")), 0);
  assert.equal(scoreCandidate(target, mk("au:c", "Скам (Leaked)", "audius")), 0);
  assert.equal(scoreCandidate(target, mk("au:d", "Скам (Cover)", "audius")), 0);
});

test("поиск: та же запись из разрешённого источника заменяет ролик YouTube, ремикс — нет", () => {
  const mk = (id: string, title: string, source: Track["source"], duration = 154): Track => ({ ...ytTrack("x"), id, source, title, artist: "Scally Milano", duration });
  const yt = mk("yt:5Fu5ZzqUpNg", "Скам", "ytdlp", 154);
  const au = mk("au:same", "Скам", "audius", 152);
  const remix = mk("au:remix", "Скам (Remix)", "audius", 160);
  assert.deepEqual(preferLicensed([yt, au]).map((t) => t.id), ["au:same"]);
  assert.deepEqual(preferLicensed([yt, remix]).map((t) => t.id), ["yt:5Fu5ZzqUpNg", "au:remix"]);
});

test("альтернатива для YouTube ищется без YouTube и проверяется реальным потоком", async () => {
  const target: Track = { ...ytTrack("forbid00001"), title: "Test Song", artist: "Test Artist", duration: 70 };
  const ytP = Object.assign(async () => [{ ...ytTrack("okSong00001"), title: "Test Song", artist: "Test Artist" }], { source: "ytdlp" as const });
  const auP = Object.assign(
    async () => [
      { ...ytTrack("x"), id: "au:dead", source: "audius" as const, title: "Test Song", artist: "Test Artist", duration: 70 },
      { ...ytTrack("x"), id: "au:live", source: "audius" as const, title: "Test Song", artist: "Test Artist", duration: 71 },
    ],
    { source: "audius" as const },
  );
  const r = await findFullVersion(target, {
    providers: [ytP, auP],
    excludeSources: ["ytdlp"],
    streamUrlOf: async (t) => (t.id === "au:live" ? `${mediaBase}/audio.wav` : `${mediaBase}/expired`),
    probe: async (url) => (await fetch(url, { headers: { range: "bytes=0-9" } })).status === 206,
    library: () => [],
  });
  assert.equal(r.track?.id, "au:live", "недоступный кандидат отклонён, YouTube не предлагается");
  assert.ok(r.checked.every((c) => c.source !== "ytdlp"));
});
