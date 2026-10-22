import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import { db, schema } from "../db/index.js";
import { UpstreamError } from "../http.js";
import { deezer, deezerGenreToAudius } from "../providers/deezer.js";
import { importAudioBuffer } from "../bot.js";
import { FULL_SOURCES, isConfirmedFull, isPreviewOnlyId, onlyFull } from "../services/fullOnly.js";
import { fetchAudioFromUrl, IMPORT_LIMIT, looksLikeAudio, verifyAudio } from "../services/importAudio.js";
import { isPrivateHost } from "./media.js";
import { getTracks, isValidTrackId, resolveTrack, SOURCE_BY_PREFIX, splitId, upsertTracks } from "../services/tracks.js";
import type { Track } from "../types.js";

const DAY = 24 * 60 * 60 * 1000;
const FULL_UNAVAILABLE_MSG = "Полная версия недоступна — превью в Suynd не сохраняются";
const HISTORY_DAYS = 3;
const MIN_PLAY_GAP_MS = 60 * 1000;

/** Клиент присылает трек целиком (он уже у него есть) — сохраняем его, иначе ищем по id */
export async function ensureTrack(body: unknown, id?: string): Promise<Track> {
  const t = (body as { track?: Track } | undefined)?.track;
  if (t && isValidTrackId(t.id) && (!id || t.id === id) && typeof t.title === "string" && typeof t.artist === "string") {
    // Сервер уже знает этот трек (из поиска) — его данные надёжнее присланных
    const [known] = getTracks([t.id]);
    if (known) return known;
    // Флаги «полный»/«скачиваемый» и источник сервер определяет сам, по префиксу id, а не верит клиенту
    const source = SOURCE_BY_PREFIX[splitId(t.id)[0]];
    if (source && source !== "library") {
      const full = FULL_SOURCES.has(source);
      // Право скачать ещё раз проверяется у источника при самом скачивании
      const downloadable = full && Boolean(t.downloadable);
      upsertTracks([{ ...t, source, duration: Math.max(0, Math.floor(Number(t.duration) || 0)), full, downloadable }]);
    }
    const [stored] = getTracks([t.id]);
    if (stored) return stored;
  }
  const trackId = id ?? t?.id;
  if (!isValidTrackId(trackId)) throw new UpstreamError("Некорректный трек", 400);
  const track = await resolveTrack(trackId);
  if (!track) throw new UpstreamError("Трек не найден", 404);
  return track;
}

/** То же, но только для подтверждённых полных треков: превью не попадёт в избранное, историю и плейлисты */
async function ensureFullTrack(body: unknown, id?: string): Promise<Track> {
  if (id && isPreviewOnlyId(id)) throw new UpstreamError(FULL_UNAVAILABLE_MSG, 422);
  const track = await ensureTrack(body, id);
  if (!isConfirmedFull(track)) throw new UpstreamError(FULL_UNAVAILABLE_MSG, 422);
  return track;
}

/** Узнать жанр трека Deezer по альбому (для «трендов по моим жанрам») */
async function enrichGenre(track: Track) {
  if (track.source !== "deezer" || track.genre || !track.albumId) return;
  try {
    const genre = await deezer.albumGenre(splitId(track.albumId)[1]);
    const mapped = deezerGenreToAudius(genre);
    if (mapped) db.update(schema.tracks).set({ genre: mapped }).where(eq(schema.tracks.id, track.id)).run();
  } catch {
    /* жанр — не критично */
  }
}

