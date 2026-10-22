import { getJson, UpstreamError } from "../http.js";
import type { Album, Artist, Track } from "../types.js";
import { externalLinks } from "./links.js";

const BASE = "https://api.deezer.com";

/* eslint-disable @typescript-eslint/no-explicit-any */
type DzObj = any;

async function dz<T = DzObj>(path: string, ttlSec = 600): Promise<T> {
  const data = await getJson<DzObj>(`${BASE}${path}`, { ttlSec });
  if (data?.error) {
    // code 800 = "no data" — это не авария, а пустой ответ
    if (data.error.code === 800) return { data: [] } as T;
    throw new UpstreamError(`Deezer: ${data.error.message ?? "ошибка"}`, data.error.code === 4 ? 429 : 502);
  }
  return data as T;
}

export function mapTrack(t: DzObj, album?: DzObj): Track {
  const alb = t.album ?? album;
  const artist = t.artist?.name ?? "Неизвестный артист";
  return {
    id: `dz:${t.id}`,
    source: "deezer",
    title: t.title_short || t.title,
    artist,
    artistId: t.artist?.id ? `dz:${t.artist.id}` : null,
    album: alb?.title ?? null,
    albumId: alb?.id ? `dz:${alb.id}` : null,
    cover: alb?.cover_xl ?? alb?.cover_big ?? alb?.cover_medium ?? null,
    duration: t.duration ?? 30,
    full: false,
    downloadable: false,
    bpm: t.bpm || null,
    explicit: Boolean(t.explicit_lyrics),
    links: externalLinks(artist, t.title_short || t.title),
  };
}

export function mapArtist(a: DzObj): Artist {
  return {
    id: `dz:${a.id}`,
    source: "deezer",
    name: a.name,
    picture: a.picture_xl ?? a.picture_big ?? a.picture_medium ?? null,
    fans: a.nb_fan,
  };
}

export function mapAlbum(a: DzObj, artist?: DzObj): Album {
  const art = a.artist ?? artist;
  return {
    id: `dz:${a.id}`,
    source: "deezer",
    title: a.title,
    artist: art?.name ?? "",
    artistId: art?.id ? `dz:${art.id}` : null,
    cover: a.cover_xl ?? a.cover_big ?? a.cover_medium ?? null,
    releaseDate: a.release_date ?? null,
    trackCount: a.nb_tracks,
    type: a.record_type,
  };
}

/**
 * Deezer часто отдаёт и цензурную (clean / radio edit), и explicit-версию одного трека.
 * Оставляем одну — explicit, если она есть.
 */
export function preferExplicit(list: Track[]): Track[] {
  const key = (t: Track) =>
    `${t.artist}|${t.title}`
      .toLowerCase()
      .replace(/\((clean|radio edit|edited|censored|explicit)[^)]*\)/g, "")
      .replace(/\s+-\s+(clean|radio edit|edited|censored|explicit).*$/g, "")
      .replace(/\s+/g, " ")
      .trim();
  const chosen = new Map<string, Track>();
  for (const t of list) {
    const k = key(t);
    const prev = chosen.get(k);
    if (!prev || (!prev.explicit && t.explicit)) chosen.set(k, t);
  }
  const keep = new Set([...chosen.values()].map((t) => t.id));
  return list.filter((t) => keep.has(t.id));
}

const readable = (t: DzObj) => t.readable !== false && t.preview;

