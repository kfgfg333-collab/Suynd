import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { env } from "../env.js";
import { UpstreamError } from "../http.js";
import type { Track } from "../types.js";

/*
 * Необязательная интеграция YouTube через бинарник yt-dlp (npm-обёртка не нужна).
 *
 * Правила:
 * - процесс запускается без оболочки, аргументы передаются массивом — пользовательский ввод не склеивается в команду;
 * - время работы, число одновременных процессов, очередь и объём вывода ограничены;
 * - только публичные ролики: приватные, платные, members-only, с DRM и прямые эфиры не играем и ничего не обходим;
 * - прямые ссылки googlevideo истекают, поэтому берём свежую перед воспроизведением и держим её в кэше только до срока;
 * - скачивание разрешаем лишь роликам, у которых YouTube указывает лицензию Creative Commons.
 * Если yt-dlp не установлен, поиск YouTube просто пуст, а поток отвечает понятной ошибкой — сервер не падает.
 */

const cfg = env.ytDlp;
const MAX_OUTPUT = 4 * 1024 * 1024;
const MAX_QUEUE = 8;
const SEARCH_TTL_MS = 30 * 60 * 1000;
// Сколько помним неудачу по ролику, чтобы обновление страницы, перемотка и предзагрузка не запускали yt-dlp снова
const FAILURE_TTL_MS: Partial<Record<YtDlpErrorCode, number>> = {
  network: 15_000,
  timeout: 15_000,
  bot_check: 2 * 60_000,
  forbidden: 2 * 60_000,
  rate_limited: 2 * 60_000,
  failed: 60_000,
};
const PERMANENT_FAILURE_TTL_MS = 10 * 60_000;
const NOT_CACHED: ReadonlySet<YtDlpErrorCode> = new Set<YtDlpErrorCode>(["busy", "not_installed", "disabled"]);
// Временная сетевая ошибка — несколько повторов с паузой; постоянные ошибки не повторяем
let retryDelaysMs = [1_000, 3_000];
const NOT_INSTALLED_RETRY_MS = 60 * 1000;
const MIN_SEC = 45;
const ID_RE = /^[A-Za-z0-9_-]{11}$/;
// Сначала AAC (m4a): его играют все браузеры, включая Telegram на iOS. Манифесты HLS/DASH не берём.
const AUDIO_FORMAT = "ba[ext=m4a][protocol=https]/ba[protocol=https]/b[protocol=https]";
// Ролики, которые сами себя называют фрагментом, — не полные песни
const NOT_FULL_TITLE = /(^|[\s([#])(preview|snippet|teaser|trailer|shorts?)\b/i;
// «10 hours», «1 час» — зацикленные версии, а не запись трека
const LOOP_TITLE = /\b\d+\s*(hours?|hrs?|час(а|ов)?)\b/i;
const MAX_SEC = 3 * 60 * 60;

export type YtDlpErrorCode =
  | "not_installed"
  | "disabled"
  | "timeout"
  | "busy"
  | "bad_id"
  | "unavailable"
  | "private"
  | "geo"
  | "copyright"
  | "age"
  | "auth"
  | "bot_check"
  | "drm"
  | "live"
  | "rate_limited"
  | "forbidden"
  | "network"
  | "no_audio"
  | "too_short"
  | "failed";

const ERRORS: Record<YtDlpErrorCode, [number, string]> = {
  not_installed: [503, "YouTube недоступен: на сервере не установлен yt-dlp (или неверный YT_DLP_PATH)"],
  disabled: [503, "YouTube отключён в настройках сервера (YT_DLP_ENABLED=false)"],
  timeout: [504, "YouTube не ответил вовремя. Попробуйте ещё раз"],
  busy: [503, "Сервер занят другими запросами к YouTube. Попробуйте через несколько секунд"],
  bad_id: [400, "Некорректный идентификатор видео"],
  unavailable: [410, "Видео удалено или больше недоступно на YouTube"],
  private: [403, "Это приватное видео — его нельзя воспроизвести"],
  geo: [451, "Видео недоступно в регионе сервера"],
  copyright: [451, "Видео заблокировано по жалобе правообладателя"],
  age: [403, "Видео с возрастным ограничением требует входа в аккаунт — Suynd такие не воспроизводит"],
  auth: [403, "Видео доступно только после входа, по подписке или за плату — Suynd такие не воспроизводит"],
  bot_check: [503, "YouTube требует подтвердить, что запрос не от бота: сервер временно не может получить аудио"],
  drm: [451, "Видео защищено DRM — воспроизведение невозможно"],
  live: [422, "Это прямой эфир или премьера, а не запись трека"],
  rate_limited: [503, "YouTube ограничил число запросов с сервера. Попробуйте позже"],
  forbidden: [502, "YouTube отказал серверу в доступе к аудиопотоку (HTTP 403). Обычно так YouTube ограничивает IP-адрес сервера"],
  network: [503, "Временная сетевая ошибка при обращении к YouTube. Попробуйте ещё раз"],
  no_audio: [502, "У видео нет доступной аудиодорожки"],
  too_short: [422, "Полная версия недоступна: ролик слишком короткий для полного трека"],
  failed: [502, "yt-dlp не смог получить данные видео"],
};

export class YtDlpError extends UpstreamError {
  constructor(public reason: YtDlpErrorCode) {
    super(ERRORS[reason][1], ERRORS[reason][0], `ytdlp_${reason}`);
  }
}

/** Разбор stderr yt-dlp в понятную причину. Порядок важен: проверка на бота тоже упоминает cookies */
export function classifyYtDlpError(stderr: string): YtDlpErrorCode {
  const s = stderr.toLowerCase();
  if (/not a bot|confirm you.?re not a bot/.test(s)) return "bot_check";
  if (/\bdrm\b/.test(s)) return "drm";
  if (/private video/.test(s)) return "private";
  if (/confirm your age|age[- ]restricted|inappropriate for some users/.test(s)) return "age";
  if (/not (made this video )?available in your country|geo.?restrict|blocked it in your country/.test(s)) return "geo";
  if (/copyright/.test(s)) return "copyright";
  if (/members[- ]only|channel.s members|join this channel|requires payment|purchase|premium/.test(s)) return "auth";
  if (/live event|is live|premieres? in|will begin in|is_upcoming/.test(s)) return "live";
  if (/http error 429|too many requests/.test(s)) return "rate_limited";
  if (/http error 403|403: forbidden/.test(s)) return "forbidden";
  if (/removed|video unavailable|does not exist|has been terminated|no longer available|is not available/.test(s)) return "unavailable";
  if (/requested format is not available|no video formats/.test(s)) return "no_audio";
  if (/sign in|log in|login|cookies/.test(s)) return "auth";
  if (
    /timed out|connection (reset|refused|aborted)|temporary failure in name resolution|name or service not known|network is unreachable|http error 5\d\d|remote end closed|eof occurred|tunnel connection failed|unable to download (webpage|api|json)/.test(s)
  )
    return "network";
  return "failed";
}

/* ───────── Запуск процесса: ограничение параллельности и очереди ───────── */

let active = 0;
const waiting: (() => void)[] = [];
let notInstalledUntil = 0;

function acquire(priority: boolean): Promise<void> {
  if (active < cfg.maxConcurrency) {
    active++;
    return Promise.resolve();
  }
  if (waiting.length >= MAX_QUEUE) return Promise.reject(new YtDlpError("busy"));
  return new Promise((resolve) => {
    const start = () => {
      active++;
      resolve();
    };
    // Воспроизведение важнее поиска: его запрос встаёт в начало очереди
    if (priority) waiting.unshift(start);
    else waiting.push(start);
  });
}

function release() {
  active--;
  waiting.shift()?.();
}

let cacheDir: string | null = null;
function baseArgs(): string[] {
  const args = ["--ignore-config", "--no-warnings", "--no-playlist", "--no-progress", "--socket-timeout", "10"];
  try {
    cacheDir ??= (fs.mkdirSync(path.join(env.dataDir, "yt-dlp-cache"), { recursive: true }), path.join(env.dataDir, "yt-dlp-cache"));
    args.push("--cache-dir", cacheDir);
  } catch {
    args.push("--no-cache-dir");
  }
  // Новые yt-dlp решают JS-задачи YouTube внешним рантаймом. Node уже есть — это тот, что запускает сервер
  if (supportsJsRuntimes) args.push("--js-runtimes", `node:${process.execPath}`);
  if (cookiesState().usable) args.push("--cookies", cfg.cookiesFile);
  return args;
}

/**
 * Файл cookies необязателен. Используем его, только если он существует и читается;
 * путь и содержимое никуда не выводим. Права шире 600 — повод для предупреждения.
 */
export function cookiesState(): { configured: boolean; usable: boolean; warning?: string } {
  if (!cfg.cookiesFile) return { configured: false, usable: false };
  try {
    const st = fs.statSync(cfg.cookiesFile);
    if (!st.isFile()) return { configured: true, usable: false, warning: "YT_DLP_COOKIES_FILE указывает не на файл" };
    fs.accessSync(cfg.cookiesFile, fs.constants.R_OK | fs.constants.W_OK);
    const open = (st.mode & 0o077) !== 0;
    return { configured: true, usable: true, ...(open ? { warning: "Файл cookies доступен другим пользователям системы: выполните chmod 600" } : {}) };
  } catch {
    return { configured: true, usable: false, warning: "Файл YT_DLP_COOKIES_FILE не найден или недоступен серверу для чтения и записи" };
  }
}

let supportsJsRuntimes = false;

function run(args: string[], opts: { timeoutMs?: number; priority?: boolean; anyExitCode?: boolean } = {}): Promise<string> {
  if (!cfg.enabled) return Promise.reject(new YtDlpError("disabled"));
  if (Date.now() < notInstalledUntil) return Promise.reject(new YtDlpError("not_installed"));
  return acquire(Boolean(opts.priority)).then(
    () =>
      new Promise<string>((resolve, reject) => {
        let stdout = "";
        let stderr = "";
        let settled = false;
        const finish = (error: Error | null, output?: string) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          release();
          if (error) reject(error);
          else resolve(output ?? "");
        };
        let child: ReturnType<typeof spawn>;
        try {
          child = spawn(cfg.path, [...baseArgs(), ...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: false });
        } catch {
          notInstalledUntil = Date.now() + NOT_INSTALLED_RETRY_MS;
          settled = true;
          release();
          reject(new YtDlpError("not_installed"));
          return;
        }
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          finish(new YtDlpError("timeout"));
        }, opts.timeoutMs ?? cfg.timeoutMs);
        child.stdout!.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
          if (stdout.length > MAX_OUTPUT) {
            child.kill("SIGKILL");
            finish(new YtDlpError("failed"));
          }
        });
        child.stderr!.on("data", (chunk: Buffer) => {
          stderr = (stderr + chunk.toString("utf8")).slice(-4000);
        });
        child.on("error", (err: NodeJS.ErrnoException) => {
          if (err.code === "ENOENT" || err.code === "EACCES") {
            notInstalledUntil = Date.now() + NOT_INSTALLED_RETRY_MS;
            finish(new YtDlpError("not_installed"));
          } else finish(new YtDlpError("failed"));
        });
        child.on("close", (code) => {
          if (code === 0) finish(null, stdout.trim());
          else if (opts.anyExitCode && code !== null) finish(null, `${stdout}\n${stderr}`.trim());
          else finish(new YtDlpError(classifyYtDlpError(stderr)));
        });
      }),
  );
}

