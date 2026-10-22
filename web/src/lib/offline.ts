/* Офлайн-хранилище: аудио лежит в IndexedDB браузера Telegram. */
import { downloadUrl } from "./api";
import { FULL_UNAVAILABLE, isFullLengthAudio, isFullTrack } from "./fullOnly";
import type { Track } from "./types";

export interface OfflineEntry {
  id: string;
  track: Track;
  blob: Blob;
  size: number;
  savedAt: number;
}

const DB_NAME = "suynd-offline";
const STORE = "tracks";
let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const req = fn(db.transaction(STORE, mode).objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export async function listOffline(): Promise<OfflineEntry[]> {
  try {
    const all = await tx<OfflineEntry[]>("readonly", (s) => s.getAll());
    return all.sort((a, b) => b.savedAt - a.savedAt);
  } catch {
    return [];
  }
}

export async function getOffline(id: string): Promise<OfflineEntry | undefined> {
  try {
    return await tx<OfflineEntry | undefined>("readonly", (s) => s.get(id));
  } catch {
    return undefined;
  }
}

export async function removeOffline(id: string) {
  await tx("readwrite", (s) => s.delete(id));
}

export async function clearOffline() {
  await tx("readwrite", (s) => s.clear());
}

/** Скачать трек с прогрессом и положить в IndexedDB */
/** Реальная длительность скачанного файла (браузер читает заголовки аудио) */
export function blobDuration(blob: Blob): Promise<number> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const a = new Audio();
    const done = (v: number) => {
      URL.revokeObjectURL(url);
      resolve(v);
    };
    a.preload = "metadata";
    a.onloadedmetadata = () => done(a.duration);
    a.onerror = () => done(NaN);
    setTimeout(() => done(NaN), 15000);
    a.src = url;
  });
}

export async function saveOffline(track: Track, onProgress: (p: number) => void, signal?: AbortSignal): Promise<OfflineEntry> {
  if (!isFullTrack(track) || !track.downloadable) throw new Error(`${FULL_UNAVAILABLE} — скачивать нечего`);
  const res = await fetch(downloadUrl(track), { signal });
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.message ?? "Не удалось скачать трек");
  }
  const total = Number(res.headers.get("content-length") ?? 0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress(total ? loaded / total : Math.min(0.95, loaded / (8 * 1024 * 1024)));
  }
  const blob = new Blob(chunks as BlobPart[], { type: res.headers.get("content-type") ?? "audio/mpeg" });
  // Не сохраняем обрезок под видом полной песни: проверяем фактическую длительность файла
  const actual = await blobDuration(blob);
  if (!isFullLengthAudio(track.duration, actual)) {
    throw new Error(
      Number.isFinite(actual)
        ? `Скачанный файл длится ${Math.round(actual)} с вместо ${track.duration} с — это не полный трек, не сохраняю`
        : "Не удалось прочитать длительность файла — не сохраняю",
    );
  }
  const entry: OfflineEntry = { id: track.id, track, blob, size: blob.size, savedAt: Date.now() };
  await tx("readwrite", (s) => s.put(entry));
  navigator.storage?.persist?.().catch(() => {});
  onProgress(1);
  return entry;
}

export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  try {
    const e = await navigator.storage?.estimate?.();
    return e ? { usage: e.usage ?? 0, quota: e.quota ?? 0 } : null;
  } catch {
    return null;
  }
}
