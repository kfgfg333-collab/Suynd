import { inArray } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { audius } from "../providers/audius.js";
import { deezer } from "../providers/deezer.js";
import { archive } from "../providers/archive.js";
import { itunes } from "../providers/itunes.js";
import { jamendo } from "../providers/jamendo.js";
import { externalLinks } from "../providers/links.js";
import { ytdlp } from "../providers/ytdlp.js";
import type { Source, Track } from "../types.js";

type TrackRow = typeof schema.tracks.$inferSelect;

export function rowToTrack(r: TrackRow): Track {
  const extra = r.extra ? (JSON.parse(r.extra) as Partial<Track>) : {};
  const track: Track = {
    id: r.id,
    source: r.source as Source,
    title: r.title,
    artist: r.artist,
    artistId: r.artistId,
    album: r.album,
    albumId: r.albumId,
    cover: r.cover,
    duration: r.duration,
    full: r.full,
    downloadable: r.downloadable,
    genre: r.genre,
    bpm: r.bpm,
    mood: extra.mood ?? null,
    explicit: extra.explicit,
  };
  if (r.source === "deezer" || r.source === "itunes") track.links = externalLinks(r.artist, r.title);
  return track;
}

/** Сохранить/обновить метаданные трека (чтобы лайки, история и плейлисты работали без повторных запросов) */
export function upsertTracks(list: Track[]) {
  if (!list.length) return;
  const now = Date.now();
  db.transaction((tx) => {
    for (const t of list) {
      const values = {
        id: t.id,
        source: t.source,
        title: t.title,
        artist: t.artist,
        artistId: t.artistId,
        album: t.album,
        albumId: t.albumId,
        cover: t.cover,
        duration: t.duration,
        genre: t.genre ?? null,
        bpm: t.bpm ?? null,
        full: t.full,
        downloadable: t.downloadable,
        extra: JSON.stringify({ mood: t.mood ?? null, explicit: t.explicit ?? false }),
        updatedAt: now,
      };
      const { id, ...update } = values;
      // Не затираем известный жанр пустым
      if (!update.genre) delete (update as Partial<typeof update>).genre;
      tx.insert(schema.tracks).values(values).onConflictDoUpdate({ target: schema.tracks.id, set: update }).run();
    }
  });
}

/** Достать треки по id в заданном порядке */
export function getTracks(ids: string[]): Track[] {
  if (!ids.length) return [];
  const rows = new Map<string, Track>();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    for (const r of db.select().from(schema.tracks).where(inArray(schema.tracks.id, chunk)).all()) {
      rows.set(r.id, rowToTrack(r));
    }
  }
  return ids.map((id) => rows.get(id)).filter((t): t is Track => Boolean(t));
}

/** Найти трек: сначала в базе, потом у провайдера */
export async function resolveTrack(id: string): Promise<Track | null> {
  const [cached] = getTracks([id]);
  if (cached) return cached;
  const [prefix, raw] = splitId(id);
  let track: Track | null = null;
  if (prefix === "dz") track = (await deezer.track(raw)).track;
  else if (prefix === "au") track = await audius.track(raw);
  else if (prefix === "it") track = await itunes.track(raw);
  else if (prefix === "ia") track = await archive.track(raw);
  else if (prefix === "jm") track = await jamendo.track(raw);
  else if (prefix === "yt") track = await ytdlp.track(raw);
  if (track) upsertTracks([track]);
  return track;
}

export function splitId(id: string): [string, string] {
  const i = id.indexOf(":");
  return i === -1 ? ["", id] : [id.slice(0, i), id.slice(i + 1)];
}

/** Префикс id однозначно задаёт источник: разные источники не могут дать одинаковый id */
export const SOURCE_BY_PREFIX: Record<string, Source> = {
  dz: "deezer",
  au: "audius",
  lib: "library",
  it: "itunes",
  ia: "archive",
  jm: "jamendo",
  ov: "openverse",
  yt: "ytdlp",
};

export function isValidTrackId(id: unknown): id is string {
  // ia:/ov: — base64url от «идентификатор/файл» или ссылки на файл, поэтому длиннее; yt: — ровно 11 символов id видео YouTube
  return (
    typeof id === "string" &&
    (/^(dz|au|lib|it|jm):[A-Za-z0-9_-]{1,64}$/.test(id) || /^(ia|ov):[A-Za-z0-9_-]{4,400}$/.test(id) || /^yt:[A-Za-z0-9_-]{11}$/.test(id))
  );
}