export const deezer = {
  async searchTracks(q: string, limit = 25) {
    const r = await dz(`/search?q=${encodeURIComponent(q)}&limit=${Math.min(50, limit * 2)}`, 300);
    return preferExplicit((r.data as DzObj[]).filter(readable).map((t) => mapTrack(t))).slice(0, limit);
  },
  async searchArtists(q: string, limit = 20) {
    const r = await dz(`/search/artist?q=${encodeURIComponent(q)}&limit=${limit}`, 300);
    return (r.data as DzObj[]).map(mapArtist);
  },
  async searchAlbums(q: string, limit = 20) {
    const r = await dz(`/search/album?q=${encodeURIComponent(q)}&limit=${limit}`, 300);
    return (r.data as DzObj[]).map((a) => mapAlbum(a));
  },
  async track(id: string) {
    const t = await dz(`/track/${id}`, 1800);
    if (!t?.id) throw new UpstreamError("Трек не найден", 404);
    return { track: mapTrack(t), genreAlbumId: t.album?.id as number | undefined };
  },
  async artist(id: string) {
    return mapArtist(await dz(`/artist/${id}`, 3600));
  },
  async artistTop(id: string, limit = 20) {
    const r = await dz(`/artist/${id}/top?limit=${limit}`, 3600);
    return (r.data as DzObj[]).filter(readable).map((t) => mapTrack(t));
  },
  async artistRelated(id: string, limit = 20) {
    const r = await dz(`/artist/${id}/related?limit=${limit}`, 6 * 3600);
    return (r.data as DzObj[]).map(mapArtist);
  },
  async artistAlbums(id: string, limit = 50, ttlSec = 3600) {
    const r = await dz(`/artist/${id}/albums?limit=${limit}`, ttlSec);
    return (r.data as DzObj[]).map((a) => mapAlbum(a)).sort((a, b) => (b.releaseDate ?? "").localeCompare(a.releaseDate ?? ""));
  },
  async album(id: string) {
    const a = await dz(`/album/${id}`, 3600);
    if (!a?.id) throw new UpstreamError("Альбом не найден", 404);
    const tracks = ((a.tracks?.data ?? []) as DzObj[]).filter(readable).map((t) => mapTrack(t, a));
    const genre = a.genres?.data?.[0]?.name ?? null;
    return { album: mapAlbum(a), tracks: tracks.map((t) => ({ ...t, genre })), genre };
  },
  async albumGenre(id: string): Promise<string | null> {
    const a = await dz(`/album/${id}`, 24 * 3600);
    return a?.genres?.data?.[0]?.name ?? null;
  },
  async chartTracks(limit = 30) {
    const r = await dz(`/chart/0/tracks?limit=${limit}`, 1800);
    return (r.data as DzObj[]).filter(readable).map((t) => mapTrack(t));
  },
  async chartAlbums(limit = 20) {
    const r = await dz(`/chart/0/albums?limit=${limit}`, 1800);
    return (r.data as DzObj[]).map((a) => mapAlbum(a));
  },
  async chartArtists(limit = 20) {
    const r = await dz(`/chart/0/artists?limit=${limit}`, 1800);
    return (r.data as DzObj[]).map(mapArtist);
  },
};

/** Жанры Deezer → названия жанров Audius (для трендов «по моим жанрам») */
export function deezerGenreToAudius(genre: string | null | undefined): string | null {
  if (!genre) return null;
  const g = genre.toLowerCase();
  if (g.includes("rap") || g.includes("hip")) return "Hip-Hop/Rap";
  if (g.includes("electro") || g.includes("techno")) return "Electronic";
  if (g.includes("dance")) return "Dance & EDM";
  if (g.includes("house")) return "House";
  if (g.includes("r&b") || g.includes("soul")) return "R&B/Soul";
  if (g.includes("rock")) return "Rock";
  if (g.includes("metal")) return "Metal";
  if (g.includes("alternative") || g.includes("indie")) return "Alternative";
  if (g.includes("jazz")) return "Jazz";
  if (g.includes("classical")) return "Classical";
  if (g.includes("reggae")) return "Reggae";
  if (g.includes("latin")) return "Latin";
  if (g.includes("country")) return "Country";
  if (g.includes("folk")) return "Folk";
  if (g.includes("ambient") || g.includes("chill")) return "Ambient";
  if (g.includes("pop")) return "Pop";
  return null;
}
