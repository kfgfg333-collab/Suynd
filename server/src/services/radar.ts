import { eq, inArray } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { mapLimit } from "../http.js";
import { audius } from "../providers/audius.js";
import { deezer } from "../providers/deezer.js";
import { splitId, upsertTracks } from "./tracks.js";

const DAY = 24 * 60 * 60 * 1000;
const FRESH_DAYS = 30;

type Sub = typeof schema.subscriptions.$inferSelect;
type ReleaseRow = typeof schema.releases.$inferInsert;

export type Notifier = (r: ReleaseRow) => Promise<void>;

async function fetchReleases(sub: Sub): Promise<ReleaseRow[]> {
  const [prefix, raw] = splitId(sub.artistKey);
  const now = Date.now();
  if (prefix === "dz") {
    const albums = await deezer.artistAlbums(raw, 10, 0);
    return albums.map((a) => ({
      id: `dz-album:${splitId(a.id)[1]}`,
      artistKey: sub.artistKey,
      artistName: sub.name,
      title: a.title,
      cover: a.cover,
      releaseDate: a.releaseDate ?? null,
      kind: a.type === "single" ? "Сингл" : a.type === "ep" ? "EP" : "Альбом",
      albumId: a.id,
      trackId: null,
      link: `https://www.deezer.com/album/${splitId(a.id)[1]}`,
      createdAt: now,
    }));
  }
  if (prefix === "au") {
    const tracks = await audius.artistTracks(raw, "date", 10, 0);
    upsertTracks(tracks);
    return tracks.map((t) => ({
      id: t.id,
      artistKey: sub.artistKey,
      artistName: sub.name,
      title: t.title,
      cover: t.cover,
      releaseDate: t.releaseDate ?? null,
      kind: "Трек",
      albumId: null,
      trackId: t.id,
      link: null,
      createdAt: now,
    }));
  }
  return [];
}

/** Проверить одного артиста. При первой проверке просто запоминаем уже вышедшее (без уведомлений). */
export async function checkSubscription(sub: Sub, notify?: Notifier): Promise<number> {
  const found = await fetchReleases(sub);
  const firstRun = !sub.lastCheckedAt;
  const known = new Set(
    found.length
      ? db.select({ id: schema.releases.id }).from(schema.releases).where(inArray(schema.releases.id, found.map((r) => r.id))).all().map((r) => r.id)
      : [],
  );
  let fresh = 0;
  for (const r of found) {
    if (known.has(r.id)) continue;
    const isRecent = !r.releaseDate || Date.now() - Date.parse(r.releaseDate) < FRESH_DAYS * DAY;
    const shouldNotify = !firstRun && isRecent;
    db.insert(schema.releases).values({ ...r, notified: !shouldNotify }).onConflictDoNothing().run();
    if (shouldNotify && notify) {
      try {
        await notify(r);
        db.update(schema.releases).set({ notified: true }).where(eq(schema.releases.id, r.id)).run();
      } catch (err) {
        console.warn("Не удалось отправить уведомление о релизе:", (err as Error).message);
      }
      fresh++;
    }
  }
  db.update(schema.subscriptions).set({ lastCheckedAt: Date.now() }).where(eq(schema.subscriptions.artistKey, sub.artistKey)).run();
  return fresh;
}

export async function runRadar(notify?: Notifier) {
  const subs = db.select().from(schema.subscriptions).all();
  const results = await mapLimit(subs, 3, (s) => checkSubscription(s, notify));
  return results.reduce<number>((sum, n) => sum + (n ?? 0), 0);
}
