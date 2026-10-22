import { like, or } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { archive } from "../providers/archive.js";
import { audius } from "../providers/audius.js";
import { jamendo } from "../providers/jamendo.js";
import type { Track } from "../types.js";
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

const MIN_FULL_SEC = 60;

export function splitArtists(artist: string): string[] {
  return artist
    .split(/\s*(?:&|,|\bfeat\.?|\bft\.?|\bx\b|\bи\b)\s*/i)
    .map((a) => a.trim())
    .filter((a) => a.length > 1);
}

/** Подходит ли кандидат как полная версия трека-оригинала */
export function scoreCandidate(target: Pick<Track, "title" | "artist" | "duration">, c: Pick<Track, "title" | "artist" | "duration" | "full">): number {
  if (!c.full || c.duration < MIN_FULL_SEC) return 0; // превью и обрывки не считаем
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
  return titleSim * 0.6 + artistSim * 0.4;
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

/**
 * Ищет полную версию трека в легальных источниках с полными файлами:
 * ваша библиотека → Audius → Jamendo → Internet Archive (CC / public domain).
 */
export async function findFullVersion(target: Track, streamUrlOf: (t: Track) => Promise<string | null>) {
  // Несколько вариантов запроса: строгий поиск часто пуст, а по одному названию — шумный
  const primary = splitArtists(target.artist)[0] ?? target.artist;
  const title = normalize(target.title);
  const queries = [...new Set([`${primary} ${title}`, `${target.artist} ${target.title}`, title])].map((q) => q.slice(0, 100));
  const results = await Promise.all(
    queries.flatMap((q) => [safe(audius.searchTracks(q, 15), []), safe(jamendo.searchTracks(q, 10), []), safe(archive.searchTracks(q, 10), [])]),
  );
  const seen = new Set<string>();
  const remote = results.flat().filter((t) => !seen.has(t.id) && seen.add(t.id));
  const candidates = [...libraryCandidates(target), ...remote]
    .filter((c) => c.id !== target.id)
    .map((c) => ({ c, score: scoreCandidate(target, c) + (c.source === "library" ? 0.2 : 0) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  const checked: { source: string; title: string; ok: boolean }[] = [];
  for (const { c } of candidates.slice(0, 4)) {
    const url = c.source === "library" ? null : await streamUrlOf(c).catch(() => null);
    const ok = c.source === "library" ? true : url ? await probeAudio(url) : false;
    checked.push({ source: c.source, title: `${c.artist} — ${c.title}`, ok });
    if (ok) {
      upsertTracks([c]);
      return { track: c, checked };
    }
  }
  return { track: null, checked };
}