export async function libraryRoutes(app: FastifyInstance) {
  /* ───────── Любимые ───────── */
  app.get("/api/favorites", async () => {
    const rows = db.select().from(schema.favorites).orderBy(desc(schema.favorites.createdAt)).all();
    const likedAt = new Map(rows.map((r) => [r.trackId, r.createdAt]));
    return { items: onlyFull(getTracks(rows.map((r) => r.trackId))).map((t) => ({ ...t, likedAt: likedAt.get(t.id) })) };
  });

  app.get("/api/favorites/ids", async () => ({
    ids: onlyFull(getTracks(db.select({ id: schema.favorites.trackId }).from(schema.favorites).all().map((r) => r.id))).map((t) => t.id),
  }));

  app.put("/api/favorites/:id", async (req) => {
    const track = await ensureFullTrack(req.body, (req.params as { id: string }).id);
    db.insert(schema.favorites).values({ trackId: track.id, createdAt: Date.now() }).onConflictDoNothing().run();
    void enrichGenre(track);
    return { ok: true };
  });

  app.delete("/api/favorites/:id", async (req) => {
    db.delete(schema.favorites).where(eq(schema.favorites.trackId, (req.params as { id: string }).id)).run();
    return { ok: true };
  });

  /* ───────── История ───────── */
  app.post("/api/plays", async (req) => {
    const track = await ensureFullTrack(req.body);
    const now = Date.now();
    const last = db.select().from(schema.plays).orderBy(desc(schema.plays.playedAt)).limit(1).get();
    if (last && last.trackId === track.id && now - last.playedAt < MIN_PLAY_GAP_MS) return { ok: true, skipped: true };
    db.insert(schema.plays).values({ trackId: track.id, playedAt: now }).run();
    void enrichGenre(track);
    return { ok: true };
  });

  app.get("/api/history", async () => {
    const since = Date.now() - HISTORY_DAYS * DAY;
    const rows = db.select().from(schema.plays).where(gte(schema.plays.playedAt, since)).orderBy(desc(schema.plays.playedAt)).all();
    const tracks = new Map(onlyFull(getTracks([...new Set(rows.map((r) => r.trackId))])).map((t) => [t.id, t]));
    return {
      items: rows.filter((r) => tracks.has(r.trackId)).map((r) => ({ playId: r.id, playedAt: r.playedAt, track: tracks.get(r.trackId)! })),
    };
  });

  app.get("/api/history/recent", async () => {
    const rows = db
      .select({ trackId: schema.plays.trackId, last: sql<number>`max(${schema.plays.playedAt})` })
      .from(schema.plays)
      .groupBy(schema.plays.trackId)
      .orderBy(desc(sql`max(${schema.plays.playedAt})`))
      .limit(12)
      .all();
    return { items: onlyFull(getTracks(rows.map((r) => r.trackId))) };
  });

  app.delete("/api/history", async () => {
    db.delete(schema.plays).run();
    return { ok: true };
  });

  /* ───────── Плейлисты ───────── */
  app.get("/api/playlists", async () => {
    const lists = db.select().from(schema.playlists).orderBy(desc(schema.playlists.updatedAt)).all();
    const entries = db.select().from(schema.playlistTracks).orderBy(schema.playlistTracks.position).all();
    const coverIds = new Set<string>();
    const byList = new Map<number, string[]>();
    for (const e of entries) {
      const arr = byList.get(e.playlistId) ?? [];
      arr.push(e.trackId);
      byList.set(e.playlistId, arr);
    }
    const fullIds = new Set(onlyFull(getTracks([...new Set(entries.map((e) => e.trackId))])).map((t) => t.id));
    for (const [id, ids] of byList) byList.set(id, ids.filter((x) => fullIds.has(x)));
    for (const ids of byList.values()) ids.slice(0, 4).forEach((id) => coverIds.add(id));
    const covers = new Map(getTracks([...coverIds]).map((t) => [t.id, t.cover]));
    return {
      items: lists.map((p) => {
        const ids = byList.get(p.id) ?? [];
        return { ...p, count: ids.length, covers: ids.slice(0, 4).map((id) => covers.get(id) ?? null).filter(Boolean) };
      }),
    };
  });

  app.post("/api/playlists", async (req) => {
    const name = String((req.body as { name?: string })?.name ?? "").trim().slice(0, 80) || "Новый плейлист";
    const now = Date.now();
    const row = db.insert(schema.playlists).values({ name, createdAt: now, updatedAt: now }).returning().get();
    return { playlist: row };
  });

  app.get("/api/playlists/:id", async (req) => {
    const id = Number((req.params as { id: string }).id);
    const playlist = db.select().from(schema.playlists).where(eq(schema.playlists.id, id)).get();
    if (!playlist) throw new UpstreamError("Плейлист не найден", 404);
    const ids = db
      .select()
      .from(schema.playlistTracks)
      .where(eq(schema.playlistTracks.playlistId, id))
      .orderBy(schema.playlistTracks.position)
      .all()
      .map((r) => r.trackId);
    return { playlist, tracks: onlyFull(getTracks(ids)) };
  });

  app.patch("/api/playlists/:id", async (req) => {
    const id = Number((req.params as { id: string }).id);
    const name = String((req.body as { name?: string })?.name ?? "").trim().slice(0, 80);
    if (!name) throw new UpstreamError("Пустое название", 400);
    db.update(schema.playlists).set({ name, updatedAt: Date.now() }).where(eq(schema.playlists.id, id)).run();
    return { ok: true };
  });

  app.delete("/api/playlists/:id", async (req) => {
    const id = Number((req.params as { id: string }).id);
    db.delete(schema.playlistTracks).where(eq(schema.playlistTracks.playlistId, id)).run();
    db.delete(schema.playlists).where(eq(schema.playlists.id, id)).run();
    return { ok: true };
  });

  app.post("/api/playlists/:id/tracks", async (req) => {
    const id = Number((req.params as { id: string }).id);
    if (!db.select().from(schema.playlists).where(eq(schema.playlists.id, id)).get()) throw new UpstreamError("Плейлист не найден", 404);
    const track = await ensureFullTrack(req.body);
    const max = db
      .select({ m: sql<number>`coalesce(max(${schema.playlistTracks.position}), -1)` })
      .from(schema.playlistTracks)
      .where(eq(schema.playlistTracks.playlistId, id))
      .get();
    const result = db
      .insert(schema.playlistTracks)
      .values({ playlistId: id, trackId: track.id, position: (max?.m ?? -1) + 1 })
      .onConflictDoNothing()
      .run();
    db.update(schema.playlists).set({ updatedAt: Date.now() }).where(eq(schema.playlists.id, id)).run();
    return { ok: true, added: result.changes > 0 };
  });

  app.delete("/api/playlists/:id/tracks/:trackId", async (req) => {
    const { id, trackId } = req.params as { id: string; trackId: string };
    db.delete(schema.playlistTracks)
      .where(and(eq(schema.playlistTracks.playlistId, Number(id)), eq(schema.playlistTracks.trackId, trackId)))
      .run();
    return { ok: true };
  });

  app.put("/api/playlists/:id/order", async (req) => {
    const id = Number((req.params as { id: string }).id);
    const trackIds = (req.body as { trackIds?: string[] })?.trackIds;
    if (!Array.isArray(trackIds)) throw new UpstreamError("Нужен список trackIds", 400);
    db.transaction((tx) => {
      trackIds.forEach((trackId, position) => {
        tx.update(schema.playlistTracks)
          .set({ position })
          .where(and(eq(schema.playlistTracks.playlistId, id), eq(schema.playlistTracks.trackId, trackId)))
          .run();
      });
      tx.update(schema.playlists).set({ updatedAt: Date.now() }).where(eq(schema.playlists.id, id)).run();
    });
    return { ok: true };
  });

  /* ───────── Мои файлы (загруженные в бота) ───────── */
  app.get("/api/library", async () => {
    const rows = db.select().from(schema.libraryFiles).orderBy(desc(schema.libraryFiles.createdAt)).all();
    return { items: onlyFull(getTracks(rows.map((r) => `lib:${r.id}`))) };
  });

  /* Импорт: файл с телефона (тело запроса = сам файл) */
  app.addContentTypeParser(["application/octet-stream", "audio/*"], { parseAs: "buffer", bodyLimit: IMPORT_LIMIT + 1024 }, (_req, body, done) =>
    done(null, body),
  );

  app.post("/api/library/upload", async (req) => {
    const buffer = req.body as Buffer;
    if (!Buffer.isBuffer(buffer)) throw new UpstreamError("Пришлите файл", 400);
    const fileName = decodeURIComponent(String(req.headers["x-file-name"] ?? "track.mp3")).slice(0, 200);
    const mime = String(req.headers["x-file-type"] ?? req.headers["content-type"] ?? "");
    if (!looksLikeAudio(fileName, mime)) throw new UpstreamError("Это не аудиофайл", 415);
    const check = await verifyAudio(buffer, mime.startsWith("audio/") ? mime : undefined);
    const { track, existed } = await importAudioBuffer(buffer, fileName, mime);
    return { track, existed, check };
  });

  /* Импорт по прямой ссылке на аудиофайл */
  app.post("/api/library/import-url", async (req) => {
    const url = String((req.body as { url?: string })?.url ?? "").trim();
    const file = await fetchAudioFromUrl(url, isPrivateHost);
    const check = await verifyAudio(file.buffer, file.mime.startsWith("audio/") ? file.mime : undefined);
    const { track, existed } = await importAudioBuffer(file.buffer, file.fileName, file.mime);
    return { track, existed, check };
  });

  app.delete("/api/library/:id", async (req) => {
    const trackId = (req.params as { id: string }).id;
    const [prefix, raw] = splitId(trackId);
    if (prefix !== "lib") throw new UpstreamError("Это не ваш файл", 400);
    const row = db.select().from(schema.libraryFiles).where(eq(schema.libraryFiles.id, Number(raw))).get();
    if (row?.coverPath) fs.rmSync(row.coverPath, { force: true });
    db.delete(schema.libraryFiles).where(eq(schema.libraryFiles.id, Number(raw))).run();
    db.delete(schema.tracks).where(eq(schema.tracks.id, trackId)).run();
    db.delete(schema.favorites).where(eq(schema.favorites.trackId, trackId)).run();
    db.delete(schema.playlistTracks).where(eq(schema.playlistTracks.trackId, trackId)).run();
    db.delete(schema.plays).where(eq(schema.plays.trackId, trackId)).run();
    return { ok: true };
  });

  /* ───────── Сводка для коллекции ───────── */
  app.get("/api/collection/summary", async () => {
    const count = (table: typeof schema.favorites | typeof schema.playlists | typeof schema.libraryFiles | typeof schema.subscriptions) =>
      db.select({ n: sql<number>`count(*)` }).from(table).get()?.n ?? 0;
    const since = Date.now() - HISTORY_DAYS * DAY;
    return {
      favorites: count(schema.favorites),
      playlists: count(schema.playlists),
      library: count(schema.libraryFiles),
      subscriptions: count(schema.subscriptions),
      history: db.select({ n: sql<number>`count(*)` }).from(schema.plays).where(gte(schema.plays.playedAt, since)).get()?.n ?? 0,
      newReleases: db
        .select({ d: schema.releases.releaseDate })
        .from(schema.releases)
        .all()
        .filter((r) => r.d && Date.now() - Date.parse(r.d) < 30 * DAY).length,
    };
  });

}
