import { like, or } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { log, queryHash } from "../log.js";
import { deezer } from "../providers/deezer.js";
import { type MusicProvider, providers as allProviders, streamSourceUrl } from "../providers/index.js";
import { officialLinks } from "../providers/links.js";
import type { OfficialLinks, Source, Track } from "../types.js";
import { isCensoredTitle, isConfirmedFull } from "./fullOnly.js";
import { mentionsArtist, namesTrack, normalize, queryScore, sameRecording, scoreCandidate, splitArtists } from "./match.js";
import { getTracks, upsertTracks } from "./tracks.js";
import { queryVariants } from "./translit.js";

/*
 * Агрегатор: запрос → параллельный поиск во всех источниках полных треков → один лучший проверенный результат.
 *
 * 1. Запрос очищается (управляющие символы, длина).
 * 2. Каталог Deezer даёт эталон: если запрос называет конкретную песню, кандидаты сравниваются с ней
 *    (название, исполнитель, длительность, версия). Иначе (например, имя исполнителя) — с самим запросом.
 * 3. Источники опрашиваются параллельно, у каждого свой тайм-аут; упавший источник пропускается 30 с.
 * 4. Дубли склеиваются, превью и обрывки отбрасываются, ремикс/кавер/live/sped up не выдаются за оригинал.
 * 5. Поток лучшего кандидата проверяется реальным запросом к аудио; не отдаёт — берётся следующий.
 * 6. Та же запись из других источников возвращается как alternates: плеер переключится на них при сбое.
 * Результаты кэшируются, одинаковые одновременные запросы ждут один поиск.
 */

export interface SearchDeps {
  providers: MusicProvider[];
  /** Каталог-эталон (метаданные, без воспроизведения) */
  catalog(query: string): Promise<Track[]>;
  /** Ваши файлы, подходящие по словам запроса */
  library(query: string): Track[];
  streamUrlOf(t: Track): Promise<string | null>;
  probe(url: string): Promise<boolean>;
  persist(tracks: Track[]): void;
}

export interface CatalogMatch {
  id: string;
  title: string;
  artist: string;
  cover: string | null;
  duration: number;
  explicit: boolean;
}

export interface BestResult {
  query: string;
  /** track — запрос называет конкретную песню; artist — подбор по словам запроса */
  mode: "track" | "artist";
  best: Track | null;
  /** Другие песни по запросу исполнителя (не дубли лучшего результата) */
  more: Track[];
  /** Эталон из каталога: что именно мы искали */
  catalog: CatalogMatch | null;
  /** Официальные ссылки, если полной версии в разрешённых источниках нет */
  links: OfficialLinks | null;
  /** Часть источников не ответила — результат может быть неполным */
  partial: boolean;
}

export interface FullVersionResult {
  track: Track | null;
  checked: { source: Source; title: string; ok: boolean }[];
}

const PER_PROVIDER = 10;
const MAX_PROBES = 4;
const MAX_ALTERNATES = 3;
const MAX_MORE = 5;
const RESULT_TTL_MS = 10 * 60_000;
const EMPTY_TTL_MS = 2 * 60_000;
const PROVIDER_COOLDOWN_MS = 30_000;
const OPTIONAL_GRACE_MS = 500;
const PROBE_OK_TTL_MS = 10 * 60_000;
const PROBE_FAIL_TTL_MS = 2 * 60_000;
const MAX_ENTRIES = 500;
// Небольшой перевес источникам с более стабильной отдачей и вашим файлам
const SOURCE_BONUS: Partial<Record<Source, number>> = { library: 0.2, audius: 0.03, jamendo: 0.03 };

/** Очистка пользовательского ввода: управляющие символы, лишние пробелы, длина */
export function sanitizeQuery(raw: unknown): string {
  return String(raw ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}

function limiter(max: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= max) await new Promise<void>((r) => waiting.push(r));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      (v) => (clearTimeout(timer), resolve(v)),
      (e) => (clearTimeout(timer), reject(e)),
    );
  });
}