/* ───────── Состояние установки ───────── */

export interface YtDlpStatus {
  available: boolean;
  version: string | null;
  /** yt-dlp-ejs: без решателя JS-задач YouTube отвечает 403 на аудио */
  jsChallengeSolver?: boolean;
  jsRuntime?: string | null;
  cookies?: { configured: boolean; usable: boolean; warning?: string };
  lastStreamError?: { code: string; at: string } | null;
  code?: string;
  message?: string;
  warnings?: string[];
}
let statusCache: { at: number; value: YtDlpStatus } | null = null;
let lastStreamError: { code: string; at: string } | null = null;

/** Разбор заголовка `yt-dlp -v` (без URL, без сети). Берём только версию, библиотеки и JS-рантайм */
export function parseVerboseHeader(out: string): { jsChallengeSolver: boolean; jsRuntime: string | null } {
  const libs = out.match(/Optional libraries: (.*)/)?.[1] ?? "";
  const runtime = out.match(/JS runtimes: (\S+)/)?.[1] ?? null;
  return { jsChallengeSolver: /\byt_dlp_ejs-/.test(libs), jsRuntime: runtime && runtime !== "none" ? runtime : null };
}

async function status(force = false): Promise<YtDlpStatus> {
  if (!force && statusCache && Date.now() - statusCache.at < 5 * 60 * 1000) return { ...statusCache.value, lastStreamError };
  let value: YtDlpStatus;
  try {
    const version = (await run(["--version"], { timeoutMs: 10_000, priority: true })).split(/\s+/)[0] || null;
    // --js-runtimes появился в 2025.11; на старых версиях флаг сломал бы запуск
    supportsJsRuntimes = Boolean(version && version >= "2025.11");
    const header = parseVerboseHeader(await run(["-v"], { timeoutMs: 10_000, priority: true, anyExitCode: true }).catch(() => ""));
    const warnings: string[] = [];
    if (!header.jsChallengeSolver) warnings.push("Не найден yt-dlp-ejs: YouTube будет отвечать 403 на аудио. Установите yt-dlp[default]");
    if (!header.jsRuntime) warnings.push("yt-dlp не видит JS-рантайм (нужен yt-dlp 2025.11 или новее)");
    const cookies = cookiesState();
    if (cookies.warning) warnings.push(cookies.warning);
    value = { available: true, version, ...header, cookies, ...(warnings.length ? { warnings } : {}) };
  } catch (e) {
    const err = e instanceof YtDlpError ? e : new YtDlpError("failed");
    value = { available: false, version: null, code: err.code, message: err.message };
  }
  statusCache = { at: Date.now(), value };
  return { ...value, lastStreamError };
}

