import type { Source, Track } from "../types.js";
import { archive } from "./archive.js";
import { audius } from "./audius.js";
import { jamendo } from "./jamendo.js";
import { openverse, openverseUrl } from "./openverse.js";

/*
 * Источники полных треков. У всех один интерфейс: поиск → треки в общем формате, id трека → ссылка на аудио.
 * Каждый — с официальным API и правом на воспроизведение:
 *   Audius        — открытый API, стриминг разрешён условиями API;
 *   Jamendo       — официальный API, музыка под Creative Commons (нужен бесплатный client_id);
 *   Internet Archive — только записи под CC или в общественном достоянии;
 *   Openverse     — открытый индекс CC-аудио (полные файлы Jamendo и Wikimedia Commons).
 * Deezer — только каталог (метаданные, обложки, официальные ссылки): его звук — 30-секундные превью, мы их не играем.
 */
export interface MusicProvider {
  source: Source;
  /** Префикс id трека: au:123 */
  prefix: string;
  label: string;
  enabled(): boolean;
  /** Сколько ждём ответа на один поиск */
  timeoutMs: number;
  /** Необязательный источник: его сбой не делает выдачу «неполной» (только запись в логе) */
  optional?: boolean;
  search(query: string, limit: number): Promise<Track[]>;
  /** Прямая ссылка на аудио для сервера-прокси (клиент её не видит) */
  streamUrl(rawId: string): Promise<string | null>;
}

export const providers: MusicProvider[] = [
  {
    source: "audius",
    prefix: "au",
    label: "Audius",
    enabled: () => true,
    timeoutMs: 8000,
    search: (q, limit) => audius.searchTracks(q, limit),
    streamUrl: async (raw) => audius.streamUrl(raw),
  },
  {
    source: "jamendo",
    prefix: "jm",
    label: "Jamendo",
    enabled: () => jamendo.enabled(),
    timeoutMs: 8000,
    search: (q, limit) => jamendo.searchTracks(q, limit),
    streamUrl: async (raw) => (await jamendo.raw(raw))?.audio ?? null,
  },
  {
    source: "archive",
    prefix: "ia",
    label: "Internet Archive",
    enabled: () => true,
    timeoutMs: 9000,
    search: (q, limit) => archive.searchTracks(q, limit),
    streamUrl: async (raw) => archive.fileUrl(raw),
  },
  {
    source: "openverse",
    prefix: "ov",
    label: "Openverse",
    enabled: () => true,
    // Анонимный API Openverse часто отвечает 10–20 с: ждём недолго и не считаем его сбой неполной выдачей
    timeoutMs: 5000,
    optional: true,
    search: (q, limit) => openverse.searchTracks(q, limit),
    streamUrl: async (raw) => openverseUrl(raw),
  },
];

const byPrefix = new Map(providers.map((p) => [p.prefix, p]));

/** Ссылка на аудио по id трека (кроме ваших файлов — их отдаёт Telegram) */
export async function streamSourceUrl(id: string): Promise<string | null> {
  const i = id.indexOf(":");
  const p = byPrefix.get(id.slice(0, i));
  return p && p.enabled() ? p.streamUrl(id.slice(i + 1)) : null;
}
