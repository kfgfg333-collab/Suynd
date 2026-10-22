import type { FastifyInstance } from "fastify";
import { mapLimit, UpstreamError } from "../http.js";
import { audius } from "../providers/audius.js";
import { deezer } from "../providers/deezer.js";
import { onlyFull } from "../services/fullOnly.js";
import { normalize } from "../services/match.js";
import { sanitizeQuery, search } from "../services/search.js";
import { resolveTrack, splitId, upsertTracks } from "../services/tracks.js";
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

/** Тот же артист на Audius (по точному имени) — у него есть полные треки */
async function audiusTwin(name: string) {
  const list = await settled(audius.searchArtists(name, 5), []);
  return list.find((a) => normalize(a.name) === normalize(name)) ?? null;
}

export async function catalogRoutes(app: FastifyInstance) {
  app.get("/api/search", async (req) => {
    const { q = "", type = "tracks" } = req.query as { q?: string; type?: string };
    const query = sanitizeQuery(q);
    if (!query) return type === "tracks" ? await search.findBest("") : { items: [] };

    if (type === "artists") {
      const [dz, au] = await Promise.all([settled(deezer.searchArtists(query), []), settled(audius.searchArtists(query, 8), [])]);
      return { items: interleave(dz, au, 4) };
    }
    if (type === "albums") {
      const [dz, au] = await Promise.all([settled(deezer.searchAlbums(query), []), settled(audius.searchAlbums(query, 6), [])]);
      return { items: interleave(dz, au, 4) };
    }

    // Треки: один лучший проверенный результат из разрешённых источников (см. services/search.ts)
    return search.findBest(query);
  });

  app.get("/api/home", async () => {
    const [chartAlbums, trending] = await Promise.all([settled(deezer.chartAlbums(12), []), settled(audius.trending(null, 30), [])]);
    const full = onlyFull(trending);
    upsertTracks(full);
    return { chartAlbums, trending: full };
  });

  app.get("/api/trending", async (req) => {
    const { genre } = req.query as { genre?: string };
    const items = onlyFull(await audius.trending(genre || null, 30));
    upsertTracks(items);
    return { items };
  });

  app.get("/api/artists/:id", async (req) => {
    const [prefix, raw] = splitId((req.params as { id: string }).id);
    if (prefix === "dz") {
      const [artist, catalog, albums, related] = await Promise.all([
        deezer.artist(raw),
        settled(deezer.artistTop(raw, 20), []),
        settled(deezer.artistAlbums(raw, 50), []),
        settled(deezer.artistRelated(raw, 12), []),
      ]);
      // Полные треки этого артиста — если он сам публикуется на Audius
      const twin = await audiusTwin(artist.name);
      const top = twin ? onlyFull(await settled(audius.artistTracks(splitId(twin.id)[1], "plays", 20), [])) : [];
      upsertTracks([...catalog, ...top]);
      return { artist, top, catalog, albums, related, audiusTwin: twin };
    }
    if (prefix === "au") {
      const [artist, top, latest, related] = await Promise.all([
        audius.artist(raw),
        settled(audius.artistTracks(raw, "plays", 20), []),
        settled(audius.artistTracks(raw, "date", 10), []),
        settled(audius.artistRelated(raw, 12), []),
      ]);
      const [fullTop, fullLatest] = [onlyFull(top), onlyFull(latest)];
      upsertTracks([...fullTop, ...fullLatest]);
      return { artist, top: fullTop, latest: fullLatest, catalog: [], albums: [], related };
    }
    throw new UpstreamError("Неизвестный артист", 404);
  });

  app.get("/api/albums/:id", async (req) => {
    const [prefix, raw] = splitId((req.params as { id: string }).id);
    if (prefix === "dz") {
      const result = await deezer.album(raw);
      upsertTracks(result.tracks);
      // Треки альбома Deezer — каталог: полную версию ищем по нажатию
      return { album: result.album, tracks: [], catalog: result.tracks };
    }
    if (prefix === "au") {
      const result = await audius.playlist(raw);
      const tracks = onlyFull(result.tracks);
      upsertTracks(tracks);
      return { album: result.album, tracks, catalog: [] };
    }
    throw new UpstreamError("Неизвестный альбом", 404);
  });

  /** «Похожее»: полные треки похожих артистов */
  app.get("/api/tracks/:id/similar", async (req) => {
    const id = (req.params as { id: string }).id;
    const track = await resolveTrack(id);
    if (!track) return { items: [] };
    let items: Track[] = [];
    const [prefix, raw] = splitId(track.artistId ?? "");
    if (prefix === "au") {
      const related = await settled(audius.artistRelated(raw, 8), []);
      const tops = await Promise.all(related.map((a) => settled(audius.artistTracks(splitId(a.id)[1], "plays", 3), [])));
      items = tops.flat();
    } else if (prefix === "dz") {
      // Похожие артисты Deezer → их «двойники» на Audius с полными треками
      const related = await settled(deezer.artistRelated(raw, 8), []);
      const twins = await mapLimit(related, 3, (a) => audiusTwin(a.name));
      const tops = await Promise.all(twins.filter(Boolean).map((a) => settled(audius.artistTracks(splitId(a!.id)[1], "plays", 3), [])));
      items = tops.flat();
    }
    if (items.length < 5 && track.genre) items = items.concat(await settled(audius.trending(track.genre, 15), []));
    items = onlyFull(items)
      .filter((t) => t.id !== id)
      .sort(() => Math.random() - 0.5)
      .slice(0, 25);
    upsertTracks(items);
    return { items };
  });
}