/** Перед первым настоящим вызовом узнаём версию; если бинарника нет — сразу понятная ошибка */
async function ensureReady() {
  const s = await status();
  if (!s.available && (s.code === "ytdlp_not_installed" || s.code === "ytdlp_disabled")) {
    throw new YtDlpError(s.code === "ytdlp_disabled" ? "disabled" : "not_installed");
  }
}

/* ───────── Поиск ───────── */

interface FlatVideo {
  id?: string;
  title?: string;
  uploader?: string;
  channel?: string;
  duration?: number;
  live_status?: string;
  is_live?: boolean;
  availability?: string;
  ie_key?: string;
  extractor_key?: string;
  _type?: string;
}

/** «Artist - Title (Official Video)» → артист и название без мусора */
export function parseVideoTitle(rawTitle: string, uploader: string): { artist: string; title: string } {
  const clean = (s: string) =>
    s
      .replace(/[([](official\s*)?(music\s*)?(video|audio|lyric(s)?(\s*video)?|visuali[sz]er|hd|hq|4k|mv|clip)[)\]]/gi, " ")
      .replace(/[([](no\s+copyright(\s+music)?|copyright\s+free|royalty\s+free)[)\]]/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
  const channel = uploader.replace(/\s*-\s*topic$/i, "").replace(/vevo$/i, "").replace(/\s+official$/i, "").trim();
  const title = clean(rawTitle);
  const m = title.match(/^(.{1,80}?)\s+[-–—]\s+(.+)$/);
  if (m) {
    const [left, right] = [m[1].trim(), m[2].trim()];
    // «Song - Artist» на канале артиста: справа имя канала — меняем местами
    const ch = channel.toLowerCase();
    if (ch && right.toLowerCase() === ch && left.toLowerCase() !== ch) return { artist: right, title: left };
    return { artist: left, title: right };
  }
  // «Kevin MacLeod: Song» на канале «Kevin MacLeod Archive» — слева имя артиста
  const c = title.match(/^(.{2,60}?):\s+(.+)$/);
  if (c && channel.toLowerCase().includes(c[1].trim().toLowerCase())) return { artist: c[1].trim(), title: c[2].trim() };
  return { artist: channel || "YouTube", title: title || rawTitle.trim() };
}

export function mapVideo(v: FlatVideo): Track | null {
  const key = v.ie_key ?? v.extractor_key;
  if (!v.id || !ID_RE.test(v.id)) return null;
  if (key !== undefined && !/^youtube$/i.test(key)) return null;
  if (v._type && v._type !== "url" && v._type !== "video") return null;
  if (v.is_live || (v.live_status && v.live_status !== "not_live" && v.live_status !== "was_live")) return null;
  if (v.availability && v.availability !== "public" && v.availability !== "unlisted") return null;
  const duration = Math.floor(Number(v.duration) || 0);
  if (duration < MIN_SEC || duration > MAX_SEC) return null;
  const rawTitle = (v.title ?? "").trim();
  if (!rawTitle || NOT_FULL_TITLE.test(rawTitle) || LOOP_TITLE.test(rawTitle)) return null;
  const { artist, title } = parseVideoTitle(rawTitle, (v.uploader ?? v.channel ?? "").trim());
  return {
    id: `yt:${v.id}`,
    source: "ytdlp",
    title: title.slice(0, 200),
    artist: artist.slice(0, 120),
    artistId: null,
    album: null,
    albumId: null,
    cover: `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`,
    duration,
    // Публичный ролик целиком — это полная запись самого ролика; фактическую длину ещё сверяют сервер и плеер
    full: true,
    // Право на скачивание не подразумевается: проверяется лицензия ролика при запросе (только Creative Commons)
    downloadable: false,
  };
}

const searchCache = new Map<string, { at: number; items: Track[] }>();

async function searchTracks(query: string, limit = 10): Promise<Track[]> {
  // Управляющие символы и переводы строк ни к чему; длину ограничиваем
  const q = query.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
  if (!q) return [];
  const n = Math.max(1, Math.min(Math.floor(limit), 15));
  const key = `${n}:${q.toLowerCase()}`;
  const hit = searchCache.get(key);
  if (hit && Date.now() - hit.at < SEARCH_TTL_MS) return hit.items;
  await ensureReady();
  // Запрос — один аргумент с префиксом ytsearchN:, поэтому не может стать опцией yt-dlp
  const raw = await run(["--flat-playlist", "--dump-single-json", `ytsearch${n}:${q}`]);
  let parsed: { entries?: FlatVideo[] };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new YtDlpError("failed");
  }
  const seen = new Set<string>();
  const items = (parsed.entries ?? [])
    .map(mapVideo)
    .filter((t): t is Track => Boolean(t) && !seen.has(t!.id) && Boolean(seen.add(t!.id)));
  if (searchCache.size > 300) searchCache.delete(searchCache.keys().next().value!);
  searchCache.set(key, { at: Date.now(), items });
  return items;
}

