import { getJson, UpstreamError } from "../http.js";
import type { Album, Artist, Track } from "../types.js";

const AUDIUS_BASE = "https://api.audius.co/v1";
const AUDIUS_APP = "suynd";

/* eslint-disable @typescript-eslint/no-explicit-any */
type AuObj = any;

async function au<T = AuObj>(path: string, ttlSec = 600): Promise<T> {
  const sep = path.includes("?") ? "&" : "?";
  const r = await getJson<{ data: T }>(`${AUDIUS_BASE}${path}${sep}app_name=${AUDIUS_APP}`, { ttlSec });
  return r.data;
}

const CALM_MOODS = new Set(["peaceful", "romantic", "sentimental", "tender", "easygoing", "yearning", "sophisticated", "melancholy", "cool", "brooding"]);
const ENERGETIC_MOODS = new Set(["energizing", "fiery", "aggressive", "excited", "upbeat", "rowdy", "defiant", "empowering", "stirring", "gritty"]);

export function moodEnergy(mood: string | null | undefined): "calm" | "energetic" | null {
  if (!mood) return null;
  const m = mood.toLowerCase();
  if (CALM_MOODS.has(m)) return "calm";
  if (ENERGETIC_MOODS.has(m)) return "energetic";
  return null;
}

/** Скачивание разрешено автором и не закрыто условиями (покупка/подписка) */
export function isAudiusDownloadable(t: AuObj): boolean {
  return Boolean(t.is_downloadable && t.access?.download !== false && !t.is_download_gated);
}

const playable = (t: AuObj) =>
  t && t.is_streamable !== false && !t.is_stream_gated && !t.is_delete && t.is_available !== false && !t.user?.is_deactivated;

function mapTrack(t: AuObj): Track {
  return {
    id: `au:${t.id}`,
    source: "audius",
    title: t.title,
    artist: t.user?.name ?? "Audius",
    artistId: t.user?.id ? `au:${t.user.id}` : null,
    album: null,
    albumId: null,
    cover: t.artwork?.["1000x1000"] ?? t.artwork?.["480x480"] ?? null,
    duration: t.duration ?? 0,
    full: true,
    downloadable: isAudiusDownloadable(t),
    genre: t.genre ?? null,
    bpm: t.bpm ? Math.round(t.bpm) : null,
    mood: t.mood ?? null,
    releaseDate: t.release_date ?? t.created_at ?? null,
  };
}

function mapArtist(u: AuObj): Artist {
  return {
    id: `au:${u.id}`,
    source: "audius",
    name: u.name,
    picture: u.profile_picture?.["1000x1000"] ?? u.profile_picture?.["480x480"] ?? null,
    fans: u.follower_count,
  };
}

function mapAlbum(p: AuObj): Album {
  return {
    id: `au:${p.id}`,
    source: "audius",
    title: p.playlist_name,
    artist: p.user?.name ?? "",
    artistId: p.user?.id ? `au:${p.user.id}` : null,
    cover: p.artwork?.["1000x1000"] ?? p.artwork?.["480x480"] ?? null,
    releaseDate: p.release_date ?? null,
    trackCount: p.track_count,
    type: p.is_album ? "album" : "playlist",
  };
}

const tracksOf = (list: AuObj[] | null | undefined) => (list ?? []).filter(playable).map(mapTrack);

export const audius = {
  async searchTracks(q: string, limit = 20) {
    return tracksOf(await au(`/tracks/search?query=${encodeURIComponent(q)}&limit=${limit}`, 300));
  },
  async searchArtists(q: string, limit = 15) {
    const list = (await au<AuObj[]>(`/users/search?query=${encodeURIComponent(q)}&limit=${limit}`, 300)) ?? [];
    return list.filter((u) => !u.is_deactivated && u.track_count > 0).map(mapArtist);
  },
  async searchAlbums(q: string, limit = 10) {
    const list = (await au<AuObj[]>(`/playlists/search?query=${encodeURIComponent(q)}&limit=${limit}`, 300)) ?? [];
    return list.filter((p) => p.track_count > 0).map(mapAlbum);
  },
  async trending(genre?: string | null, limit = 30, time: "week" | "month" | "allTime" = "week") {
    const g = genre ? `&genre=${encodeURIComponent(genre)}` : "";
    return tracksOf(await au(`/tracks/trending?time=${time}&limit=${limit}${g}`, 1800));
  },
  /** Сырой трек — нужен для проверки флага downloadable прямо перед скачиванием */
  async rawTrack(id: string): Promise<AuObj> {
    const t = await au(`/tracks/${encodeURIComponent(id)}`, 300);
    if (!t) throw new UpstreamError("Трек Audius не найден", 404);
    return t;
  },
  async track(id: string) {
    return mapTrack(await this.rawTrack(id));
  },
  async artist(id: string) {
    const u = await au(`/users/${encodeURIComponent(id)}`, 3600);
    if (!u) throw new UpstreamError("Артист не найден", 404);
    return mapArtist(u);
  },
  async artistTracks(id: string, sort: "date" | "plays" = "plays", limit = 20, ttlSec = 1800) {
    const q = sort === "date" ? "sort=date" : "sort_method=plays";
    return tracksOf(await au(`/users/${encodeURIComponent(id)}/tracks?${q}&limit=${limit}`, ttlSec));
  },
  async artistRelated(id: string, limit = 10) {
    const list = (await au<AuObj[]>(`/users/${encodeURIComponent(id)}/related?limit=${limit}`, 6 * 3600)) ?? [];
    return list.filter((u) => !u.is_deactivated).map(mapArtist);
  },
  async playlist(id: string) {
    const [meta] = (await au<AuObj[]>(`/playlists/${encodeURIComponent(id)}`, 1800)) ?? [];
    if (!meta) throw new UpstreamError("Альбом не найден", 404);
    const tracks = tracksOf(await au(`/playlists/${encodeURIComponent(id)}/tracks`, 1800));
    return { album: mapAlbum(meta), tracks };
  },
  streamUrl(id: string) {
    return `${AUDIUS_BASE}/tracks/${encodeURIComponent(id)}/stream?app_name=${AUDIUS_APP}`;
  },
  downloadUrl(id: string) {
    return `${AUDIUS_BASE}/tracks/${encodeURIComponent(id)}/download?app_name=${AUDIUS_APP}`;
  },
};
