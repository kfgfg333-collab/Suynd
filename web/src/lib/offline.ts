/* Офлайн-хранилище: аудио лежит в IndexedDB браузера Telegram. */
import { downloadUrl } from "./api";
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
export async function saveOffline(track: Track, onProgress: (p: number) => void, signal?: AbortSignal): Promise<OfflineEntry> {
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