/* ───────── Получение потока ───────── */

export interface ResolvedAudio {
  id: string;
  url: string;
  headers: Record<string, string>;
  mime: string;
  ext: string;
  duration: number;
  title: string;
  uploader: string;
  license: string | null;
  creativeCommons: boolean;
  expiresAt: number;
}

interface FullInfo {
  id?: string;
  title?: string;
  uploader?: string;
  channel?: string;
  duration?: number;
  license?: string;
  availability?: string;
  live_status?: string;
  is_live?: boolean;
  url?: string;
  ext?: string;
  protocol?: string;
  http_headers?: Record<string, string>;
}

const INFO_TEMPLATE = "%(.{id,title,uploader,channel,duration,license,availability,live_status,is_live,url,ext,protocol,http_headers})j";
// Заголовки, которые yt-dlp просит передать источнику. Cookie и прочее не пересылаем никогда
const FORWARD_HEADERS = new Set(["user-agent", "accept-language", "referer", "origin"]);
const MIME: Record<string, string> = { m4a: "audio/mp4", mp4: "audio/mp4", webm: "audio/webm", mp3: "audio/mpeg", ogg: "audio/ogg", opus: "audio/ogg" };

let mediaUrlAllowed = (u: URL) => u.protocol === "https:" && (u.hostname === "googlevideo.com" || u.hostname.endsWith(".googlevideo.com"));

