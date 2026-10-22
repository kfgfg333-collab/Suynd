import fs from "node:fs";
import path from "node:path";
import { env } from "../env.js";
import { resolvesToPrivate } from "../http.js";
import { log, queryHash } from "../log.js";
import type { Track } from "../types.js";
import { MIN_FULL_SEC } from "./fullOnly.js";
import { coverage, splitArtists, variantMarks } from "./match.js";
import { deezerCatalog, pickReference, sanitizeQuery } from "./search.js";

/*
 * Веб-поиск: где в интернете можно послушать конкретную песню — как поисковая система.
 *
 * - Ищем через официальные поисковые API (Tavily, Яндекс Search API). Сайты сами не сканируем.
 * - Запросы: «исполнитель название» и «… слушать онлайн»; если точных совпадений нет —
 *   ещё «… полная версия» и «… официальное аудио». Так тратится меньше квоты.
 * - Найденную страницу открываем один раз, как превью ссылки: с учётом robots.txt, без внутренних адресов,
 *   с тайм-аутом и ограничением размера. Разбираем только общую разметку (OpenGraph, JSON-LD) — без парсеров под сайты.
 *   Аудио не скачиваем и потоки не извлекаем: страница открывается у пользователя в браузере.
 * - Сверяем название, исполнителя, версию и длительность с эталоном каталога; превью и чужие версии отсекаем.
 * - Найденный адрес не считается доказательством полного прослушивания и прав: это явно пишется в результате.
 * YouTube в выдачу не попадает.
 */

export interface SearchHit {
  url: string;
  title: string;
  snippet: string;
  backend: string;
}

export interface WebBackend {
  name: string;
  enabled(): boolean;
  search(query: string): Promise<SearchHit[]>;
}

export interface PageInfo {
  /** ok — страница открылась; blocked — сайт не пускает сервер (403, капча); robots — запрещено robots.txt */
  status: "ok" | "blocked" | "robots" | "gone" | "error";
  httpStatus?: number;
  finalUrl?: string;
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
  /** Длительность из разметки страницы, секунды */
  duration?: number | null;
  /** Разметка песни: og:type music.song или schema.org MusicRecording */
  songPage: boolean;
  /** На странице есть аудиоплеер (тег audio или og:audio) */
  audioTag: boolean;
}

export interface WebResult {
  url: string;
  domain: string;
  site: string;
  /** Официальный сервис с лицензией (может потребоваться вход или подписка) */
  official: boolean;
  title: string;
  artist: string;
  cover: string | null;
  duration: number | null;
  durationSource: "page" | "catalog" | null;
  /** ok — страница открылась и совпала; остальные — проверить не удалось, совпадение только по выдаче поиска */
  verified: PageInfo["status"];
  songPage: boolean;
  audioTag: boolean;
  note: string;
}

export interface WebSearchResult {
  query: string;
  configured: boolean;
  backends: string[];
  target: { title: string; artist: string; duration: number | null; cover: string | null } | null;
  best: WebResult | null;
  others: WebResult[];
  queries: number;
  partial: boolean;
  notice: string | null;
  ms: number;
}

const BACKEND_TIMEOUT_MS = 2500;
const PAGE_TIMEOUT_MS = 2000;
const ROBOTS_TIMEOUT_MS = 1500;
const MAX_PAGE_BYTES = 600 * 1024;
const MAX_PAGE_CHECKS = 6;
const OK_TTL_MS = 24 * 60 * 60_000;
const EMPTY_TTL_MS = 30 * 60_000;
const BACKEND_COOLDOWN_MS = 60_000;
const AUTH_COOLDOWN_MS = 10 * 60_000;
const UA = "Mozilla/5.0 (compatible; SuyndBot/1.0; personal music link preview)";

/* ───────── Поисковые API ───────── */

class BackendError extends Error {
  constructor(
    message: string,
    public kind: "auth" | "quota" | "rate" | "other",
  ) {
    super(message);
  }
}

function httpError(name: string, status: number): BackendError {
  if (status === 401 || status === 403) return new BackendError(`${name}: неверный ключ API (HTTP ${status})`, "auth");
  if (status === 432 || status === 433 || status === 402) return new BackendError(`${name}: исчерпан лимит тарифа (HTTP ${status})`, "quota");
  if (status === 429) return new BackendError(`${name}: слишком много запросов (HTTP 429)`, "rate");
  return new BackendError(`${name}: HTTP ${status}`, "other");
}

