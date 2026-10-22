import { like, or } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { archive } from "../providers/archive.js";
import { audius } from "../providers/audius.js";
import { jamendo } from "../providers/jamendo.js";
import { openverse } from "../providers/openverse.js";
import { ytdlp } from "../providers/ytdlp.js";
import type { Source, Track } from "../types.js";
import { isCensoredTitle, isConfirmedFull, MIN_FULL_SEC } from "./fullOnly.js";
import { getTracks, upsertTracks } from "./tracks.js";

/** Нормализация для сравнения: без регистра, скобок «(feat. …)», «- Remastered», знаков */
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/\((feat|ft|with)[^)]*\)|\[(feat|ft|with)[^\]]*\]/g, " ")
    .replace(/\s-\s.*(remaster|version|edit|mix).*$/g, " ")
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function tokens(s: string) {
  return new Set(normalize(s).split(" ").filter(Boolean));
}

/** Доля общих слов (0..1) */
export function similarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.size || !tb.size) return 0;
  let common = 0;
  for (const t of ta) if (tb.has(t)) common++;
  return common / Math.max(ta.size, tb.size);
}


export function splitArtists(artist: string): string[] {
  return artist
    .split(/\s*(?:&|,|\bfeat\.?|\bft\.?|\bx\b|\bи\b)\s*/i)
    .map((a) => a.trim())
    .filter((a) => a.length > 1);
}

// Пометки другой версии записи. Оригинал не подменяем ремиксом, кавером, утечкой, концертной записью и т.п.
const VARIANT_WORDS =
  /(?<![\p{L}\p{N}])(remix|rmx|cover|live|leak|leaked|sped up|slowed|nightcore|instrumental|karaoke|acoustic|unplugged|mashup|bootleg|demo|extended|reprise|vip|8d|reverb|bass boosted|ремикс|кавер|лайв|слив|инструментал|караоке)(?![\p{L}\p{N}])/giu;

/** Набор пометок версии в названии: «Song (Remix)» → {remix} */
export function variantMarks(title: string): string {
  return [...new Set((title.toLowerCase().match(VARIANT_WORDS) ?? []).map((w) => (w === "leaked" ? "leak" : w.replace(/\s+/g, " "))))]
    .sort()
    .join(",");
}

/** Подходит ли кандидат как полная версия трека-оригинала */
export function scoreCandidate(target: Pick<Track, "title" | "artist" | "duration">, c: Pick<Track, "title" | "artist" | "duration" | "full" | "source">): number {
  if (!isConfirmedFull(c)) return 0; // превью и обрывки не считаем
  if (variantMarks(target.title) !== variantMarks(c.title)) return 0; // другая версия записи — не та же песня
  const titleSim = Math.max(similarity(target.title, c.title), similarity(`${target.artist} ${target.title}`, c.title));
  if (titleSim < 0.6) return 0;
  // «A & B», «A feat. B» — достаточно совпадения с любым из артистов
  const parts = [target.artist, ...splitArtists(target.artist)];
  const artistSim = Math.max(
    ...parts.map((a) => Math.max(similarity(a, c.artist), c.title.toLowerCase().includes(a.toLowerCase()) ? 1 : 0)),
  );
  if (artistSim < 0.5) return 0;
  // Длительность должна совпадать: ±12% или ±15 с (если она известна у оригинала)
  if (target.duration >= MIN_FULL_SEC) {
    const diff = Math.abs(c.duration - target.duration);
    if (diff > Math.max(15, target.duration * 0.12)) return 0;
  }
  let score = titleSim * 0.6 + artistSim * 0.4;
  // Цензурная версия (clean / radio edit) — только если оригинал сам цензурный
  if (isCensoredTitle(c.title) && !isCensoredTitle(target.title)) score *= 0.6;
  return score;
}

/** Реальная проверка: источник отдаёт аудио (запрос первых байт) */
export async function probeAudio(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { headers: { range: "bytes=0-1023" }, redirect: "follow", signal: AbortSignal.timeout(8000) });
    const type = res.headers.get("content-type") ?? "";
    await res.body?.cancel();
    return (res.status === 200 || res.status === 206) && (type.startsWith("audio/") || type === "application/octet-stream");
  } catch {
    return false;
  }
}

