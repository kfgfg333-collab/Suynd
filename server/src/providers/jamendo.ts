import { env } from "../env.js";
import { getJson } from "../http.js";
import type { Track } from "../types.js";

/*
 * Jamendo: независимая музыка под Creative Commons, полные треки.
 * Нужен бесплатный client_id: https://devportal.jamendo.com → «Create app».
 */
const BASE = "https://api.jamendo.com/v3.0";

/* eslint-disable @typescript-eslint/no-explicit-any */
function mapTrack(t: any): Track {
  return {
    id: `jm:${t.id}`,
    source: "jamendo",
    title: t.name,
    artist: t.artist_name,
    artistId: null,
    album: t.album_name || null,
    albumId: null,
    cover: t.album_image || t.image || null,
    duration: Number(t.duration) || 0,
    full: true,
    downloadable: Boolean(t.audiodownload_allowed && t.audiodownload),
    genre: t.musicinfo?.tags?.genres?.[0] ?? null,
  };
}

async function jm(path: string, ttlSec = 600): Promise<any[]> {
  const sep = path.includes("?") ? "&" : "?";
  const r = await getJson<any>(`${BASE}${path}${sep}client_id=${env.jamendoClientId}&format=json&audioformat=mp32&include=musicinfo`, { ttlSec });
  if (r?.headers?.status !== "success") throw new Error(`Jamendo: ${r?.headers?.error_message ?? "ошибка"}`);
  return r.results ?? [];
}

export const jamendo = {
  enabled: () => Boolean(env.jamendoClientId),
  async searchTracks(q: string, limit = 10): Promise<Track[]> {
    if (!this.enabled()) return [];
    return (await jm(`/tracks/?limit=${limit}&search=${encodeURIComponent(q)}&order=relevance`, 300)).filter((t) => t.audio).map(mapTrack);
  },
  async raw(id: string): Promise<any | null> {
    if (!this.enabled()) return null;
    return (await jm(`/tracks/?id=${encodeURIComponent(id)}`, 600))[0] ?? null;
  },
  async track(id: string): Promise<Track | null> {
    const t = await this.raw(id);
    return t ? mapTrack(t) : null;
  },
};
