import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { env } from "../env.js";
import * as schema from "./schema.js";

fs.mkdirSync(env.dataDir, { recursive: true });
export const coversDir = path.join(env.dataDir, "covers");
fs.mkdirSync(coversDir, { recursive: true });

const sqlite = new Database(path.join(env.dataDir, "suynd.db"));
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

// Таблицы создаются при старте — никаких отдельных миграций запускать не нужно.
sqlite.exec(`
CREATE TABLE IF NOT EXISTS tracks (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  artist TEXT NOT NULL,
  artist_id TEXT,
  album TEXT,
  album_id TEXT,
  cover TEXT,
  duration INTEGER NOT NULL DEFAULT 0,
  genre TEXT,
  bpm INTEGER,
  full INTEGER NOT NULL DEFAULT 0,
  downloadable INTEGER NOT NULL DEFAULT 0,
  extra TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS library_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id TEXT NOT NULL,
  file_unique_id TEXT NOT NULL UNIQUE,
  file_name TEXT,
  mime TEXT,
  size INTEGER,
  cover_path TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS favorites (
  track_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS plays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id TEXT NOT NULL,
  played_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS plays_played_at ON plays(played_at);
CREATE TABLE IF NOT EXISTS playlists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS playlist_tracks (
  playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  track_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (playlist_id, track_id)
);
CREATE TABLE IF NOT EXISTS feedback (
  track_id TEXT PRIMARY KEY,
  artist_key TEXT,
  value INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS blocked_artists (
  artist_key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS wave_seen (
  track_id TEXT PRIMARY KEY,
  seen_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS subscriptions (
  artist_key TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  name TEXT NOT NULL,
  picture TEXT,
  created_at INTEGER NOT NULL,
  last_checked_at INTEGER
);
CREATE TABLE IF NOT EXISTS releases (
  id TEXT PRIMARY KEY,
  artist_key TEXT NOT NULL,
  artist_name TEXT NOT NULL,
  title TEXT NOT NULL,
  cover TEXT,
  release_date TEXT,
  kind TEXT NOT NULL,
  track_id TEXT,
  album_id TEXT,
  link TEXT,
  created_at INTEGER NOT NULL,
  notified INTEGER NOT NULL DEFAULT 0
);
`);

export const db = drizzle(sqlite, { schema });
export { schema };