/** Tavily: POST /search, Bearer-ключ; basic-поиск стоит 1 кредит (бесплатно 1000 в месяц) */
export const tavily: WebBackend = {
  name: "tavily",
  enabled: () => Boolean(env.webSearch.tavilyApiKey),
  async search(query) {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { authorization: `Bearer ${env.webSearch.tavilyApiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ query, search_depth: "basic", max_results: 10, include_answer: false }),
      signal: AbortSignal.timeout(BACKEND_TIMEOUT_MS),
    });
    if (!res.ok) throw httpError("Tavily", res.status);
    const data = (await res.json()) as { results?: { url?: string; title?: string; content?: string }[] };
    return (data.results ?? [])
      .filter((r) => r.url)
      .map((r) => ({ url: r.url!, title: r.title ?? "", snippet: r.content ?? "", backend: "tavily" }));
  },
};

const decodeEntities = (s: string) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");

const stripTags = (s: string) => decodeEntities(s.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();

/** XML-ответ Яндекса: <doc> с <url>, <title>, <headline>, <passages><passage> */
export function parseYandexXml(xml: string): SearchHit[] {
  const err = xml.match(/<error[^>]*code="(\d+)"[^>]*>([\s\S]*?)<\/error>/);
  if (err) {
    if (err[1] === "15") return []; // «ничего не найдено»
    throw new BackendError(`Yandex: ${stripTags(err[2]).slice(0, 100)} (код ${err[1]})`, "other");
  }
  const hits: SearchHit[] = [];
  for (const m of xml.matchAll(/<doc\b[^>]*>([\s\S]*?)<\/doc>/g)) {
    const doc = m[1];
    const url = doc.match(/<url>([\s\S]*?)<\/url>/)?.[1];
    if (!url) continue;
    const title = stripTags(doc.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "");
    const passages = [...doc.matchAll(/<(?:passage|headline)>([\s\S]*?)<\/(?:passage|headline)>/g)].map((p) => stripTags(p[1]));
    hits.push({ url: decodeEntities(url.trim()), title, snippet: passages.join(" ").slice(0, 500), backend: "yandex" });
  }
  return hits;
}

/** Яндекс Search API v2: POST /v2/web/search, «Api-Key», ответ — XML в rawData (base64) */
export const yandex: WebBackend = {
  name: "yandex",
  enabled: () => Boolean(env.webSearch.yandexApiKey && env.webSearch.yandexFolderId),
  async search(query) {
    const res = await fetch("https://searchapi.api.cloud.yandex.net/v2/web/search", {
      method: "POST",
      headers: { authorization: `Api-Key ${env.webSearch.yandexApiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        query: { searchType: "SEARCH_TYPE_RU", queryText: query.slice(0, 400), familyMode: "FAMILY_MODE_MODERATE" },
        folderId: env.webSearch.yandexFolderId,
        responseFormat: "FORMAT_XML",
        groupSpec: { groupMode: "GROUP_MODE_FLAT", groupsOnPage: "10", docsInGroup: "1" },
        maxPassages: "2",
        l10n: "LOCALIZATION_RU",
      }),
      signal: AbortSignal.timeout(BACKEND_TIMEOUT_MS),
    });
    if (!res.ok) throw httpError("Yandex", res.status);
    const data = (await res.json()) as { rawData?: string };
    return parseYandexXml(Buffer.from(data.rawData ?? "", "base64").toString("utf8"));
  },
};

/* ───────── Бюджет: потолок запросов к платным/лимитированным API в месяц ───────── */

function usageFile() {
  return path.join(env.dataDir, "web-search-usage.json");
}

function takeQuota(): boolean {
  const limit = env.webSearch.monthlyLimit;
  const month = new Date().toISOString().slice(0, 7);
  let usage = { month, count: 0 };
  try {
    const saved = JSON.parse(fs.readFileSync(usageFile(), "utf8"));
    if (saved.month === month) usage = saved;
  } catch {
    /* первый запрос в месяце */
  }
  if (limit > 0 && usage.count >= limit) return false;
  usage.count++;
  try {
    fs.writeFileSync(usageFile(), JSON.stringify(usage));
  } catch {
    /* учёт — не критично */
  }
  return true;
}

