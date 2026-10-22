import { getJson } from "../http.js";
import type { Track } from "../types.js";
import { externalLinks } from "./links.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
function mapTrack(t: any): Track {
  return {
    id: `it:${t.trackId}`,
    source: "itunes",
    title: t.trackName,
    artist: t.artistName,
    artistId: null,
    album: t.collectionName ?? null,
    albumId: null,
    cover: t.artworkUrl100?.replace("100x100bb", "600x600bb") ?? null,
    duration: Math.round((t.trackTimeMillis ?? 30000) / 1000),
    full: false,
    downloadable: false,
    genre: t.primaryGenreName ?? null,
    explicit: t.trackExplicitness === "explicit",
    links: externalLinks(t.artistName, t.trackName),
  };
}

/** Запасной поиск, если Deezer недоступен */
export const itunes = {
  async searchTracks(q: string, limit = 25) {
    const r = await getJson<{ results: any[] }>(
      `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&entity=song&limit=${limit}`,
      { ttlSec: 600 },
    );
    return r.results.filter((t) => t.previewUrl).map(mapTrack);
  },
  async previewUrl(id: string): Promise<string | null> {
    const r = await getJson<{ results: any[] }>(`https://itunes.apple.com/lookup?id=${id}`, { ttlSec: 3600 });
    return r.results[0]?.previewUrl ?? null;
  },
  async track(id: string) {
    const r = await getJson<{ results: any[] }>(`https://itunes.apple.com/lookup?id=${id}`, { ttlSec: 3600 });
    return r.results[0] ? mapTrack(r.results[0]) : null;
  },
};
