/*
 * Правило Suynd на клиенте (дублирует серверное): в плеер, очередь, избранное и офлайн
 * попадают только подтверждённые полные треки. Превью Deezer/iTunes не играют никогда.
 */
import type { Source, Track } from "./types";

export const FULL_SOURCES: ReadonlySet<Source> = new Set<Source>(["audius", "archive", "jamendo", "openverse", "library", "ytdlp"]);
export const MIN_FULL_SEC = 45;
export const FULL_UNAVAILABLE = "Полная версия недоступна";

export function isFullTrack(t: Pick<Track, "source" | "full" | "duration"> | null | undefined): boolean {
  return Boolean(t && FULL_SOURCES.has(t.source) && t.full === true && t.duration >= MIN_FULL_SEC);
}

export const onlyFull = <T extends Pick<Track, "source" | "full" | "duration">>(list: T[]) => list.filter(isFullTrack);

/** Реальная длительность звука похожа на полный трек, а не на обрезок */
export function isFullLengthAudio(expectedSec: number, actualSec: number): boolean {
  if (!Number.isFinite(actualSec) || actualSec < MIN_FULL_SEC) return false;
  return expectedSec > 0 ? actualSec >= expectedSec * 0.8 : true;
}

/**
 * Что играть, если пользователь нажал на трек `start` в списке.
 * Превью из списка выкидываются; если нажатый трек — не полный, плеер не стартует.
 */
export function planPlayback(tracks: Track[], start: number): { queue: Track[]; index: number } | null {
  const picked = tracks[start];
  if (!isFullTrack(picked)) return null;
  const queue = onlyFull(tracks);
  return { queue, index: queue.indexOf(picked) };
}
