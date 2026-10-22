import type { Source, Track } from "../types.js";

/*
 * Единое правило Suynd: играем только подтверждённые полные треки.
 * Deezer и iTunes отдают лишь 30-секундные фрагменты — их записи служат каталогом
 * (метаданные, обложки, поиск полной версии), но никогда не воспроизводятся.
 */
export const FULL_SOURCES: ReadonlySet<Source> = new Set<Source>(["audius", "archive", "jamendo", "openverse", "library"]);
export const PREVIEW_ONLY_SOURCES: ReadonlySet<Source> = new Set<Source>(["deezer", "itunes"]);

/** Короче — считаем фрагментом, даже если источник называет это треком */
export const MIN_FULL_SEC = 45;

export function isConfirmedFull(t: Pick<Track, "source" | "full" | "duration">): boolean {
  return FULL_SOURCES.has(t.source) && t.full === true && t.duration >= MIN_FULL_SEC;
}

export function onlyFull<T extends Pick<Track, "source" | "full" | "duration">>(list: T[]): T[] {
  return list.filter(isConfirmedFull);
}

export function isPreviewOnlyId(id: string): boolean {
  return id.startsWith("dz:") || id.startsWith("it:");
}

/** Реальная длительность звука похожа на полный трек (а не на обрезок) */
export function isFullLengthAudio(expectedSec: number, actualSec: number): boolean {
  if (!Number.isFinite(actualSec) || actualSec < MIN_FULL_SEC) return false;
  return expectedSec > 0 ? actualSec >= expectedSec * 0.8 : true;
}

const CENSORED = /\b(clean|radio edit|radio version|censored|edited version)\b/i;
export const isCensoredTitle = (title: string) => CENSORED.test(title);
