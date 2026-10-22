import { getJson, mapLimit } from "../http.js";
import type { Track } from "../types.js";

/*
 * Internet Archive: только записи под Creative Commons или в общественном достоянии
 * (поле licenseurl). Полные файлы, скачивание разрешено лицензией.
 */
const LICENSE_FILTER = "(licenseurl:*creativecommons.org* OR licenseurl:*publicdomain*)";
const AUDIO_FORMATS = new Set(["VBR MP3", "128Kbps MP3", "64Kbps MP3", "MP3"]);

/* eslint-disable @typescript-eslint/no-explicit-any */
interface IaFile {
  name: string;
  format?: string;
  length?: string;
  title?: string;
  creator?: string;
  artist?: string;
  album?: string;
  size?: string;
}

export function encodeArchiveId(identifier: string, file: string) {
  return `ia:${Buffer.from(`${identifier}/${file}`).toString("base64url")}`;
}

export function decodeArchiveId(raw: string): { identifier: string; file: string } | null {
  try {
    const decoded = Buffer.from(raw, "base64url").toString();
    const slash = decoded.indexOf("/");
    if (slash <= 0) return null;
    return { identifier: decoded.slice(0, slash), file: decoded.slice(slash + 1) };
  } catch {
    return null;
  }
}

/** "20:36", "3:20.5" или "1236" → секунды */
export function parseLength(length: string | undefined): number {
  if (!length) return 0;
  if (length.includes(":")) return Math.round(length.split(":").reduce((acc, part) => acc * 60 + Number(part), 0));
  const n = Number(length);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function fileTitle(f: IaFile) {
  return f.title || f.name.replace(/\.[a-z0-9]+$/i, "").replace(/[_]+/g, " ").replace(/^\d+[\s.-]+/, "").trim();
}

async function itemTracks(identifier: string, fallbackCreator: string): Promise<Track[]> {
  const meta = await getJson<any>(`https://archive.org/metadata/${encodeURIComponent(identifier)}`, { ttlSec: 24 * 3600 });
  const license = String(meta?.metadata?.licenseurl ?? "");
  if (!/creativecommons\.org|publicdomain/.test(license)) return [];
  const files: IaFile[] = (meta?.files ?? []).filter((f: IaFile) => AUDIO_FORMATS.has(f.format ?? "") && parseLength(f.length) >= 30);
  const album = Array.isArray(meta.metadata.title) ? meta.metadata.title[0] : meta.metadata.title;
  return files.slice(0, 20).map((f) => ({
    id: encodeArchiveId(identifier, f.name),
    source: "archive" as const,
    title: fileTitle(f),
    artist: f.creator || f.artist || fallbackCreator || "Internet Archive",
    artistId: null,
    album: album ?? null,
    albumId: null,
    cover: `https://archive.org/services/img/${encodeURIComponent(identifier)}`,
    duration: parseLength(f.length),
    full: true,
    downloadable: true,
  }));
}

export const archive = {
  async searchTracks(q: string, limit = 12): Promise<Track[]> {
    const query = `(${q.replace(/[():"]/g, " ")}) AND mediatype:audio AND ${LICENSE_FILTER}`;
    const url =
      "https://archive.org/advancedsearch.php?" +
      new URLSearchParams({ q: query, "fl[]": "identifier", rows: "6", output: "json", sort: "downloads desc" }).toString() +
      "&fl[]=creator";
    const r = await getJson<any>(url, { ttlSec: 3600 });
    const docs: { identifier: string; creator?: string | string[] }[] = r?.response?.docs ?? [];
    const lists = await mapLimit(docs, 4, (d) => itemTracks(d.identifier, Array.isArray(d.creator) ? d.creator[0] : d.creator ?? ""));
    const words = q.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
    // Сначала файлы, в названии которых есть слова запроса
    return lists
      .flatMap((l) => l ?? [])
      .map((t) => ({ t, hit: words.filter((w) => `${t.title} ${t.artist}`.toLowerCase().includes(w)).length }))
      .sort((a, b) => b.hit - a.hit)
      .slice(0, limit)
      .map((x) => x.t);
  },
  async track(raw: string): Promise<Track | null> {
    const ref = decodeArchiveId(raw);
    if (!ref) return null;
    const list = await itemTracks(ref.identifier, "");
    return list.find((t) => t.id === `ia:${raw}`) ?? null;
  },
  fileUrl(raw: string): string | null {
    const ref = decodeArchiveId(raw);
    return ref ? `https://archive.org/download/${encodeURIComponent(ref.identifier)}/${ref.file.split("/").map(encodeURIComponent).join("/")}` : null;
  },
};