function libraryCandidates(target: Track): Track[] {
  const words = normalize(target.title).split(" ").filter((w) => w.length > 2).slice(0, 3);
  if (!words.length) return [];
  const rows = db
    .select({ id: schema.tracks.id })
    .from(schema.tracks)
    .where(or(...words.map((w) => like(schema.tracks.title, `%${w}%`))))
    .all()
    .filter((r) => r.id.startsWith("lib:"));
  return getTracks(rows.map((r) => r.id));
}

const safe = <T>(p: Promise<T>, fallback: T) => p.catch(() => fallback);

/** firstQueryOnly — дорогой источник (процесс yt-dlp) спрашиваем один раз, а не на каждый вариант запроса */
export type SearchProvider = ((query: string) => Promise<Track[]>) & { firstQueryOnly?: boolean; source?: Source };

const provider = (source: Source, fn: (q: string) => Promise<Track[]>, extra: { firstQueryOnly?: boolean } = {}): SearchProvider =>
  Object.assign(fn, { source, ...extra });

export const defaultProviders: SearchProvider[] = [
  provider("audius", (q) => audius.searchTracks(q, 15)),
  provider("jamendo", (q) => jamendo.searchTracks(q, 10)),
  provider("archive", (q) => archive.searchTracks(q, 10)),
  provider("openverse", (q) => openverse.searchTracks(q, 10)),
  provider("ytdlp", (q) => ytdlp.searchTracks(q, 8), { firstQueryOnly: true }),
];

interface FindOptions {
  streamUrlOf: (t: Track) => Promise<string | null>;
  /** Не предлагать эти источники (например, YouTube, когда он не отдал звук) */
  excludeSources?: Source[];
  providers?: SearchProvider[];
  probe?: (url: string) => Promise<boolean>;
  library?: (t: Track) => Track[];
}

const cache = new Map<string, { at: number; result: FindResult }>();
const CACHE_MS = 6 * 60 * 60 * 1000;
type FindResult = { track: Track | null; checked: { source: string; title: string; ok: boolean }[] };

/**
 * Ищет полную версию трека во всех подключённых полных источниках:
 * ваша библиотека → Audius → Jamendo → Internet Archive / Openverse (CC) → YouTube через yt-dlp.
 * Источник, у которого только превью, просто не участвует — поиск идёт дальше.
 */
export async function findFullVersion(target: Track, opts: FindOptions): Promise<FindResult> {
  const exclude = new Set<Source>(opts.excludeSources ?? []);
  const cacheKey = `${target.id}|${[...exclude].sort().join(",")}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_MS && !opts.providers) return hit.result;

  const providers = (opts.providers ?? defaultProviders).filter((p) => !p.source || !exclude.has(p.source));
  const probe = opts.probe ?? probeAudio;
  // Несколько вариантов запроса: строгий поиск часто пуст, а по одному названию — шумный
  const primary = splitArtists(target.artist)[0] ?? target.artist;
  const title = normalize(target.title);
  const queries = [...new Set([`${primary} ${title}`, `${target.artist} ${target.title}`, title])].map((q) => q.slice(0, 100));
  const results = await Promise.all(queries.flatMap((q, qi) => providers.filter((p) => qi === 0 || !p.firstQueryOnly).map((p) => safe(p(q), []))));
  const seen = new Set<string>();
  const remote = results.flat().filter((t) => !seen.has(t.id) && seen.add(t.id));

  const candidates = [...(opts.library ?? libraryCandidates)(target), ...remote]
    .filter((c) => c.id !== target.id && !exclude.has(c.source))
    .map((c) => ({ c, score: scoreCandidate(target, c) + (c.source === "library" ? 0.2 : 0) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  const checked: FindResult["checked"] = [];
  let found: Track | null = null;
  for (const { c } of candidates.slice(0, 4)) {
    const url = c.source === "library" ? null : await opts.streamUrlOf(c).catch(() => null);
    const ok = c.source === "library" ? true : url ? await probe(url) : false;
    checked.push({ source: c.source, title: `${c.artist} — ${c.title}`, ok });
    if (ok) {
      found = c;
      break;
    }
  }
  if (found && !opts.providers) upsertTracks([found]);
  const result = { track: found, checked };
  if (!opts.providers) cache.set(cacheKey, { at: Date.now(), result });
  return result;
}
