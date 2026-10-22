import { sqliteTable, text, integer, primaryKey } from "drizzle-orm/sqlite-core";

export const tracks = sqliteTable("tracks", {
  id: text("id").primaryKey(),
  source: text("source", { enum: ["deezer", "audius", "library", "archive", "jamendo", "openverse"] }).notNull(),
  title: text("title").notNull(),
  artist: text("artist").notNull(),
  artistId: text("artist_id"),
  album: text("album"),
  albumId: text("album_id"),
  cover: text("cover"),
  duration: integer("duration").notNull().default(0),
  genre: text("genre"),
  bpm: integer("bpm"),
  full: integer("full", { mode: "boolean" }).notNull().default(false),
  downloadable: integer("downloadable", { mode: "boolean" }).notNull().default(false),
  extra: text("extra"),
  updatedAt: integer("updated_at").notNull(),
});

export const libraryFiles = sqliteTable("library_files", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  fileId: text("file_id").notNull(),
  fileUniqueId: text("file_unique_id").notNull().unique(),
  fileName: text("file_name"),
  mime: text("mime"),
  size: integer("size"),
  coverPath: text("cover_path"),
  createdAt: integer("created_at").notNull(),
});

export const favorites = sqliteTable("favorites", {
  trackId: text("track_id").primaryKey(),
  createdAt: integer("created_at").notNull(),
});

export const plays = sqliteTable("plays", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  trackId: text("track_id").notNull(),
  playedAt: integer("played_at").notNull(),
});

export const playlists = sqliteTable("playlists", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const playlistTracks = sqliteTable(
  "playlist_tracks",
  {
    playlistId: integer("playlist_id").notNull(),
    trackId: text("track_id").notNull(),
    position: integer("position").notNull(),
  },
  (t) => [primaryKey({ columns: [t.playlistId, t.trackId] })],
);

export const feedback = sqliteTable("feedback", {
  trackId: text("track_id").primaryKey(),
  artistKey: text("artist_key"),
  value: integer("value").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const blockedArtists = sqliteTable("blocked_artists", {
  artistKey: text("artist_key").primaryKey(),
  name: text("name").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const waveSeen = sqliteTable("wave_seen", {
  trackId: text("track_id").primaryKey(),
  seenAt: integer("seen_at").notNull(),
});

export const subscriptions = sqliteTable("subscriptions", {
  artistKey: text("artist_key").primaryKey(),
  source: text("source", { enum: ["deezer", "audius"] }).notNull(),
  name: text("name").notNull(),
  picture: text("picture"),
  createdAt: integer("created_at").notNull(),
  lastCheckedAt: integer("last_checked_at"),
});

export const releases = sqliteTable("releases", {
  id: text("id").primaryKey(),
  artistKey: text("artist_key").notNull(),
  artistName: text("artist_name").notNull(),
  title: text("title").notNull(),
  cover: text("cover"),
  releaseDate: text("release_date"),
  kind: text("kind").notNull(),
  trackId: text("track_id"),
  albumId: text("album_id"),
  link: text("link"),
  createdAt: integer("created_at").notNull(),
  notified: integer("notified", { mode: "boolean" }).notNull().default(false),
});