const resolved = new Map<string, ResolvedAudio>();
const failures = new Map<string, { until: number; error: YtDlpError }>();
const inflight = new Map<string, Promise<ResolvedAudio>>();

export const isCreativeCommons = (license: string | null | undefined) => Boolean(license && /creative\s*commons/i.test(license));

function expiryOf(url: URL): number {
  const expire = Number(url.searchParams.get("expire"));
  const cap = Date.now() + 2 * 60 * 60 * 1000;
  // Запас 5 минут: ссылка не должна истечь посреди прослушивания
  return Number.isFinite(expire) && expire > 0 ? Math.min(expire * 1000 - 5 * 60 * 1000, cap) : Date.now() + 30 * 60 * 1000;
}

export function parseResolved(id: string, raw: string): ResolvedAudio {
  let info: FullInfo;
  try {
    info = JSON.parse(raw.split(/\r?\n/).find((l) => l.trim().startsWith("{")) ?? "");
  } catch {
    throw new YtDlpError("failed");
  }
  if (info.id && info.id !== id) throw new YtDlpError("failed");
  if (info.is_live || info.live_status === "is_live" || info.live_status === "is_upcoming") throw new YtDlpError("live");
  if (info.availability && !["public", "unlisted"].includes(info.availability)) {
    throw new YtDlpError(info.availability === "private" ? "private" : "auth");
  }
  let url: URL;
  try {
    url = new URL(info.url ?? "");
  } catch {
    throw new YtDlpError("no_audio");
  }
  // Только HTTPS и только медиасерверы YouTube: никаких произвольных адресов дальше по цепочке
  if (!mediaUrlAllowed(url)) throw new YtDlpError("no_audio");
  const duration = Math.floor(Number(info.duration) || 0);
  if (duration < MIN_SEC) throw new YtDlpError("too_short");
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(info.http_headers ?? {})) if (FORWARD_HEADERS.has(k.toLowerCase()) && typeof v === "string") headers[k] = v;
  const ext = (info.ext ?? "m4a").toLowerCase();
  const license = info.license?.trim() || null;
  return {
    id,
    url: url.toString(),
    headers,
    ext,
    mime: MIME[ext] ?? "audio/mp4",
    duration,
    title: (info.title ?? "").trim(),
    uploader: (info.uploader ?? info.channel ?? "").trim(),
    license,
    creativeCommons: isCreativeCommons(license),
    expiresAt: expiryOf(url),
  };
}

