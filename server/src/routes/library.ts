import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import { db, schema } from "../db/index.js";
import { UpstreamError } from "../http.js";
import { deezer, deezerGenreToAudius } from "../providers/deezer.js";
import { getTracks, isValidTrackId, resolveTrack, splitId, upsertTracks } from "../services/tracks.js";
import type { Track } from "../types.js";

const DAY = 24 * 60 * 60 * 1000;
export const HISTORY_DAYS = 3;
const MIN_PLAY_GAP_MS = 60 * 1000;

/** Клиент присылает трек целиком (он уже у него есть) — сохраняем его, иначе ищем по id */
export async function ensureTrack(body: unknown, id?: string): Promise<Track> {
  const t = (body as { track?: Track } | undefined)?.track;
  if (t && isValidTrackId(t.id) && (!id || t.id === id) && typeof t.title === "string" && typeof t.artist === "string") {
    if (!t.id.startsWith("lib:")) upsertTracks([{ ...t, full: t.source === "audius", downloadable: t.source === "audius" && t.downloadable }]);
    const [stored] = getTracks([t.id]);
    if (stored) return stored;
  }
  const trackId = id ?? t?.id;
  if (!isValidTrackId(trackId)) throw new UpstreamError("Некорректный трек", 400);
  const track = await resolveTrack(trackId);
  if (!track) throw new UpstreamError("Трек не найден", 404);
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
    return { items: getTracks(rows.map((r) => r.trackId)).map((t) => ({ ...t, likedAt: likedAt.get(t.id) })) };
  });

  app.get("/api/favorites/ids", async () => ({
    ids: db.select({ id: schema.favorites.trackId }).from(schema.favorites).all().map((r) => r.id),
  }));

  app.put("/api/favorites/:id", async (req) => {
    const track = await ensureTrack(req.body, (req.params as { id: string }).id);
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
    const track = await ensureTrack(req.body);
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
    const tracks = new Map(getTracks([...new Set(rows.map((r) => r.trackId))]).map((t) => [t.id, t]));
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
    return { items: getTracks(rows.map((r) => r.trackId)) };
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
    return { playlist, tracks: getTracks(ids) };
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
    const track = await ensureTrack(req.body);
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
    return { items: getTracks(rows.map((r) => `lib:${r.id}`)) };
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

  /** Пачка статусов для экрана трека */
  app.post("/api/tracks/state", async (req) => {
    const ids = ((req.body as { ids?: string[] })?.ids ?? []).filter(isValidTrackId).slice(0, 200);
    if (!ids.length) return { liked: [] };
    const liked = db.select().from(schema.favorites).where(inArray(schema.favorites.trackId, ids)).all();
    return { liked: liked.map((r) => r.trackId) };
  });
}
