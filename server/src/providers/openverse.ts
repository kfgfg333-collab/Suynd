import { getJson } from "../http.js";
import type { Track } from "../types.js";

/*
 * Openverse (WordPress Foundation): открытый индекс CC-аудио — в основном полные треки Jamendo,
 * а также Wikimedia Commons. Ключ не нужен. Лицензия каждой записи — CC, копирование для себя разрешено.
 *
 * Детальный эндпоинт Openverse нестабилен, поэтому прямую ссылку на файл кладём в id трека
 * (base64url) и при воспроизведении пускаем только хосты из белого списка.
 */
const API = "https://api.openverse.org/v1/audio/";
const ALLOWED_HOSTS = new Set(["prod-1.storage.jamendo.com", "mp3d.jamendo.com", "upload.wikimedia.org"]);

/* eslint-disable @typescript-eslint/no-explicit-any */
export function encodeOpenverseId(url: string) {
  return `ov:${Buffer.from(url).toString("base64url")}`;
}

/** Ссылка на файл из id — только с разрешённых хостов (никаких произвольных адресов) */
export function openverseUrl(raw: string): string | null {
  try {
    const url = new URL(Buffer.from(raw, "base64url").toString());
    return url.protocol === "https:" && ALLOWED_HOSTS.has(url.hostname) ? url.toString() : null;
  } catch {
    return null;
  }
}

function mapTrack(r: any): Track | null {
  if (!r?.url || !openverseUrl(Buffer.from(r.url).toString("base64url"))) return null;
  return {
    id: encodeOpenverseId(r.url),
    source: "openverse",
    title: r.title || "Без названия",
    artist: r.creator || "Неизвестный артист",
    artistId: null,
    album: r.audio_set?.title ?? null,
    albumId: null,
    cover: r.audio_set?.thumbnail || r.thumbnail || null,
    duration: Math.round((Number(r.duration) || 0) / 1000),
    full: true,
    downloadable: true,
    genre: r.genres?.[0] ?? null,
    explicit: Boolean(r.mature),
  };
}

export const openverse = {
  async searchTracks(q: string, limit = 12): Promise<Track[]> {
    const url = `${API}?${new URLSearchParams({ q, category: "music", page_size: String(Math.min(40, limit * 2)) })}`;
    const r = await getJson<any>(url, { ttlSec: 3600, timeoutMs: 8000 });
    return (r?.results ?? [])
      .map(mapTrack)
      .filter((t: Track | null): t is Track => Boolean(t))
      .slice(0, limit);
  },
};
