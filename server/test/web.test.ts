/*
 * Веб-поиск страниц с прослушиванием: разбор ответов поисковых API, robots.txt, разметки страниц,
 * сопоставление (не та песня, превью, ремикс, YouTube, тексты песен) и сам агрегатор.
 * Поисковые API подменены; проверка страниц идёт по-настоящему — на локальном тестовом сайте.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

process.env.BOT_TOKEN = "123456:TEST";
process.env.ALLOWED_USER_ID = "42";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "suynd-web-"));
process.env.BOT_DISABLED = "true";
process.env.WEB_SEARCH_BLOCKED_DOMAINS = "blocked.example";

const web = await import("../src/services/web.js");
const { parseYandexXml, parseRobots, robotsAllows, parsePage, scoreHit, checkPage, createWebSearch, configureWebSearch, targetFromQuery, cleanHitTitle } = web;
const { buildApp } = await import("../src/app.js");
const { issueSession } = await import("../src/auth.js");
type Track = import("../src/types.js").Track;
type Backend = import("../src/services/web.js").WebBackend;
type Hit = import("../src/services/web.js").SearchHit;

// Разметка как у реальных страниц трека (снята с deezer.com и open.spotify.com)
const songHtml = (title: string, artist: string, duration: number) => `<!doctype html><html><head>
<title>${artist} - ${title} | Site</title>
<meta property="og:title" content="${title}">
<meta property="og:description" content="${artist} - song - 2021">
<meta property="og:type" content="music.song">
<meta property="og:image" content="https://img.example/cover.jpg">
<meta name="music:duration" content="${duration}">
</head><body><audio controls src="/a.mp3"></audio></body></html>`;

const pages: Record<string, { status: number; body?: string; type?: string; location?: string }> = {
  "/track": { status: 200, body: songHtml("Скам", "Scally Milano", 153) },
  "/redirect": { status: 301, location: "/track" },
  "/blocked": { status: 403 },
  "/private/secret": { status: 200, body: songHtml("Скам", "Scally Milano", 153) },
  "/other-song": { status: 200, body: songHtml("Scam", "Scally Milano, Tatarin", 188) },
  "/preview": { status: 200, body: songHtml("Скам", "Scally Milano", 30) },
  "/jsonld": {
    status: 200,
    body: `<html><head><title>Скам — слушать</title><script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"MusicRecording","name":"Скам","duration":"PT2M34S","byArtist":{"name":"Scally Milano"}}]}</script></head><body></body></html>`,
  },
  "/robots.txt": { status: 200, type: "text/plain", body: "User-agent: *\nDisallow: /private/\nAllow: /private/open\n" },
};
let pageHits = 0;
const site = http.createServer((req, res) => {
  pageHits++;
  const p = pages[req.url ?? ""];
  if (!p) return res.writeHead(404).end();
  if (p.location) return res.writeHead(p.status, { location: p.location }).end();
  res.writeHead(p.status, { "content-type": p.type ?? "text/html; charset=utf-8" }).end(p.body ?? "");
});
await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
configureWebSearch({}, { allowPrivateHosts: true });

const app = await buildApp();
const auth = { authorization: `Bearer ${issueSession(42).token}` };
after(async () => {
  await app.close();
  site.close();
});

const skamRef: Track = { id: "dz:1409013642", source: "deezer", title: "Скам", artist: "Scally Milano", artistId: null, album: "ONION", albumId: null, cover: "https://dz/cover.jpg", duration: 153, full: false, downloadable: false };
const target = { title: "Скам", artist: "Scally Milano", duration: 153, cover: null };
const hit = (url: string, title: string, snippet = ""): Hit => ({ url, title, snippet, backend: "fake" });

test("Яндекс: XML-ответ разбирается (подсветка, сущности), «ничего не найдено» — пустой список, другие ошибки — исключение", () => {
  const xml = `<?xml version="1.0" encoding="utf-8"?><yandexsearch version="1.0"><response><results><grouping><group>
    <doc id="1"><url>https://site.example/track/1?a=1&amp;b=2</url><domain>site.example</domain>
      <title><hlword>Scally</hlword> <hlword>Milano</hlword> — Скам слушать онлайн</title>
      <passages><passage>Слушать <hlword>Скам</hlword> 2:33</passage></passages></doc></group>
    <group><doc id="2"><url>https://other.example/</url><title>Другое</title><headline>описание</headline></doc></group>
  </grouping></results></response></yandexsearch>`;
  const hits = parseYandexXml(xml);
  assert.equal(hits.length, 2);
  assert.equal(hits[0].url, "https://site.example/track/1?a=1&b=2");
  assert.equal(hits[0].title, "Scally Milano — Скам слушать онлайн");
  assert.match(hits[0].snippet, /Слушать Скам 2:33/);
  assert.equal(hits[1].snippet, "описание");
  assert.deepEqual(parseYandexXml(`<yandexsearch><response><error code="15">Искомая комбинация слов нигде не встречается</error></response></yandexsearch>`), []);
  assert.throws(() => parseYandexXml(`<yandexsearch><response><error code="55">Превышен лимит</error></response></yandexsearch>`), /код 55/);
});

test("robots.txt: самое длинное правило побеждает, Allow при равенстве", () => {
  const rules = parseRobots("User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /search\nAllow: /search/public\nDisallow: /*.mp3$\n");
  assert.equal(robotsAllows(rules, "/track/1"), true);
  assert.equal(robotsAllows(rules, "/search?q=x"), false);
  assert.equal(robotsAllows(rules, "/search/public/1"), true);
  assert.equal(robotsAllows(rules, "/a.mp3"), false);
});

test("разметка страницы: OpenGraph music.song, длительность, JSON-LD MusicRecording", () => {
  const og = parsePage(songHtml("Скам", "Scally Milano", 153));
  assert.equal(og.title, "Скам");
  assert.equal(og.duration, 153);
  assert.equal(og.songPage, true);
  assert.equal(og.audioTag, true);
  const ld = parsePage(pages["/jsonld"].body!);
  assert.equal(ld.duration, 154);
  assert.equal(ld.songPage, true);
});

test("проверка страницы: переадресация, 403, robots.txt, 404 — по-настоящему через HTTP", async () => {
  const ok = await checkPage(`${base}/redirect`);
  assert.equal(ok.status, "ok");
  assert.equal(ok.finalUrl, `${base}/track`);
  assert.equal(ok.duration, 153);
  assert.equal((await checkPage(`${base}/blocked`)).status, "blocked");
  const before = pageHits;
  assert.equal((await checkPage(`${base}/private/secret`)).status, "robots");
  assert.equal(pageHits, before, "запрещённая robots.txt страница не запрашивается");
  assert.equal((await checkPage(`${base}/missing`)).status, "gone");
});

test("защита от SSRF: внутренние адреса не открываются", async () => {
  configureWebSearch({}, { allowPrivateHosts: false });
  assert.equal((await checkPage(`${base}/track`)).status, "error");
  assert.equal((await checkPage("http://169.254.169.254/latest/meta-data")).status, "error");
  assert.equal((await checkPage("file:///etc/passwd")).status, "error");
  configureWebSearch({}, { allowPrivateHosts: true });
});

test("сопоставление: другая песня, превью, ремикс, YouTube, тексты песен и заблокированные домены отсекаются", () => {
  const page = (o: Partial<import("../src/services/web.js").PageInfo>) => ({ status: "ok" as const, songPage: true, audioTag: false, ...o });
  assert.ok(scoreHit(target, hit("https://www.deezer.com/track/1", "Scally Milano - Скам | Deezer"), page({ title: "Скам", duration: 153 })) > 0);
  assert.equal(scoreHit(target, hit("https://open.spotify.com/track/2", "Scam - Scally Milano, Tatarin"), page({ title: "Scam", duration: 188 })), 0, "Scam (188 с) — другая песня");
  assert.equal(scoreHit(target, hit("https://x.example/a", "Scally Milano - Скам"), page({ title: "Скам", duration: 30 })), 0, "превью");
  assert.equal(scoreHit(target, hit("https://x.example/b", "Scally Milano - Скам (Remix)"), null), 0);
  assert.equal(scoreHit(target, hit("https://x.example/c", "Scally Milano - Скам (Sped Up)"), null), 0);
  assert.equal(scoreHit(target, hit("https://www.youtube.com/watch?v=x", "Scally Milano - Скам"), null), 0, "YouTube исключён");
  assert.equal(scoreHit(target, hit("https://music.youtube.com/watch?v=x", "Scally Milano - Скам"), null), 0);
  assert.equal(scoreHit(target, hit("https://x.example/d", "Scally Milano - Скам текст песни"), null), 0);
  assert.equal(scoreHit(target, hit("https://ru.wikipedia.org/wiki/Scally_Milano", "Scally Milano Скам"), null), 0);
  assert.equal(scoreHit(target, hit("https://sub.blocked.example/a", "Scally Milano - Скам"), null), 0, "WEB_SEARCH_BLOCKED_DOMAINS");
  assert.equal(scoreHit(target, hit("https://x.example/e", "Other Artist - Скам"), null), 0, "другой исполнитель");
  // Проверенная официальная страница выше непроверенной сторонней
  const official = scoreHit(target, hit("https://www.deezer.com/track/1", "Scally Milano - Скам"), page({ title: "Скам" }));
  const unverified = scoreHit(target, hit("https://mp3.example/1", "Scally Milano - Скам (Onion 2021) слушать онлайн"), { status: "blocked", songPage: false, audioTag: false });
  assert.ok(official > unverified && unverified > 0);
  assert.deepEqual(targetFromQuery("Scally Milano — Скам"), { artist: "Scally Milano", title: "Скам", duration: null, cover: null });
});

function backend(name: string, results: (q: string) => Hit[], calls: string[] = []): Backend {
  return { name, enabled: () => true, search: async (q) => (calls.push(q), results(q)) };
}

test("агрегатор: лучший — открывающаяся совпавшая страница; сторонние непроверенные — ниже; YouTube не попадает", async () => {
  const calls: string[] = [];
  const s = createWebSearch({
    backends: [
      backend(
        "fake",
        () => [
          hit("https://www.youtube.com/watch?v=abc", "Scally Milano — Скам"),
          hit(`${base}/blocked`, "Scally Milano - Скам (Onion 2021) слушать онлайн"),
          hit(`${base}/other-song`, "Scam — Scally Milano, Tatarin"),
          hit(`${base}/track`, "Scally Milano — Скам"),
        ],
        calls,
      ),
    ],
    catalog: async () => [skamRef],
    checkPage,
    takeQuota: () => true,
  });
  const r = await s.search("Scally Milano Скам");
  assert.equal(r.best?.url, `${base}/track`);
  assert.equal(r.best?.verified, "ok");
  assert.equal(r.best?.duration, 153);
  assert.equal(r.best?.durationSource, "page");
  assert.match(r.best!.note, /не проверял права/);
  assert.deepEqual(r.others.map((x) => x.verified), ["blocked"]);
  assert.ok(![r.best, ...r.others].some((x) => /youtube/.test(x!.url)));
  assert.deepEqual(calls, ["Scally Milano Скам", "Scally Milano Скам слушать онлайн"], "открывающаяся страница найдена — второй этап не нужен");
  // Повтор — из кэша
  await s.search("scally milano скам");
  assert.equal(calls.length, 2);
});

test("агрегатор: без открывающихся страниц — второй этап запросов («полная версия», «официальное аудио»)", async () => {
  const calls: string[] = [];
  const s = createWebSearch({
    backends: [backend("fake", (q) => (q.endsWith("официальное аудио") ? [hit(`${base}/jsonld`, "Scally Milano — Скам")] : [hit(`${base}/blocked`, "Scally Milano — Скам")]), calls)],
    catalog: async () => [skamRef],
    checkPage,
    takeQuota: () => true,
  });
  const r = await s.search("Scally Milano — Скам");
  assert.equal(calls.length, 4);
  assert.ok(calls.some((q) => q.endsWith("полная версия")));
  assert.equal(r.best?.url, `${base}/jsonld`);
  assert.equal(r.best?.verified, "ok");
});

test("агрегатор: нет точного совпадения — пусто, похожие песни не подставляются", async () => {
  const s = createWebSearch({
    backends: [backend("fake", () => [hit(`${base}/other-song`, "Scam — Scally Milano, Tatarin"), hit(`${base}/preview`, "Scally Milano — Скам")])],
    catalog: async () => [skamRef],
    checkPage,
    takeQuota: () => true,
  });
  const r = await s.search("Scally Milano Скам");
  assert.equal(r.best, null);
});

test("запрос с ошибкой («скали милано скам»): эталон уточняется по заголовкам выдачи, чужая песня — нет", async () => {
  const catalogCalls: string[] = [];
  const s = createWebSearch({
    backends: [backend("fake", () => [hit(`${base}/track`, "Scally Milano - Скам (Onion 2021) слушать онлайн | Site"), hit(`${base}/other-song`, "Scam — Scally Milano, Tatarin")])],
    catalog: async (q) => (catalogCalls.push(q), /scally milano - скам/i.test(q) ? [skamRef] : []),
    checkPage,
    takeQuota: () => true,
  });
  const r = await s.search("скали милано скам");
  assert.equal(r.target?.artist, "Scally Milano");
  assert.equal(r.target?.duration, 153);
  assert.equal(r.best?.url, `${base}/track`);
  assert.ok(catalogCalls.includes("Scally Milano - Скам"), JSON.stringify(catalogCalls));
  // Эталон из выдачи, которого нет в запросе, не принимается
  const s2 = createWebSearch({
    backends: [backend("fake", () => [hit(`${base}/track`, "Scally Milano - Скам")])],
    catalog: async (q) => (/скам/i.test(q) ? [skamRef] : []),
    checkPage,
    takeQuota: () => true,
  });
  assert.equal((await s2.search("милано другая песня")).target?.title, "милано другая песня");
  // Заголовок «Скам» без исполнителя: в каталоге первым — чужой «Скам»; исполнителя нет в запросе — не принимается
  const krystal: Track = { ...skamRef, id: "dz:9", artist: "LIL KRYSTALLL", duration: 120 };
  const s3 = createWebSearch({
    backends: [backend("fake", () => [hit(`${base}/track`, "Скам")])],
    catalog: async () => [krystal],
    checkPage,
    takeQuota: () => true,
  });
  assert.equal((await s3.search("скали милано скам")).target?.artist, "", "чужой исполнитель не подставлен");
});

test("видео и клипы — не прослушивание; очистка заголовков выдачи", () => {
  assert.equal(scoreHit(target, hit("https://news.example/videos/scally-milano-skam", "Scally Milano — Скам"), null), 0);
  assert.equal(scoreHit(target, hit("https://x.example/a", "Scally Milano — Скам (клип)"), null), 0);
  assert.equal(cleanHitTitle("Scally Milano - Скам (Onion 2021) слушать онлайн и скачать mp3 | Hitmos"), "Scally Milano - Скам");
  assert.equal(cleanHitTitle("Scally Milano - Скам (Official Music Video)"), "Scally Milano - Скам");
  assert.equal(cleanHitTitle("Скам - song and lyrics by Scally Milano | Spotify"), "Скам - Scally Milano");
  assert.equal(cleanHitTitle("Скали Милано и Скам"), "Скали Милано Скам");
});

test("бюджет: месячный лимит останавливает запросы к API и объясняет почему", async () => {
  const calls: string[] = [];
  const s = createWebSearch({ backends: [backend("fake", () => [], calls)], catalog: async () => [], checkPage, takeQuota: () => false });
  const r = await s.search("anything");
  assert.equal(calls.length, 0);
  assert.match(r.notice ?? "", /лимит/);
});

test("ошибка API: выдача помечается неполной, источник ставится на паузу без повторов", async () => {
  let calls = 0;
  const bad: Backend = {
    name: "tavily",
    enabled: () => true,
    search: async () => {
      calls++;
      throw new Error("Tavily: неверный ключ API (HTTP 401)");
    },
  };
  const s = createWebSearch({ backends: [bad], catalog: async () => [], checkPage, takeQuota: () => true });
  const r = await s.search("a song");
  assert.equal(r.partial, true);
  assert.equal(r.best, null);
  const n = calls;
  await s.search("another song");
  assert.equal(calls, n, "после ошибки ключа API не опрашивается");
});

test("не настроено: понятная подсказка, без запросов", async () => {
  const s = createWebSearch({ backends: [{ name: "tavily", enabled: () => false, search: async () => [] }], catalog: async () => [], checkPage, takeQuota: () => true });
  const r = await s.search("song");
  assert.equal(r.configured, false);
  assert.match(r.notice ?? "", /TAVILY_API_KEY/);
});

test("API /api/search/web и /api/sources", async () => {
  configureWebSearch({ backends: [backend("fake", () => [hit(`${base}/track`, "Scally Milano — Скам")])], catalog: async () => [skamRef] }, { allowPrivateHosts: true });
  const r = await app.inject({ url: `/api/search/web?q=${encodeURIComponent("Scally Milano Скам")}`, headers: auth });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().best.verified, "ok");
  assert.equal(r.json().target.title, "Скам");
  const src = await app.inject({ url: "/api/sources", headers: auth });
  assert.deepEqual(src.json().webSearch, [], "без ключей поисковые API не настроены");
});
