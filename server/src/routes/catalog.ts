import type { FastifyInstance } from "fastify";
import { audius } from "../providers/audius.js";
import { deezer } from "../providers/deezer.js";
import { archive } from "../providers/archive.js";
import { jamendo } from "../providers/jamendo.js";
import { openverse } from "../providers/openverse.js";
import { ytdlp, YtDlpError } from "../providers/ytdlp.js";
import { resolveTrack, splitId, upsertTracks } from "../services/tracks.js";
import { mapLimit, UpstreamError } from "../http.js";
import { isCensoredTitle, onlyFull } from "../services/fullOnly.js";
import { findFullVersion, normalize, scoreCandidate } from "../services/fullVersion.js";
import { queryVariants } from "../services/translit.js";
import { fullStreamUrlOf } from "./media.js";
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

/** Один и тот же трек из разных источников — оставляем лучшую полную версию */
const SOURCE_RANK: Record<string, number> = { library: 0, audius: 1, jamendo: 2, openverse: 3, archive: 4, ytdlp: 5 };
// Видео часто длиннее записи на несколько секунд (заставка, тишина в конце)
const sameLength = (a: number, b: number) => Math.abs(a - b) <= Math.max(8, Math.min(a, b) * 0.05);
export function dedupeFull(list: Track[]): Track[] {
  const best: Track[] = [];
  for (const t of onlyFull(list)) {
    const key = `${normalize(t.artist)}|${normalize(t.title)}`;
    const i = best.findIndex((b) => `${normalize(b.artist)}|${normalize(b.title)}` === key && sameLength(b.duration, t.duration));
    const prev = i >= 0 ? best[i] : null;
    const better =
      !prev ||
      (isCensoredTitle(prev.title) && !isCensoredTitle(t.title)) ||
      (isCensoredTitle(prev.title) === isCensoredTitle(t.title) && (SOURCE_RANK[t.source] ?? 9) < (SOURCE_RANK[prev.source] ?? 9));
    if (!prev) best.push(t);
    else if (better) best[i] = t;
  }
  const keep = new Set(best.map((t) => t.id));
  return list.filter((t) => keep.has(t.id));
}

/**
 * Если для ролика YouTube есть та же запись в источнике с полным файлом и явными правами
 * (Audius, Jamendo, Internet Archive, Openverse, ваши файлы) — оставляем её, а ролик убираем.
 * Совпадение строгое: название, артист, длительность и одинаковые пометки версии (ремикс, утечка, live…).
 */
export function preferLicensed(list: Track[]): Track[] {
  const licensed = list.filter((t) => t.source !== "ytdlp");
  return list.filter((t) => t.source !== "ytdlp" || !licensed.some((o) => scoreCandidate(t, o) > 0));
}

/** Тот же артист на Audius (по точному имени) — у него есть полные треки */
async function audiusTwin(name: string) {
  const list = await settled(audius.searchArtists(name, 5), []);
  return list.find((a) => normalize(a.name) === normalize(name)) ?? null;
}

const RESOLVE_IN_SEARCH = 3;

function youtubeWarning(e: unknown): string {
  if (e instanceof YtDlpError) {
    if (e.reason === "not_installed") return "YouTube не подключён: на сервере не установлен yt-dlp. Остальные источники работают";
    if (e.reason === "disabled") return "";
    return `YouTube: ${e.message}`;
  }
  return "YouTube не ответил вовремя — показаны результаты других источников";
}

/** Каталог Deezer с вариантами транслитерации: «Милано Скам» находит «Scally Milano — Скам» */
async function searchCatalog(query: string): Promise<Track[]> {
  const variants = queryVariants(query);
  const lists = await Promise.all(variants.map((v) => settled(deezer.searchTracks(v, 15), [])));
  const seen = new Set<string>();
  // Сначала результаты исходного запроса, потом вариантов
  return lists.flat().filter((t) => !seen.has(t.id) && seen.add(t.id)).slice(0, 20);
}

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

    // Полные треки: Audius, Jamendo (если задан ключ) и Internet Archive (CC / public domain).
    // Deezer — только каталог: у него лишь превью, поэтому по его совпадениям ищем полные версии в других источниках.
    const warnings: string[] = [];
    const [dz, au, jm, ia, ov, yt] = await Promise.all([
      searchCatalog(query),
      settled(audius.searchTracks(query, 15), []),
      settled(jamendo.searchTracks(query, 8), []),
      settled(withTimeout(archive.searchTracks(query, 6), 6000), []),
      settled(withTimeout(openverse.searchTracks(query, 8), 8000), []),
      // YouTube необязателен: без yt-dlp или при его ошибке остальные источники работают, а клиент видит причину
      withTimeout(ytdlp.searchTracks(query, 10), 22000).catch((e) => {
        const w = youtubeWarning(e);
        if (w) warnings.push(w);
        return [] as Track[];
      }),
    ]);
    let full = interleave(interleave(au, interleave(interleave(jm, ov, 2), ia, 2), 3), yt, 4);

    const covered = (c: Track) => full.some((f) => scoreCandidate(c, f) > 0);
    const toResolve = dz.filter((c) => !covered(c)).slice(0, RESOLVE_IN_SEARCH);
    const resolved = await Promise.all(
      toResolve.map((c) => settled(withTimeout(findFullVersion(c, { streamUrlOf: fullStreamUrlOf }), 9000), { track: null, checked: [] })),
    );
    const found = resolved.map((r) => r.track).filter((t): t is Track => Boolean(t));
    full = preferLicensed(dedupeFull([...found, ...full]));
    upsertTracks(full);

    const unavailable = dz.filter((c) => !full.some((f) => scoreCandidate(c, f) > 0));
    return {
      items: full,
      ...(warnings.length ? { warnings } : {}),
      // Совпадения из каталога, для которых полной версии нет: только текст, без воспроизведения
      unavailable: unavailable.slice(0, 8).map((c) => ({ id: c.id, title: c.title, artist: c.artist, explicit: c.explicit ?? false })),
    };
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
