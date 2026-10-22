import type { FastifyInstance } from "fastify";
import { audius } from "../providers/audius.js";
import { deezer } from "../providers/deezer.js";
import { archive } from "../providers/archive.js";
import { itunes } from "../providers/itunes.js";
import { jamendo } from "../providers/jamendo.js";
import { resolveTrack, splitId, upsertTracks } from "../services/tracks.js";
import { UpstreamError } from "../http.js";
import type { Track } from "../types.js";

/** Чередуем результаты двух источников, чтобы в выдаче были оба */
function interleave<T>(a: T[], b: T[], bEvery = 3): T[] {
  const out: T[] = [];
  let j = 0;
  a.forEach((item, i) => {
    out.push(item);
    if ((i + 1) % bEvery === 0 && j < b.length) out.push(b[j++]);
  });
  return out.concat(b.slice(j));
}

const settled = <T>(p: Promise<T>, fallback: T) => p.catch(() => fallback);
const withTimeout = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))]);

export async function catalogRoutes(app: FastifyInstance) {
  app.get("/api/search", async (req) => {
    const { q = "", type = "tracks" } = req.query as { q?: string; type?: string };
    const query = q.trim().slice(0, 100);
    if (!query) return { items: [] };

    if (type === "artists") {
      const [dz, au] = await Promise.all([settled(deezer.searchArtists(query), []), settled(audius.searchArtists(query, 8), [])]);
      return { items: interleave(dz, au, 4) };
    }
    if (type === "albums") {
      const [dz, au] = await Promise.all([settled(deezer.searchAlbums(query), []), settled(audius.searchAlbums(query, 6), [])]);
      return { items: interleave(dz, au, 4) };
    }

    let dz: Track[] = [];
    let dzFailed = false;
    try {
      dz = await deezer.searchTracks(query);
    } catch {
      dzFailed = true;
    }
    // Полные треки: Audius, Jamendo (если задан ключ) и Internet Archive (CC / public domain)
    const [au, jm, ia, it] = await Promise.all([
      settled(audius.searchTracks(query, 15), []),
      settled(jamendo.searchTracks(query, 8), []),
      settled(withTimeout(archive.searchTracks(query, 6), 6000), []),
      dzFailed ? settled(itunes.searchTracks(query), []) : Promise.resolve([]),
    ]);
    const full = interleave(au, interleave(jm, ia, 2), 3);
    const items = interleave(dzFailed ? it : dz, full, 3);
    upsertTracks(items);
    return { items, fallback: dzFailed };
  });

  app.get("/api/home", async () => {
    const [chart, chartAlbums, trending] = await Promise.all([
      settled(deezer.chartTracks(20), []),
      settled(deezer.chartAlbums(12), []),
      settled(audius.trending(null, 20), []),
    ]);
    upsertTracks([...chart, ...trending]);
    return { chart, chartAlbums, trending };
  });

  app.get("/api/trending", async (req) => {
    const { genre } = req.query as { genre?: string };
    const items = await audius.trending(genre || null, 30);
    upsertTracks(items);
    return { items };
  });

  app.get("/api/artists/:id", async (req) => {
    const [prefix, raw] = splitId((req.params as { id: string }).id);
    if (prefix === "dz") {
      const [artist, top, albums, related] = await Promise.all([
        deezer.artist(raw),
        settled(deezer.artistTop(raw, 20), []),
        settled(deezer.artistAlbums(raw, 50), []),
        settled(deezer.artistRelated(raw, 12), []),
      ]);
      upsertTracks(top);
      return { artist, top, albums, related };
    }
    if (prefix === "au") {
      const [artist, top, latest, related] = await Promise.all([
        audius.artist(raw),
        settled(audius.artistTracks(raw, "plays", 20), []),
        settled(audius.artistTracks(raw, "date", 10), []),
        settled(audius.artistRelated(raw, 12), []),
      ]);
      upsertTracks([...top, ...latest]);
      return { artist, top, latest, albums: [], related };
    }
    throw new UpstreamError("Неизвестный артист", 404);
  });

  app.get("/api/albums/:id", async (req) => {
    const [prefix, raw] = splitId((req.params as { id: string }).id);
    const result = prefix === "dz" ? await deezer.album(raw) : prefix === "au" ? await audius.playlist(raw) : null;
    if (!result) throw new UpstreamError("Неизвестный альбом", 404);
    upsertTracks(result.tracks);
    return { album: result.album, tracks: result.tracks };
  });

  /** «Похожее» для трека: топ похожих артистов */
  app.get("/api/tracks/:id/similar", async (req) => {
    const id = (req.params as { id: string }).id;
    const track = await resolveTrack(id);
    if (!track?.artistId) return { items: [] };
    const [prefix, raw] = splitId(track.artistId);
    let items: Track[] = [];
    if (prefix === "dz") {
      const related = await settled(deezer.artistRelated(raw, 8), []);
      const tops = await Promise.all(related.map((a) => settled(deezer.artistTop(splitId(a.id)[1], 3), [])));
      items = tops.flat();
    } else if (prefix === "au") {
      const related = await settled(audius.artistRelated(raw, 8), []);
      const tops = await Promise.all(related.map((a) => settled(audius.artistTracks(splitId(a.id)[1], "plays", 3), [])));
      items = tops.flat();
      if (items.length < 5 && track.genre) items = items.concat(await settled(audius.trending(track.genre, 15), []));
    }
    items = items.filter((t) => t.id !== id).sort(() => Math.random() - 0.5).slice(0, 25);
    upsertTracks(items);
    return { items };
  });
}
