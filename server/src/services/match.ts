import type { Track } from "../types.js";
import { isCensoredTitle, isConfirmedFull, MIN_FULL_SEC } from "./fullOnly.js";
import { translit } from "./translit.js";

/*
 * Сопоставление треков: та ли это песня, а не похожая, кавер, ремикс, концертная запись или ускоренная версия.
 * Используется поиском (лучший результат), поиском полной версии для каталога Deezer и «волной».
 */

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

/** Слова для сравнения; кириллица приводится к латинице, чтобы «Скам» и «Skam» совпадали */
function tokens(s: string): Set<string> {
  return new Set(
    normalize(s)
      .split(" ")
      .filter(Boolean)
      .map((w) => translit(w)),
  );
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

/** Набор пометок версии в названии: «Song (Remix)» → «remix» */
export function variantMarks(title: string): string {
  return [...new Set((title.toLowerCase().match(VARIANT_WORDS) ?? []).map((w) => (w === "leaked" ? "leak" : w.replace(/\s+/g, " "))))]
    .sort()
    .join(",");
}

type Comparable = Pick<Track, "title" | "artist" | "duration" | "full" | "source">;

/** Подходит ли кандидат как полная версия конкретного трека (0 — нет) */
export function scoreCandidate(target: Pick<Track, "title" | "artist" | "duration">, c: Comparable): number {
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

/**
 * Насколько трек отвечает самому запросу (когда в каталоге нет эталона: например, запрос — имя исполнителя).
 * Почти все слова запроса должны быть в «артист + название», а пометки версии — только те, что в запросе.
 */
export function queryScore(query: string, c: Comparable): number {
  if (!isConfirmedFull(c)) return 0;
  const q = tokens(query);
  if (!q.size) return 0;
  const hay = tokens(`${c.artist} ${c.title}`);
  let hit = 0;
  for (const t of q) if (hay.has(t)) hit++;
  const coverage = hit / q.size;
  if (coverage < 0.75) return 0;
  const wanted = new Set(variantMarks(query).split(",").filter(Boolean));
  if (variantMarks(c.title).split(",").filter(Boolean).some((m) => !wanted.has(m))) return 0;
  // Меньше лишних слов в названии — точнее совпадение
  return coverage * 0.7 + (hit / hay.size) * 0.3;
}

/**
 * Запрос называет конкретную песню из каталога? Да, если в нём есть большая часть слов названия
 * и (если исполнитель указан) его имя.
 */
export function namesTrack(query: string, ref: Pick<Track, "title" | "artist">): boolean {
  const q = tokens(query);
  const title = tokens(ref.title);
  if (!title.size) return false;
  let titleHit = 0;
  for (const t of title) if (q.has(t)) titleHit++;
  if (titleHit / title.size < 0.6) return false;
  const artist = tokens(ref.artist);
  const rest = [...q].filter((t) => !title.has(t));
  // Слова сверх названия должны относиться к исполнителю, иначе запрос про другую песню
  return rest.length === 0 || rest.filter((t) => artist.has(t)).length / rest.length >= 0.5;
}

/** Назван ли в запросе исполнитель эталона: слова его имени (или соавтора), которых нет в названии */
export function mentionsArtist(query: string, ref: Pick<Track, "artist" | "title">): boolean {
  const q = tokens(query);
  const title = tokens(ref.title);
  return [ref.artist, ...splitArtists(ref.artist)].some((a) => [...tokens(a)].some((t) => q.has(t) && !title.has(t)));
}

/** Одна и та же запись (для склейки дублей из разных источников) */
export function sameRecording(a: Comparable, b: Comparable): boolean {
  return scoreCandidate(a, b) > 0 || scoreCandidate(b, a) > 0;
}
