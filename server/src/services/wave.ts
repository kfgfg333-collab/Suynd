import { desc, gte, sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { audius, moodEnergy } from "../providers/audius.js";
import { deezer } from "../providers/deezer.js";
import type { Track } from "../types.js";
import { isConfirmedFull } from "./fullOnly.js";
import { normalize } from "./fullVersion.js";
import { getTracks, splitId, upsertTracks } from "./tracks.js";

export type WaveMode = "familiar" | "mix" | "new";
export type WaveEnergy = "any" | "calm" | "energetic";

const DAY = 24 * 60 * 60 * 1000;
const NO_REPEAT_MS = 3 * DAY;
const BATCH = 10;
const MAX_PER_ARTIST = 2;
const FALLBACK_GENRES = ["Electronic", "Hip-Hop/Rap", "Pop", "Alternative"];

const safe = <T>(p: Promise<T>, fallback: T) => p.catch(() => fallback);
const sample = <T>(arr: T[], n: number) => [...arr].sort(() => Math.random() - 0.5).slice(0, n);

/** Выбор по весам без повторов */
function weightedPick<T>(items: { item: T; weight: number }[], n: number): T[] {
  const pool = items.filter((i) => i.weight > 0);
  const out: T[] = [];
  while (out.length < n && pool.length) {
    const total = pool.reduce((s, i) => s + i.weight, 0);
    let r = Math.random() * total;
    const idx = pool.findIndex((i) => (r -= i.weight) <= 0);
    out.push(pool.splice(idx === -1 ? 0 : idx, 1)[0].item);
  }
  return out;
}

interface Profile {
  artistWeights: Map<string, { weight: number; name: string }>;
  genres: string[];
  favorites: Track[];
  excludedTracks: Set<string>;
  blocked: Set<string>;
  artistScore: Map<string, number>; // сумма 👍/👎 по артисту
}

function buildProfile(): Profile {
  const since = Date.now() - NO_REPEAT_MS;
  const favIds = db.select().from(schema.favorites).orderBy(desc(schema.favorites.createdAt)).limit(300).all().map((r) => r.trackId);
  const favorites = getTracks(favIds);
  const recentPlays = db.select().from(schema.plays).where(gte(schema.plays.playedAt, since)).all();
  const allHistory = getTracks([...new Set(db.select().from(schema.plays).orderBy(desc(schema.plays.playedAt)).limit(300).all().map((r) => r.trackId))]);
  const feedbackRows = db.select().from(schema.feedback).all();
  const blocked = new Set(db.select().from(schema.blockedArtists).all().map((r) => r.artistKey));
  const subs = db.select().from(schema.subscriptions).all();
  const seen = db.select().from(schema.waveSeen).where(gte(schema.waveSeen.seenAt, since)).all();

  const artistScore = new Map<string, number>();
  for (const f of feedbackRows) if (f.artistKey) artistScore.set(f.artistKey, (artistScore.get(f.artistKey) ?? 0) + f.value);

  const weights = new Map<string, { weight: number; name: string }>();
  const add = (key: string | null, name: string, w: number) => {
    if (!key || blocked.has(key)) return;
    const cur = weights.get(key) ?? { weight: 0, name };
    cur.weight += w;
    weights.set(key, cur);
  };
  favorites.forEach((t) => add(t.artistId, t.artist, 3));
  subs.forEach((s) => add(s.artistKey, s.name, 2));
  allHistory.forEach((t) => add(t.artistId, t.artist, 1));
  const likedFeedback = getTracks(feedbackRows.filter((f) => f.value > 0).map((f) => f.trackId));
  likedFeedback.forEach((t) => add(t.artistId, t.artist, 2));
  for (const [key, score] of artistScore) {
    const cur = weights.get(key);
    if (cur && score < 0) cur.weight = Math.max(0, cur.weight + score * 2);
  }

  const genreCount = new Map<string, number>();
  for (const t of [...favorites, ...allHistory, ...likedFeedback]) {
    if (t.genre) genreCount.set(t.genre, (genreCount.get(t.genre) ?? 0) + 1);
  }
  const genres = [...genreCount.entries()].sort((a, b) => b[1] - a[1]).map(([g]) => g).slice(0, 5);

  const excludedTracks = new Set<string>([
    ...recentPlays.map((r) => r.trackId),
    ...seen.map((r) => r.trackId),
    ...feedbackRows.filter((f) => f.value < 0).map((f) => f.trackId),
  ]);

  return { artistWeights: weights, genres, favorites, excludedTracks, blocked, artistScore };
}

const twinCache = new Map<string, string | null>();

/** Артист Deezer → тот же артист на Audius (по точному имени), где есть полные треки */
async function audiusTwinOf(artistKey: string, name?: string): Promise<string | null> {
  if (twinCache.has(artistKey)) return twinCache.get(artistKey)!;
  const artistName = name ?? (await safe(deezer.artist(splitId(artistKey)[1]), null))?.name;
  if (!artistName) return null;
  const list = await safe(audius.searchArtists(artistName, 5), []);
  const twin = list.find((a) => normalize(a.name) === normalize(artistName))?.id ?? null;
  twinCache.set(artistKey, twin);
  return twin;
}

/** Полные треки артиста. У Deezer только превью, поэтому для его артистов берём «двойника» на Audius */
async function topTracksOf(artistKey: string, limit: number, name?: string): Promise<Track[]> {
  const [prefix, raw] = splitId(artistKey);
  if (prefix === "au") return safe(audius.artistTracks(raw, "plays", limit), []);
  if (prefix === "dz") {
    const twin = await audiusTwinOf(artistKey, name);
    return twin ? safe(audius.artistTracks(splitId(twin)[1], "plays", limit), []) : [];
  }
  return [];
}

async function relatedOf(artistKey: string): Promise<{ id: string; name: string }[]> {
  const [prefix, raw] = splitId(artistKey);
  if (prefix === "dz") return safe(deezer.artistRelated(raw, 15), []);
  if (prefix === "au") return safe(audius.artistRelated(raw, 10), []);
  return [];
}

async function familiarCandidates(p: Profile): Promise<Track[]> {
  const seeds = weightedPick([...p.artistWeights.entries()].map(([key, v]) => ({ item: key, weight: v.weight })), 6);
  const tops = await Promise.all(seeds.map((key) => topTracksOf(key, 15, p.artistWeights.get(key)?.name)));
  const favs = sample(p.favorites, 8);
  return [...tops.flat(), ...favs];
}

async function newCandidates(p: Profile): Promise<Track[]> {
  const known = new Set(p.artistWeights.keys());
  const seeds = weightedPick([...p.artistWeights.entries()].map(([key, v]) => ({ item: key, weight: v.weight })), 4);
  const relatedLists = await Promise.all(seeds.map(relatedOf));
  const fresh = sample(
    relatedLists.flat().filter((a) => !known.has(a.id) && !p.blocked.has(a.id) && (p.artistScore.get(a.id) ?? 0) >= 0),
    6,
  );
  const genres = p.genres.length ? p.genres : FALLBACK_GENRES;
  const [tops, trending] = await Promise.all([
    Promise.all(fresh.map((a) => topTracksOf(a.id, 6, a.name))),
    Promise.all(sample(genres, 2).map((g) => safe(audius.trending(g, 25), []))),
  ]);
  return [...tops.flat(), ...trending.flat()];
}

async function coldStart(): Promise<Track[]> {
  const lists = await Promise.all([safe(audius.trending(null, 40), []), ...sample(FALLBACK_GENRES, 2).map((g) => safe(audius.trending(g, 20), []))]);
  return lists.flat();
}

/** Подходит ли трек под «Спокойное/Энергичное» */
function energyScore(t: Track, energy: WaveEnergy): number {
  if (energy === "any") return 1;
  const fromMood = moodEnergy(t.mood);
  if (fromMood) return fromMood === energy ? 1.5 : 0.15;
  if (t.bpm) {
    const energetic = t.bpm >= 115;
    return (energy === "energetic") === energetic ? 1.3 : 0.3;
  }
  return 0.7; // неизвестно — оставляем, но реже
}

export async function nextWaveBatch(opts: { mode: WaveMode; energy: WaveEnergy; exclude: string[] }): Promise<Track[]> {
  const p = buildProfile();
  opts.exclude.forEach((id) => p.excludedTracks.add(id));
  const hasProfile = p.artistWeights.size > 0;

  let familiar: Track[] = [];
  let fresh: Track[] = [];
  if (!hasProfile) {
    fresh = await coldStart();
  } else if (opts.mode === "familiar") {
    familiar = await familiarCandidates(p);
  } else if (opts.mode === "new") {
    fresh = await newCandidates(p);
  } else {
    [familiar, fresh] = await Promise.all([familiarCandidates(p), newCandidates(p)]);
  }

  const usable = (t: Track) =>
    isConfirmedFull(t) &&
    !p.excludedTracks.has(t.id) && !(t.artistId && p.blocked.has(t.artistId)) && (t.artistId ? (p.artistScore.get(t.artistId) ?? 0) > -3 : true);

  const score = (t: Track) => {
    const artistBoost = t.artistId ? 1 + Math.max(-0.5, (p.artistScore.get(t.artistId) ?? 0) * 0.2) : 1;
    return energyScore(t, opts.energy) * artistBoost * (0.5 + Math.random());
  };

  const dedupe = (list: Track[]) => [...new Map(list.filter(usable).map((t) => [t.id, t])).values()];
  const ranked = (list: Track[]) => dedupe(list).map((t) => ({ t, s: score(t) })).sort((a, b) => b.s - a.s).map((x) => x.t);

  // В «Миксе» — поровну знакомого и нового, по очереди
  const a = ranked(familiar);
  const b = ranked(fresh);
  const merged: Track[] = [];
  while (a.length || b.length) {
    if (a.length) merged.push(a.shift()!);
    if (b.length) merged.push(b.shift()!);
  }

  const perArtist = new Map<string, number>();
  const batch: Track[] = [];
  for (const t of merged) {
    const key = t.artistId ?? t.artist;
    if ((perArtist.get(key) ?? 0) >= MAX_PER_ARTIST) continue;
    perArtist.set(key, (perArtist.get(key) ?? 0) + 1);
    batch.push(t);
    if (batch.length >= BATCH) break;
  }

  // Если фильтры оказались слишком строгими — добиваем похожими, потом чартом/трендами
  if (batch.length < BATCH && hasProfile && opts.mode === "familiar") {
    for (const t of ranked(await newCandidates(p))) {
      if (batch.length >= BATCH) break;
      const key = t.artistId ?? t.artist;
      if (batch.some((x) => x.id === t.id) || (perArtist.get(key) ?? 0) >= MAX_PER_ARTIST) continue;
      perArtist.set(key, (perArtist.get(key) ?? 0) + 1);
      batch.push(t);
    }
  }
  if (batch.length < BATCH) {
    for (const t of ranked(await coldStart())) {
      if (batch.length >= BATCH) break;
      if (!batch.some((x) => x.id === t.id)) batch.push(t);
    }
  }

  upsertTracks(batch);
  const now = Date.now();
  db.transaction((tx) => {
    for (const t of batch) {
      tx.insert(schema.waveSeen).values({ trackId: t.id, seenAt: now }).onConflictDoUpdate({ target: schema.waveSeen.trackId, set: { seenAt: now } }).run();
    }
  });
  return batch;
}

export function pruneOld() {
  const cutoff = Date.now() - NO_REPEAT_MS;
  const plays = db.run(sql`DELETE FROM plays WHERE played_at < ${cutoff}`);
  const seen = db.run(sql`DELETE FROM wave_seen WHERE seen_at < ${cutoff}`);
  return { plays: plays.changes, seen: seen.changes };
}