function rememberFailure(id: string, error: YtDlpError) {
  lastStreamError = { code: error.code ?? `ytdlp_${error.reason}`, at: new Date().toISOString() };
  if (NOT_CACHED.has(error.reason)) return;
  if (failures.size > 500) failures.delete(failures.keys().next().value!);
  failures.set(id, { until: Date.now() + (FAILURE_TTL_MS[error.reason] ?? PERMANENT_FAILURE_TTL_MS), error });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function extract(id: string): Promise<ResolvedAudio> {
  await ensureReady();
  for (let attempt = 0; ; attempt++) {
    try {
      const raw = await run(["--skip-download", "--format", AUDIO_FORMAT, "--print", INFO_TEMPLATE, `https://www.youtube.com/watch?v=${id}`], {
        // Полное извлечение дольше поиска (подпись, JS-задачи YouTube)
        timeoutMs: Math.min(60_000, cfg.timeoutMs + 7_000),
        priority: true,
      });
      return parseResolved(id, raw);
    } catch (e) {
      // Повторяем только временную сетевую ошибку и не больше двух раз
      if (!(e instanceof YtDlpError) || e.reason !== "network" || attempt >= retryDelaysMs.length) throw e;
      await sleep(retryDelaysMs[attempt]);
    }
  }
}

/**
 * Свежая прямая ссылка на аудио. Кэшируется до истечения, чтобы перемотка не запускала yt-dlp заново.
 * Одновременные запросы одного ролика ждут один и тот же процесс; неудача запоминается на время по её типу.
 */
async function resolve(id: string, opts: { force?: boolean } = {}): Promise<ResolvedAudio> {
  if (!ID_RE.test(id)) throw new YtDlpError("bad_id");
  if (opts.force) resolved.delete(id);
  const hit = resolved.get(id);
  if (hit && hit.expiresAt > Date.now()) return hit;
  const failed = failures.get(id);
  if (!opts.force && failed && failed.until > Date.now()) throw failed.error;
  const running = inflight.get(id);
  if (running) return running;
  const job = extract(id)
    .then((r) => {
      failures.delete(id);
      if (resolved.size > 300) resolved.delete(resolved.keys().next().value!);
      resolved.set(id, r);
      return r;
    })
    .catch((e) => {
      const error = e instanceof YtDlpError ? e : new YtDlpError("failed");
      rememberFailure(id, error);
      throw error;
    })
    .finally(() => inflight.delete(id));
  inflight.set(id, job);
  return job;
}

/** Метаданные ролика как трек (если клиент прислал только id) */
async function track(id: string): Promise<Track | null> {
  const r = await resolve(id);
  const { artist, title } = parseVideoTitle(r.title || id, r.uploader);
  return {
    id: `yt:${id}`,
    source: "ytdlp",
    title,
    artist,
    artistId: null,
    album: null,
    albumId: null,
    cover: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    duration: r.duration,
    full: true,
    downloadable: r.creativeCommons,
  };
}

export const ytdlp = {
  status,
  searchTracks,
  resolve,
  track,
  /** Источник ответил 403/410 — ссылка истекла или отозвана: забываем её */
  invalidate(id: string) {
    resolved.delete(id);
  },
  /** Медиасервер не отдал звук даже по свежей ссылке — запоминаем, чтобы не запускать yt-dlp на каждый запрос */
  markFailed(id: string, reason: YtDlpErrorCode): YtDlpError {
    resolved.delete(id);
    const error = new YtDlpError(reason);
    rememberFailure(id, error);
    return error;
  },
  async streamUrl(id: string): Promise<string | null> {
    return (await resolve(id)).url;
  },
};

/** Только для тестов: разрешить локальный медиасервер вместо googlevideo и сбросить состояние */
export const ytdlpTesting = {
  allowMediaUrl(fn: (url: URL) => boolean) {
    mediaUrlAllowed = fn;
  },
  setRetryDelays(ms: number[]) {
    retryDelaysMs = ms;
  },
  reset() {
    lastStreamError = null;
    resolved.clear();
    failures.clear();
    searchCache.clear();
    statusCache = null;
    notInstalledUntil = 0;
  },
  get active() {
    return active;
  },
};