function remember<K, V>(map: Map<K, V>, key: K, value: V) {
  if (map.size >= MAX_ENTRIES) map.delete(map.keys().next().value as K);
  map.set(key, value);
}

const uniqueById = (list: Track[]) => {
  const seen = new Set<string>();
  return list.filter((t) => !seen.has(t.id) && Boolean(seen.add(t.id)));
};

// Сообщения об ошибках источников без параметров запросов (там может быть ключ API)
const safeError = (e: unknown) => String((e as Error)?.message ?? e).replace(/(client_id|key|token)=[^&\s]+/gi, "$1=***").slice(0, 120);

/** Эталон: первая песня каталога, которую запрос действительно называет (explicit предпочтительнее clean) */
export function pickReference(query: string, catalog: Track[]): Track | null {
  const named = catalog.filter((c) => namesTrack(query, c));
  return named.find((c) => !isCensoredTitle(c.title)) ?? named[0] ?? null;
}

export function createSearch(deps: SearchDeps) {
  const results = new Map<string, { until: number; value: BestResult | FullVersionResult }>();
  const inflight = new Map<string, Promise<BestResult | FullVersionResult>>();
  const cooldown = new Map<Source, number>();
  const probes = new Map<string, { until: number; ok: boolean }>();
  // Не больше 6 одновременных запросов к внешним API со всего сервера
  const slot = limiter(6);

  async function gather(queries: string[]): Promise<{ tracks: Track[]; failed: Source[] }> {
    const failed = new Set<Source>();
    const jobs = deps.providers
      .filter((p) => p.enabled())
      .flatMap((p) =>
        queries.map(async (q) => {
          if ((cooldown.get(p.source) ?? 0) > Date.now()) {
            if (!p.optional) failed.add(p.source);
            return [];
          }
          const started = Date.now();
          try {
            const list = await slot(() => withTimeout(p.search(q, PER_PROVIDER), p.timeoutMs));
            log("info", "provider", { provider: p.source, ms: Date.now() - started, n: list.length });
            return list;
          } catch (e) {
            // Короткая пауза для сбойного источника: следующие запросы его не ждут
            cooldown.set(p.source, Date.now() + PROVIDER_COOLDOWN_MS);
            if (!p.optional) failed.add(p.source);
            log("warn", "provider_error", { provider: p.source, ms: Date.now() - started, error: safeError(e) });
            return [];
          }
        }),
      );
    // Необязательный источник не задерживает выдачу: ждём его не дольше чем 0,5 с после основных
    const enabled = deps.providers.filter((p) => p.enabled());
    const perProvider = enabled.flatMap((p) => queries.map(() => p));
    const core = Promise.all(jobs.filter((_, i) => !perProvider[i].optional));
    const grace = core.then(() => new Promise<Track[]>((r) => setTimeout(() => r([]), OPTIONAL_GRACE_MS)));
    const lists = await Promise.all(jobs.map((j, i) => (perProvider[i].optional ? Promise.race([j, grace]) : j)));
    return { tracks: uniqueById(lists.flat()).filter(isConfirmedFull), failed: [...failed] };
  }

  /** Реальная проверка: источник отдаёт аудио. Результат помним, чтобы не дёргать источник повторно */
  async function verify(t: Track): Promise<boolean> {
    if (t.source === "library") return true;
    const hit = probes.get(t.id);
    if (hit && hit.until > Date.now()) return hit.ok;
    const url = await deps.streamUrlOf(t).catch(() => null);
    const ok = url ? await deps.probe(url).catch(() => false) : false;
    remember(probes, t.id, { ok, until: Date.now() + (ok ? PROBE_OK_TTL_MS : PROBE_FAIL_TTL_MS) });
    return ok;
  }

  function rank(pool: Track[], score: (t: Track) => number): Track[] {
    return pool
      .map((t) => ({ t, s: score(t) }))
      .filter((x) => x.s > 0)
      .map((x) => ({ t: x.t, s: x.s + (SOURCE_BONUS[x.t.source] ?? 0) + (x.t.cover ? 0.02 : 0) }))
      .sort((a, b) => b.s - a.s)
      .map((x) => x.t);
  }

  /** Склейка одной записи из разных источников; порядок по рангу сохраняется */
  function group(ranked: Track[]): Track[][] {
    const groups: Track[][] = [];
    for (const t of ranked) {
      const g = groups.find((x) => sameRecording(x[0], t));
      if (g) g.push(t);
      else groups.push([t]);
    }
    return groups;
  }

  /** Первый кандидат с работающим потоком; остальные из его группы — запасные источники */
  async function pick(groups: Track[][], checked: FullVersionResult["checked"] = []) {
    let probesLeft = MAX_PROBES;
    for (let gi = 0; gi < groups.length && probesLeft > 0; gi++) {
      const g = groups[gi];
      for (let i = 0; i < g.length && probesLeft > 0; i++) {
        if (g[i].source !== "library") probesLeft--;
        const ok = await verify(g[i]);
        checked.push({ source: g[i].source, title: `${g[i].artist} — ${g[i].title}`, ok });
        if (ok) {
          const alternates = g.filter((_, j) => j !== i).slice(0, MAX_ALTERNATES);
          return { best: { ...g[i], alternates } as Track, rest: groups.slice(gi + 1) };
        }
      }
    }
    return { best: null, rest: [] as Track[][] };
  }

  function cached<T extends BestResult | FullVersionResult>(key: string, run: () => Promise<{ value: T; ttl: number }>): Promise<T> {
    const hit = results.get(key);
    if (hit && hit.until > Date.now()) return Promise.resolve(hit.value as T);
    const running = inflight.get(key);
    if (running) return running as Promise<T>;
    const job = run()
      .then(({ value, ttl }) => {
        remember(results, key, { until: Date.now() + ttl, value });
        return value;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, job);
    return job;
  }

  async function findBest(raw: string): Promise<BestResult> {
    const query = sanitizeQuery(raw);
    if (!query) return { query, mode: "artist", best: null, more: [], catalog: null, links: null, partial: false };
    return cached(`q:${query.toLowerCase()}`, async () => {
      const started = Date.now();
      const [catalog, first] = await Promise.all([deps.catalog(query).catch(() => [] as Track[]), gather([query])]);
      const ref = pickReference(query, catalog);
      let pool = first.tracks;
      const failed = new Set(first.failed);
      if (ref) {
        // Каноническое написание из каталога находит то, что не нашёл запрос пользователя (транслит, порядок слов)
        const canonical = sanitizeQuery(`${splitArtists(ref.artist)[0] ?? ref.artist} ${normalize(ref.title)}`);
        if (normalize(canonical) !== normalize(query)) {
          const extra = await gather([canonical]);
          pool = uniqueById([...pool, ...extra.tracks]);
          extra.failed.forEach((s) => failed.add(s));
        }
      }
      pool = uniqueById([...deps.library(ref ? `${ref.artist} ${ref.title}` : query), ...pool]);

      let mode: BestResult["mode"] = ref ? "track" : "artist";
      let ranked = ref ? rank(pool, (t) => scoreCandidate(ref, t)) : rank(pool, (t) => queryScore(query, t));
      // Исполнителя пользователь не называл («lofi chill», «Скам»): эталон каталога — лишь догадка.
      // Нет точного совпадения с ним — подбираем по словам запроса, не навязывая чужого исполнителя
      const strict = Boolean(ref && mentionsArtist(query, ref));
      if (ref && !ranked.length && !strict) {
        mode = "artist";
        ranked = rank(pool, (t) => queryScore(query, t));
      }
      // Для конкретной песни все совпадения — одна запись; иначе группируем по песням
      const groups = mode === "track" ? (ranked.length ? [ranked] : []) : group(ranked);
      const { best, rest } = await pick(groups);
      const more = mode === "artist" ? rest.slice(0, MAX_MORE).map((g) => g[0]) : [];
      if (best) deps.persist([best, ...(best.alternates ?? []), ...more]);

      const value: BestResult = {
        query,
        mode,
        best,
        more,
        catalog: ref && mode === "track" ? { id: ref.id, title: ref.title, artist: ref.artist, cover: ref.cover, duration: ref.duration, explicit: Boolean(ref.explicit) } : null,
        links: best ? null : ref && mode === "track" ? (ref.links ?? officialLinks(ref.artist, ref.title)) : officialLinks("", query),
        partial: failed.size > 0,
      };
      log("info", "search", {
        q: queryHash(query),
        mode,
        candidates: ranked.length,
        best: best?.source ?? null,
        alternates: best?.alternates?.length ?? 0,
        failed: [...failed],
        ms: Date.now() - started,
      });
      return { value, ttl: best && !value.partial ? RESULT_TTL_MS : EMPTY_TTL_MS };
    });
  }

  /** Полная версия конкретного трека (например, из каталога Deezer) в разрешённых источниках */
  async function findFullVersion(target: Track): Promise<FullVersionResult> {
    return cached(`full:${target.id}`, async () => {
      const primary = splitArtists(target.artist)[0] ?? target.artist;
      const queries = [...new Set([`${primary} ${normalize(target.title)}`, `${target.artist} ${target.title}`].map(sanitizeQuery))];
      const { tracks, failed } = await gather(queries);
      const pool = uniqueById([...deps.library(`${target.artist} ${target.title}`), ...tracks]).filter((t) => t.id !== target.id);
      const ranked = rank(pool, (t) => scoreCandidate(target, t));
      const checked: FullVersionResult["checked"] = [];
      const { best } = await pick(ranked.length ? [ranked] : [], checked);
      if (best) deps.persist([best, ...(best.alternates ?? [])]);
      log("info", "full_version", { source: target.source, candidates: ranked.length, best: best?.source ?? null, failed });
      return { value: { track: best, checked }, ttl: best && !failed.length ? RESULT_TTL_MS : EMPTY_TTL_MS };
    });
  }

  return { findBest, findFullVersion };
}

/* ───────── Настоящие зависимости ───────── */

/** Каталог Deezer с вариантами транслитерации: «Милано Скам» находит «Scally Milano — Скам» */
export async function deezerCatalog(query: string): Promise<Track[]> {
  const lists = await Promise.all(queryVariants(query).map((v) => withTimeout(deezer.searchTracks(v, 15), 6000).catch(() => [] as Track[])));
  return uniqueById(lists.flat()).slice(0, 20);
}

/** Ваши файлы, в названии или исполнителе которых есть слова запроса */
function libraryMatches(query: string): Track[] {
  const words = normalize(query)
    .split(" ")
    .filter((w) => w.length > 2)
    .slice(0, 4);
  if (!words.length) return [];
  const rows = db
    .select({ id: schema.tracks.id })
    .from(schema.tracks)
    .where(or(...words.flatMap((w) => [like(schema.tracks.title, `%${w}%`), like(schema.tracks.artist, `%${w}%`)])))
    .all()
    .filter((r) => r.id.startsWith("lib:"))
    .slice(0, 50);
  return getTracks(rows.map((r) => r.id));
}

/** Источник реально отдаёт аудио: первые байты, статус 200/206 и звуковой тип */
export async function probeAudio(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { headers: { range: "bytes=0-1023" }, redirect: "follow", signal: AbortSignal.timeout(4000) });
    const type = res.headers.get("content-type") ?? "";
    await res.body?.cancel();
    return (res.status === 200 || res.status === 206) && (type.startsWith("audio/") || type === "application/octet-stream");
  } catch {
    return false;
  }
}

const defaultDeps: SearchDeps = {
  providers: allProviders,
  catalog: deezerCatalog,
  library: libraryMatches,
  streamUrlOf: (t) => streamSourceUrl(t.id),
  probe: probeAudio,
  persist: upsertTracks,
};

let instance = createSearch(defaultDeps);

export const search = {
  findBest: (query: string) => instance.findBest(query),
  findFullVersion: (target: Track) => instance.findFullVersion(target),
};

/** Для тестов: подменить источники, каталог или проверку потока */
export function configureSearch(deps: Partial<SearchDeps>) {
  instance = createSearch({ ...defaultDeps, ...deps });
}
