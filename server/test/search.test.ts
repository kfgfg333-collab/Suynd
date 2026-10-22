/*
 * Агрегатор поиска: один лучший проверенный результат, без подмены оригинала и без превью.
 * Источники, каталог и проверка потока подменены — сеть не нужна.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

process.env.BOT_TOKEN = "123456:TEST";
process.env.ALLOWED_USER_ID = "42";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "suynd-search-"));
process.env.BOT_DISABLED = "true";

const { buildApp, redactUrl } = await import("../src/app.js");
const { issueSession } = await import("../src/auth.js");
const { createSearch, configureSearch, sanitizeQuery } = await import("../src/services/search.js");
const { namesTrack, queryScore, variantMarks } = await import("../src/services/match.js");
type Track = import("../src/types.js").Track;
type Provider = import("../src/providers/index.js").MusicProvider;
type Deps = import("../src/services/search.js").SearchDeps;

const t = (id: string, source: Track["source"], artist: string, title: string, duration: number, extra: Partial<Track> = {}): Track => ({
  id,
  source,
  title,
  artist,
  artistId: null,
  album: null,
  albumId: null,
  cover: null,
  duration,
  full: source !== "deezer",
  downloadable: false,
  ...extra,
});

// Каталог-эталон (Deezer): только метаданные
const skamRef = t("dz:100", "deezer", "Scally Milano", "Скам", 154);

const prov = (source: Track["source"], search: (q: string) => Promise<Track[]>, timeoutMs = 300): Provider => ({
  source,
  prefix: source,
  label: source,
  enabled: () => true,
  timeoutMs,
  search,
  streamUrl: async () => null,
});

function make(over: Partial<Deps> & { providers: Provider[] }) {
  const probed: string[] = [];
  const s = createSearch({
    catalog: async () => [],
    library: () => [],
    streamUrlOf: async (x) => `https://audio.test/${x.id}`,
    probe: async (url) => (probed.push(url), true),
    persist: () => {},
    ...over,
  });
  return { s, probed };
}

test("выбирается оригинал, а не ремикс, кавер, live, sped up или утечка", async () => {
  const pool = [
    t("au:remix", "audius", "Scally Milano", "Скам (Remix)", 160),
    t("au:cover", "audius", "Scally Milano", "Скам (Cover)", 150),
    t("au:live", "audius", "Scally Milano", "Скам (Live)", 170),
    t("au:sped", "audius", "Scally Milano", "Скам (Sped Up)", 120),
    t("ia:leak", "archive", "Scally Milano", "Скам (Leaked)", 154),
    t("jm:orig", "jamendo", "Scally Milano", "Скам", 155),
  ];
  const { s } = make({ providers: [prov("audius", async () => pool)], catalog: async () => [skamRef] });
  const r = await s.findBest("Scally Milano — Скам");
  assert.equal(r.mode, "track");
  assert.equal(r.best?.id, "jm:orig");
  assert.deepEqual(r.best?.alternates ?? [], []);
  assert.equal(r.catalog?.title, "Скам");
});

test("если есть только ремикс — результата нет, оригинал не подменяется; даются официальные ссылки", async () => {
  const { s } = make({
    providers: [prov("audius", async () => [t("au:remix", "audius", "Scally Milano", "Скам (Remix)", 160)])],
    catalog: async () => [{ ...skamRef, links: { deezer: "https://www.deezer.com/track/100", spotify: "https://open.spotify.com/search/x", yandex: "https://music.yandex.ru/search?text=x" } }],
  });
  const r = await s.findBest("scally milano скам");
  assert.equal(r.best, null);
  assert.equal(r.catalog?.artist, "Scally Milano");
  assert.equal(r.links?.deezer, "https://www.deezer.com/track/100");
});

test("превью и обрывки не становятся результатом, даже если других нет", async () => {
  const { s } = make({
    providers: [prov("audius", async () => [t("au:short", "audius", "Scally Milano", "Скам", 30), t("dz:1", "deezer", "Scally Milano", "Скам", 154)])],
    catalog: async () => [skamRef],
  });
  assert.equal((await s.findBest("Scally Milano Скам")).best, null);
});

test("длительность сверяется с эталоном: другая песня с тем же названием отклоняется", async () => {
  const { s } = make({
    providers: [prov("audius", async () => [t("au:other", "audius", "Scally Milano", "Скам", 260)])],
    catalog: async () => [skamRef],
  });
  assert.equal((await s.findBest("Scally Milano Скам")).best, null);
});

test("поток проверяется: неработающий кандидат пропускается, берётся следующий; дубли — запасные источники", async () => {
  const pool = [
    t("au:dead", "audius", "Scally Milano", "Скам", 154, { cover: "https://img.test/a.jpg" }),
    t("ia:ok", "archive", "Scally Milano", "Скам", 156),
    t("ov:also", "openverse", "Scally Milano", "Скам", 153),
  ];
  const { s, probed } = make({
    providers: [prov("audius", async () => pool)],
    catalog: async () => [skamRef],
    probe: async (url) => (probed.push(url), !url.includes("au:dead")),
  });
  const r = await s.findBest("Scally Milano Скам");
  assert.equal(r.best?.id, "ia:ok");
  assert.deepEqual(probed, ["https://audio.test/au:dead", "https://audio.test/ia:ok"]);
  assert.deepEqual(r.best?.alternates?.map((x) => x.id), ["au:dead", "ov:also"]);
});

test("ни один поток не работает — результата нет, а не «рабочий» трек", async () => {
  const { s } = make({
    providers: [prov("audius", async () => [t("au:a", "audius", "Scally Milano", "Скам", 154)])],
    catalog: async () => [skamRef],
    probe: async () => false,
  });
  assert.equal((await s.findBest("Scally Milano Скам")).best, null);
});

test("запрос по-русски: эталон из каталога находит латинское написание у источника", async () => {
  const seen: string[] = [];
  const { s } = make({
    providers: [
      prov("audius", async (q) => {
        seen.push(q);
        return q.startsWith("Scally") ? [t("au:latin", "audius", "Scally Milano", "Скам", 154)] : [];
      }),
    ],
    catalog: async () => [skamRef],
  });
  const r = await s.findBest("Скалли Милано Скам");
  assert.equal(r.best?.id, "au:latin");
  assert.ok(seen.includes("Scally Milano скам"), "второй запрос — каноническое написание из каталога");
});

test("запрос-исполнитель: лучший трек артиста плюс несколько других песен, без дублей", async () => {
  const pool = [
    t("au:1", "audius", "Kevin MacLeod", "Monkeys Spinning Monkeys", 125),
    t("ia:1", "archive", "Kevin MacLeod", "Monkeys Spinning Monkeys", 125),
    t("au:2", "audius", "Kevin MacLeod", "Sneaky Snitch", 135),
    t("au:3", "audius", "Somebody Else", "Unrelated", 200),
  ];
  const { s } = make({ providers: [prov("audius", async () => pool)] });
  const r = await s.findBest("Kevin MacLeod");
  assert.equal(r.mode, "artist");
  assert.equal(r.best?.id, "au:1");
  assert.deepEqual(r.best?.alternates?.map((x) => x.id), ["ia:1"]);
  assert.deepEqual(r.more.map((x) => x.id), ["au:2"]);
});

test("тайм-аут одного источника не мешает остальным; сбойный источник пропускается 30 с", async () => {
  let slowCalls = 0;
  const { s } = make({
    providers: [
      prov("archive", () => (slowCalls++, new Promise<Track[]>(() => {})), 100),
      prov("audius", async () => [t("au:1", "audius", "Kevin MacLeod", "Monkeys Spinning Monkeys", 125)]),
    ],
  });
  const started = Date.now();
  const r = await s.findBest("Kevin MacLeod Monkeys");
  assert.ok(Date.now() - started < 1500);
  assert.equal(r.best?.id, "au:1");
  assert.equal(r.partial, true);
  await s.findBest("Kevin MacLeod Sneaky");
  assert.equal(slowCalls, 1, "после сбоя источник не опрашивается");
});

test("ошибка источника не роняет поиск", async () => {
  const { s } = make({
    providers: [
      prov("jamendo", async () => {
        throw new Error("HTTP 500 от api.jamendo.com client_id=secret");
      }),
      prov("audius", async () => [t("au:1", "audius", "Kevin MacLeod", "Monkeys Spinning Monkeys", 125)]),
    ],
  });
  const r = await s.findBest("Kevin MacLeod Monkeys");
  assert.equal(r.best?.id, "au:1");
  assert.equal(r.partial, true);
});

test("одинаковые одновременные запросы — один поиск; повтор берётся из кэша", async () => {
  let calls = 0;
  const { s, probed } = make({
    providers: [prov("audius", async () => (calls++, await new Promise((r) => setTimeout(r, 50)), [t("au:1", "audius", "Kevin MacLeod", "Monkeys Spinning Monkeys", 125)]))],
  });
  await Promise.all([s.findBest("Kevin MacLeod Monkeys"), s.findBest("kevin macleod monkeys"), s.findBest("  Kevin   MacLeod Monkeys ")]);
  await s.findBest("Kevin MacLeod Monkeys");
  assert.equal(calls, 1);
  assert.equal(probed.length, 1);
});

test("ваши файлы участвуют и имеют приоритет", async () => {
  const { s } = make({
    providers: [prov("audius", async () => [t("au:1", "audius", "Scally Milano", "Скам", 154)])],
    catalog: async () => [skamRef],
    library: () => [t("lib:7", "library", "Scally Milano", "Скам", 154)],
  });
  const r = await s.findBest("Scally Milano Скам");
  assert.equal(r.best?.id, "lib:7");
  assert.deepEqual(r.best?.alternates?.map((x) => x.id), ["au:1"]);
});

test("исполнитель не назван: эталон каталога не навязывается, подбор идёт по словам запроса", async () => {
  const ref = t("dz:5", "deezer", "Krikor Lofi", "Lofi Chill", 174);
  const { s } = make({
    providers: [prov("audius", async () => [t("au:lofi", "audius", "Chillhop Guy", "Lofi Chill Beat", 140)])],
    catalog: async () => [ref],
  });
  const r = await s.findBest("lofi chill");
  assert.equal(r.mode, "artist");
  assert.equal(r.best?.id, "au:lofi");
  assert.equal(r.catalog, null);
});

test("исполнитель назван: чужой трек с тем же названием не подставляется", async () => {
  const { s } = make({
    providers: [prov("audius", async () => [t("au:other", "audius", "Other Artist", "Скам", 154)])],
    catalog: async () => [skamRef],
  });
  const r = await s.findBest("Scally Milano Скам");
  assert.equal(r.best, null);
  assert.equal(r.mode, "track");
});

test("необязательный источник (Openverse) не делает выдачу «неполной», обязательный — делает", async () => {
  const slowOptional = { ...prov("openverse", () => new Promise<Track[]>(() => {}), 50), optional: true };
  const { s } = make({ providers: [slowOptional, prov("audius", async () => [t("au:1", "audius", "Kevin MacLeod", "Monkeys Spinning Monkeys", 125)])] });
  const r = await s.findBest("Kevin MacLeod Monkeys");
  assert.equal(r.best?.id, "au:1");
  assert.equal(r.partial, false);
});

test("очистка ввода и правила сопоставления", () => {
  assert.equal(sanitizeQuery("  a\u0000b\nc  "), "a b c");
  assert.equal(sanitizeQuery("x".repeat(500)).length, 100);
  assert.equal(sanitizeQuery(undefined), "");
  assert.equal(variantMarks("Song (Sped Up)"), "sped up");
  assert.equal(namesTrack("scally milano скам", skamRef), true);
  assert.equal(namesTrack("scally milano", skamRef), false, "только исполнитель — не конкретная песня");
  assert.equal(namesTrack("скам remix другой", skamRef), false);
  assert.ok(queryScore("kevin macleod", t("au:1", "audius", "Kevin MacLeod", "Song", 120)) > 0);
  assert.equal(queryScore("kevin macleod", t("au:1", "audius", "Kevin MacLeod", "Song (Remix)", 120)), 0);
  assert.ok(queryScore("kevin macleod remix", t("au:1", "audius", "Kevin MacLeod", "Song (Remix)", 120)) > 0);
});

const app = await buildApp();
const auth = { authorization: `Bearer ${issueSession(42).token}` };
after(() => app.close());

test("API /api/search: один лучший результат в общем формате; пустой и вредный ввод безопасны", async () => {
  configureSearch({
    providers: [prov("audius", async () => [t("au:1", "audius", "Kevin MacLeod", "Monkeys Spinning Monkeys", 125)])],
    catalog: async () => [],
    library: () => [],
    probe: async () => true,
  });
  const r = await app.inject({ url: `/api/search?q=${encodeURIComponent("Kevin MacLeod Monkeys")}&type=tracks`, headers: auth });
  assert.equal(r.statusCode, 200);
  const body = r.json();
  assert.equal(body.best.id, "au:1");
  assert.ok(Array.isArray(body.more));
  assert.equal(body.partial, false);
  const empty = await app.inject({ url: "/api/search?q=%00%01", headers: auth });
  assert.equal(empty.json().best, null);
  const src = await app.inject({ url: "/api/sources", headers: auth });
  assert.deepEqual(
    src.json().items.map((x: { source: string }) => x.source),
    ["audius", "jamendo", "archive", "openverse"],
  );
  assert.doesNotMatch(src.body, /client_id|key/i);
});

test("логи: токен сессии из адреса маскируется", () => {
  assert.equal(redactUrl("/api/stream/au%3A1?t=eyJhbGciOi.secret&x=1"), "/api/stream/au%3A1?t=***&x=1");
  assert.equal(redactUrl("/api/img?u=https%3A%2F%2Fa&t=abc"), "/api/img?u=https%3A%2F%2Fa&t=***");
  assert.equal(redactUrl("/api/search?q=test"), "/api/search?q=test");
});