/* ───────── Проверка страницы ───────── */

const robotsCache = new Map<string, { until: number; rules: { allow: boolean; path: string }[] | "all" | "none" }>();

/** Правила robots.txt для «*» и SuyndBot; самое длинное совпадение побеждает, Allow — при равной длине */
export function parseRobots(text: string): { allow: boolean; path: string }[] {
  const rules: { allow: boolean; path: string }[] = [];
  let agents: string[] = [];
  let inRules = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const [key, value] = [m[1].toLowerCase(), m[2].trim()];
    if (key === "user-agent") {
      if (inRules) agents = [];
      inRules = false;
      agents.push(value.toLowerCase());
    } else if (key === "allow" || key === "disallow") {
      inRules = true;
      if (agents.some((a) => a === "*" || a.includes("suyndbot")) && value) rules.push({ allow: key === "allow", path: value });
    }
  }
  return rules;
}

export function robotsAllows(rules: { allow: boolean; path: string }[], pathname: string): boolean {
  let best: { allow: boolean; len: number } | null = null;
  for (const r of rules) {
    const re = new RegExp("^" + r.path.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$"));
    if (re.test(pathname) && (!best || r.path.length > best.len || (r.path.length === best.len && r.allow))) best = { allow: r.allow, len: r.path.length };
  }
  return best ? best.allow : true;
}

async function robotsAllowed(url: URL): Promise<boolean> {
  const hit = robotsCache.get(url.origin);
  let rules = hit && hit.until > Date.now() ? hit.rules : null;
  if (!rules) {
    try {
      const res = await fetch(`${url.origin}/robots.txt`, { headers: { "user-agent": UA }, redirect: "follow", signal: AbortSignal.timeout(ROBOTS_TIMEOUT_MS) });
      // 4xx — правил нет, можно; 5xx — сайт недоступен, не ходим
      rules = res.ok ? parseRobots((await res.text()).slice(0, 200_000)) : res.status >= 500 ? "none" : "all";
    } catch {
      rules = "none";
    }
    robotsCache.set(url.origin, { until: Date.now() + 6 * 60 * 60_000, rules });
  }
  if (rules === "all") return true;
  if (rules === "none") return false;
  return robotsAllows(rules, url.pathname + url.search);
}

async function readLimited(res: Response, max: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
    if (size >= max) {
      await reader.cancel();
      break;
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** ISO 8601 «PT3M5S» → 185 */
function isoDuration(v: string | undefined): number | null {
  const m = v?.match(/^P(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)$/i);
  if (!m) return null;
  const sec = Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
  return sec > 0 ? Math.round(sec) : null;
}

/** Общая разметка страницы: OpenGraph, music:*, schema.org JSON-LD. Никаких правил под конкретные сайты */
export function parsePage(html: string): Omit<PageInfo, "status" | "httpStatus" | "finalUrl"> {
  const meta = new Map<string, string>();
  for (const tag of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = new Map<string, string>();
    for (const a of tag[0].matchAll(/([a-z:_-]+)\s*=\s*("([^"]*)"|'([^']*)')/gi)) attrs.set(a[1].toLowerCase(), a[3] ?? a[4] ?? "");
    const key = (attrs.get("property") ?? attrs.get("name") ?? attrs.get("itemprop"))?.toLowerCase();
    const content = attrs.get("content");
    if (key && content !== undefined && !meta.has(key)) meta.set(key, decodeEntities(content));
  }
  let ldName: string | undefined;
  let ldDuration: number | null = null;
  let ldSong = false;
  for (const s of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const stack: unknown[] = [JSON.parse(s[1])];
      while (stack.length) {
        const node = stack.pop();
        if (Array.isArray(node)) stack.push(...node);
        else if (node && typeof node === "object") {
          const o = node as Record<string, unknown>;
          const type = String(o["@type"] ?? "");
          if (/MusicRecording|AudioObject/i.test(type)) {
            ldSong = true;
            ldName ??= typeof o.name === "string" ? o.name : undefined;
            ldDuration ??= isoDuration(typeof o.duration === "string" ? o.duration : undefined);
          }
          if (Array.isArray(o["@graph"])) stack.push(...(o["@graph"] as unknown[]));
        }
      }
    } catch {
      /* битый JSON-LD — пропускаем */
    }
  }
  const musicDuration = Number(meta.get("music:duration"));
  const title = meta.get("og:title") ?? ldName ?? stripTags(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
  return {
    title: title || undefined,
    description: meta.get("og:description") ?? meta.get("description"),
    image: meta.get("og:image"),
    siteName: meta.get("og:site_name"),
    duration: Number.isFinite(musicDuration) && musicDuration > 0 ? Math.round(musicDuration) : (ldDuration ?? isoDuration(meta.get("duration"))),
    songPage: meta.get("og:type") === "music.song" || ldSong,
    audioTag: /<audio\b/i.test(html) || meta.has("og:audio"),
  };
}

let allowPrivateHosts = false;

/** Открыть страницу как превью ссылки: robots.txt, без внутренних адресов, тайм-аут и ограничение размера */
export async function checkPage(rawUrl: string): Promise<PageInfo> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { status: "error", songPage: false, audioTag: false };
  }
  const deadline = AbortSignal.timeout(PAGE_TIMEOUT_MS);
  try {
    for (let hop = 0; hop < 4; hop++) {
      if (!["http:", "https:"].includes(url.protocol)) return { status: "error", songPage: false, audioTag: false };
      if (!allowPrivateHosts && (await resolvesToPrivate(url.hostname))) return { status: "error", songPage: false, audioTag: false };
      if (!(await robotsAllowed(url))) return { status: "robots", finalUrl: url.toString(), songPage: false, audioTag: false };
      const res = await fetch(url, { headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml" }, redirect: "manual", signal: deadline });
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        await res.body?.cancel();
        url = new URL(location, url);
        continue;
      }
      const base = { httpStatus: res.status, finalUrl: url.toString(), songPage: false, audioTag: false };
      if ([401, 403, 429, 451, 503].includes(res.status)) return (await res.body?.cancel(), { ...base, status: "blocked" });
      if ([404, 410].includes(res.status)) return (await res.body?.cancel(), { ...base, status: "gone" });
      if (!res.ok || !(res.headers.get("content-type") ?? "").includes("html")) return (await res.body?.cancel(), { ...base, status: "error" });
      const html = await readLimited(res, MAX_PAGE_BYTES);
      if (/captcha|cf-challenge|just a moment\.\.\./i.test(html.slice(0, 20_000)) && !/og:title/i.test(html)) return { ...base, status: "blocked" };
      return { ...base, status: "ok", ...parsePage(html) };
    }
    return { status: "error", songPage: false, audioTag: false };
  } catch {
    return { status: "error", songPage: false, audioTag: false };
  }
}

/* ───────── Домены ───────── */

// Официальные сервисы с лицензией на музыку. Полное прослушивание там может требовать вход или подписку
const OFFICIAL: [RegExp, string][] = [
  [/(^|\.)music\.yandex\.(ru|com|by|kz)$/, "Яндекс Музыка"],
  [/^open\.spotify\.com$/, "Spotify"],
  [/(^|\.)deezer\.com$/, "Deezer"],
  [/^music\.apple\.com$/, "Apple Music"],
  [/(^|\.)zvuk\.com$/, "Звук"],
  [/(^|\.)soundcloud\.com$/, "SoundCloud"],
  [/(^|\.)bandcamp\.com$/, "Bandcamp"],
  [/^music\.mts\.ru$/, "МТС Музыка"],
  [/(^|\.)tidal\.com$/, "TIDAL"],
  [/^music\.amazon\./, "Amazon Music"],
  [/(^|\.)audius\.co$/, "Audius"],
  [/(^|\.)jamendo\.com$/, "Jamendo"],
  [/(^|\.)archive\.org$/, "Internet Archive"],
];
// YouTube исключён из Suynd полностью; справочные сайты не дают послушать трек
const EXCLUDED = /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com|wikipedia\.org|wikiwand\.com|genius\.com|musixmatch\.com|discogs\.com|last\.fm|lastfm\.ru|albumoftheyear\.org|rateyourmusic\.com|afisha\.yandex\.ru|kinoafisha\.info)$/;
// Это не прослушивание трека, а текст, обзор или реакция
const NOT_LISTENING = /(текст песни|текст и перевод|lyrics|аккорды|chords|реакция|reaction|обзор|review|интервью|interview|разбор|tutorial|туториал|клип|видео|video|official video)/i;
// Видеоразделы сайтов — это клип, а не прослушивание трека
const VIDEO_PATH = /\/(videos?|clips?|klipy?)(\/|$)/i;

const domainOf = (u: string) => {
  try {
    return new URL(u).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
};

function officialSite(domain: string): string | null {
  return OFFICIAL.find(([re]) => re.test(domain))?.[1] ?? null;
}

function isExcludedDomain(domain: string): boolean {
  return !domain || EXCLUDED.test(domain) || env.webSearch.blockedDomains.some((d) => domain === d || domain.endsWith(`.${d}`));
}

/* ───────── Сопоставление и ранжирование ───────── */

interface Target {
  title: string;
  artist: string;
  duration: number | null;
  cover: string | null;
}

/** «Исполнитель — Название» из запроса, если в каталоге эталона нет */
export function targetFromQuery(query: string): Target {
  const m = query.match(/^(.{2,80}?)\s+[—–-]\s+(.{1,120})$/);
  return m ? { artist: m[1].trim(), title: m[2].trim(), duration: null, cover: null } : { artist: "", title: query, duration: null, cover: null };
}

/** Оценка найденной страницы; 0 — не та песня, не та версия, превью или не прослушивание */
export function scoreHit(target: Target, hit: SearchHit, page: PageInfo | null): number {
  const domain = domainOf(page?.finalUrl ?? hit.url);
  if (isExcludedDomain(domain)) return 0;
  const titleText = [page?.title, hit.title].filter(Boolean).join(" ");
  const allText = [titleText, page?.description, hit.snippet].filter(Boolean).join(" ");
  if (NOT_LISTENING.test(page?.title ?? hit.title)) return 0;
  try {
    if (VIDEO_PATH.test(new URL(page?.finalUrl ?? hit.url).pathname)) return 0;
  } catch {
    return 0;
  }
  // Другая версия записи (ремикс, кавер, live, sped up, утечка…) — не та песня
  if (variantMarks(page?.title ?? hit.title) !== variantMarks(target.title)) return 0;
  const titleCov = coverage(target.title, titleText);
  if (titleCov < 0.75) return 0;
  let artistCov = 1;
  if (target.artist) {
    artistCov = Math.max(...[target.artist, ...splitArtists(target.artist)].map((a) => coverage(a, allText)));
    if (artistCov < 0.5) return 0;
  }
  let score = titleCov * 0.5 + artistCov * 0.3;
  if (page?.duration && target.duration && target.duration >= MIN_FULL_SEC) {
    if (page.duration <= 35) return 0; // превью, а не песня
    if (Math.abs(page.duration - target.duration) > Math.max(15, target.duration * 0.12)) return 0; // другая запись
    score += 0.15;
  }
  if (officialSite(domain)) score += 0.25;
  if (page?.status === "ok") score += 0.4;
  if (page?.songPage || page?.audioTag) score += 0.1;
  return score;
}

const targetOf = (t: Track): Target => ({ title: t.title, artist: t.artist, duration: t.duration || null, cover: t.cover });

/** Заголовок страницы без названия сайта и слов «слушать онлайн», «скачать mp3» */
export function cleanHitTitle(title: string): string {
  return title
    .split(/\s+[|·]\s+/)[0]
    .replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
    .replace(/song and lyrics by|official music video|official video|lyrics|текст песни/gi, " ")
    .replace(/(?<![\p{L}\p{N}])(слушать|скачать|онлайн|бесплатно|в хорошем качестве|mp3|и|listen|online|free|download)(?![\p{L}\p{N}])/giu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toResult(target: Target, hit: SearchHit, page: PageInfo | null): WebResult {
  const url = page?.finalUrl ?? hit.url;
  const domain = domainOf(url);
  const site = officialSite(domain);
  const verified = page?.status ?? "error";
  const duration = page?.duration ?? target.duration ?? null;
  const notes: string[] = [];
  if (site) notes.push("Официальный сервис: полное прослушивание может требовать вход или подписку");
  else notes.push("Внешний сайт: Suynd не проверял права на эту запись и не проигрывает её сам");
  if (verified === "ok") notes.push(page?.songPage || page?.audioTag ? "страница открывается, на ней есть плеер" : "страница открывается");
  else if (verified === "blocked") notes.push("сайт не пускает автоматическую проверку — откроется в вашем браузере");
  else if (verified === "robots") notes.push("сайт запрещает автоматическую проверку (robots.txt)");
  else notes.push("страницу проверить не удалось");
  return {
    url,
    domain,
    site: site ?? page?.siteName ?? domain,
    official: Boolean(site),
    title: target.title,
    artist: target.artist,
    cover: page?.image ?? target.cover,
    duration,
    durationSource: page?.duration ? "page" : target.duration ? "catalog" : null,
    verified,
    songPage: Boolean(page?.songPage),
    audioTag: Boolean(page?.audioTag),
    note: notes.join("; "),
  };
}

const canonicalUrl = (u: string) => {
  try {
    const url = new URL(u);
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return u;
  }
};

/* ───────── Агрегатор ───────── */

export interface WebDeps {
  backends: WebBackend[];
  catalog(query: string): Promise<Track[]>;
  checkPage(url: string): Promise<PageInfo>;
  takeQuota(): boolean;
}

export function createWebSearch(deps: WebDeps) {
  const cache = new Map<string, { until: number; value: WebSearchResult }>();
  const inflight = new Map<string, Promise<WebSearchResult>>();
  const cooldown = new Map<string, number>();

  async function runQueries(queries: string[], state: { partial: boolean; notice: string | null; count: number }): Promise<SearchHit[]> {
    const active = deps.backends.filter((b) => b.enabled() && (cooldown.get(b.name) ?? 0) <= Date.now());
    const jobs = active.flatMap((b) =>
      queries.map(async (q) => {
        if (!deps.takeQuota()) {
          state.notice = "Достигнут месячный лимит запросов веб-поиска (WEB_SEARCH_MONTHLY_LIMIT)";
          return [];
        }
        state.count++;
        const started = Date.now();
        try {
          const hits = await b.search(q);
          log("info", "web_backend", { backend: b.name, ms: Date.now() - started, n: hits.length });
          return hits;
        } catch (e) {
          const err = e instanceof BackendError ? e : new BackendError(`${b.name}: ${(e as Error).name === "TimeoutError" ? "тайм-аут" : "ошибка сети"}`, "other");
          cooldown.set(b.name, Date.now() + (err.kind === "auth" || err.kind === "quota" ? AUTH_COOLDOWN_MS : BACKEND_COOLDOWN_MS));
          state.partial = true;
          if (err.kind === "auth" || err.kind === "quota") state.notice = err.message;
          log("warn", "web_backend_error", { backend: b.name, ms: Date.now() - started, kind: err.kind, error: err.message });
          return [];
        }
      }),
    );
    const seen = new Set<string>();
    return (await Promise.all(jobs)).flat().filter((h) => {
      const key = canonicalUrl(h.url);
      return !seen.has(key) && Boolean(seen.add(key));
    });
  }

  async function rank(target: Target, hits: SearchHit[], pages: Map<string, PageInfo>): Promise<{ hit: SearchHit; page: PageInfo; score: number }[]> {
    // Проверяем только лучшие по выдаче кандидаты: остальные страницы не трогаем
    const prelim = hits
      .map((hit) => ({ hit, score: scoreHit(target, hit, null) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_PAGE_CHECKS);
    await Promise.all(
      prelim.map(async ({ hit }) => {
        if (!pages.has(hit.url)) pages.set(hit.url, await deps.checkPage(hit.url));
      }),
    );
    return prelim
      .map(({ hit }) => ({ hit, page: pages.get(hit.url)!, score: scoreHit(target, hit, pages.get(hit.url)!) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
  }

  /** Эталон по заголовкам выдачи: «Scally Milano - Скам (Onion 2021) слушать онлайн» → каталог → «Scally Milano — Скам» */
  async function refFromHits(query: string, hits: SearchHit[]): Promise<Track | null> {
    const titles = [...new Set(hits.slice(0, 6).map((h) => cleanHitTitle(h.title)).filter((t) => t.length > 2))].slice(0, 3);
    const lists = await Promise.all(titles.map((t) => deps.catalog(t).catch(() => [] as Track[])));
    for (const [i, list] of lists.entries()) {
      // Название эталона — и в запросе пользователя, и в заголовке; хотя бы одно слово исполнителя — в запросе.
      // Иначе «Скам» из выдачи превратился бы в чужую песню с тем же названием
      const ref = list.find(
        (c) =>
          coverage(c.title, query) >= 0.75 &&
          coverage(c.title, titles[i]) >= 0.75 &&
          [c.artist, ...splitArtists(c.artist)].some((a) => coverage(a, query) > 0),
      );
      if (ref) return ref;
    }
    return null;
  }

  async function search(raw: string): Promise<WebSearchResult> {
    const query = sanitizeQuery(raw);
    const backends = deps.backends.filter((b) => b.enabled()).map((b) => b.name);
    const empty = (notice: string | null): WebSearchResult => ({
      query,
      configured: backends.length > 0,
      backends,
      target: null,
      best: null,
      others: [],
      queries: 0,
      partial: false,
      notice,
      ms: 0,
    });
    if (!query) return empty(null);
    if (!backends.length) return empty("Веб-поиск не настроен: задайте TAVILY_API_KEY или YANDEX_SEARCH_API_KEY и YANDEX_FOLDER_ID");
    const key = query.toLowerCase();
    const hit = cache.get(key);
    if (hit && hit.until > Date.now()) return hit.value;
    const running = inflight.get(key);
    if (running) return running;

    const job = (async () => {
      const started = Date.now();
      const ref = pickReference(query, await deps.catalog(query).catch(() => []));
      let target: Target = ref ? targetOf(ref) : targetFromQuery(query);
      let base = target.artist ? `${target.artist} ${target.title}` : target.title;
      const state = { partial: false, notice: null as string | null, count: 0 };
      const pages = new Map<string, PageInfo>();

      // Этап 1: точное название и «слушать онлайн»
      let hits = await runQueries([base, `${base} слушать онлайн`], state);
      // Запрос с ошибкой или транслитом («скали милано скам»): эталон уточняем по заголовкам выдачи
      const refined = ref ? null : await refFromHits(query, hits);
      if (refined) {
        target = targetOf(refined);
        base = `${target.artist} ${target.title}`;
      }
      let ranked = await rank(target, hits, pages);
      // Этап 2 — только если открывающейся подходящей страницы нет
      if (!ranked.some((r) => r.page.status === "ok")) {
        hits = [...hits, ...(await runQueries([`${base} полная версия`, `${base} официальное аудио`], state))];
        ranked = await rank(target, hits, pages);
      }
      const results = ranked.map((r) => toResult(target, r.hit, r.page));
      const value: WebSearchResult = {
        query,
        configured: true,
        backends,
        target: { title: target.title, artist: target.artist, duration: target.duration, cover: target.cover },
        best: results[0] ?? null,
        others: results.slice(1, 5),
        queries: state.count,
        partial: state.partial,
        notice: state.notice,
        ms: Date.now() - started,
      };
      log("info", "web_search", {
        q: queryHash(query),
        queries: state.count,
        hits: hits.length,
        checked: pages.size,
        best: value.best ? { domain: value.best.domain, verified: value.best.verified, official: value.best.official } : null,
        ms: value.ms,
      });
      if (cache.size > 500) cache.delete(cache.keys().next().value!);
      cache.set(key, { until: Date.now() + (value.best?.verified === "ok" && !value.partial ? OK_TTL_MS : EMPTY_TTL_MS), value });
      return value;
    })().finally(() => inflight.delete(key));
    inflight.set(key, job);
    return job;
  }

  return { search };
}

const defaultDeps: WebDeps = { backends: [yandex, tavily], catalog: deezerCatalog, checkPage, takeQuota };
let instance = createWebSearch(defaultDeps);

export const webSearch = {
  search: (query: string) => instance.search(query),
  configured: () => defaultDeps.backends.filter((b) => b.enabled()).map((b) => b.name),
};

/** Для тестов: подменить поисковые API, каталог или проверку страниц; разрешить локальный тестовый сайт */
export function configureWebSearch(deps: Partial<WebDeps>, opts: { allowPrivateHosts?: boolean } = {}) {
  allowPrivateHosts = Boolean(opts.allowPrivateHosts);
  instance = createWebSearch({ ...defaultDeps, ...deps });
}
