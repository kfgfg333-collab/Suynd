import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fs from "node:fs";
import { Readable } from "node:stream";
import { sendTrackToChat } from "../bot.js";
import { db, schema } from "../db/index.js";
import { UpstreamError } from "../http.js";
import { audius, isAudiusDownloadable } from "../providers/audius.js";
import { archive } from "../providers/archive.js";
import { jamendo } from "../providers/jamendo.js";
import { openverseUrl } from "../providers/openverse.js";
import { ytdlp } from "../providers/ytdlp.js";
import { cachedPath, cacheStats, fillCache, isCacheable, serveCached } from "../services/audioCache.js";
import { findFullVersion } from "../services/fullVersion.js";
import { isConfirmedFull, isPreviewOnlyId } from "../services/fullOnly.js";
import type { Track } from "../types.js";
import { getTracks, resolveTrack, splitId } from "../services/tracks.js";
import { TG_DOWNLOAD_LIMIT, telegramFileUrl } from "../telegramFiles.js";

function libraryRow(rawId: string) {
  const row = db.select().from(schema.libraryFiles).where(eq(schema.libraryFiles.id, Number(rawId))).get();
  if (!row) throw new UpstreamError("Файл не найден", 404);
  return row;
}

/** Проксируем аудио с поддержкой Range (перемотка в <audio>) */
async function proxyAudio(req: FastifyRequest, reply: FastifyReply, url: string, extraHeaders: Record<string, string> = {}) {
  const headers: Record<string, string> = {};
  if (req.headers.range) headers.range = req.headers.range;
  const upstream = await fetch(url, { headers, redirect: "follow", signal: AbortSignal.timeout(120_000) });
  if (!upstream.ok && upstream.status !== 206) throw new UpstreamError(`Источник вернул ${upstream.status}`, 502);
  reply.code(upstream.status);
  for (const h of ["content-type", "content-length", "content-range", "accept-ranges"]) {
    const v = upstream.headers.get(h);
    if (v) reply.header(h, v);
  }
  if (!upstream.headers.get("accept-ranges")) reply.header("accept-ranges", "bytes");
  for (const [k, v] of Object.entries(extraHeaders)) reply.header(k, v);
  reply.header("cache-control", "private, max-age=3600");
  return reply.send(Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream));
}

/** Не даём ходить через /api/img во внутреннюю сеть сервера */
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || h === "::1") return true;
  const m = h.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

function safeFileName(s: string) {
  return s.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || "track";
}

/** Прямая ссылка на полный файл, только если источник разрешает скачивание */
async function downloadableUrl(prefix: string, raw: string): Promise<string> {
  if (prefix === "au") {
    if (!isAudiusDownloadable(await audius.rawTrack(raw))) throw new UpstreamError("Автор не разрешил скачивание этого трека", 403);
    // mp3-поток: компактный и точно играет в браузере
    return audius.streamUrl(raw);
  }
  if (prefix === "jm") {
    const t = await jamendo.raw(raw);
    if (!t?.audiodownload_allowed || !t.audiodownload) throw new UpstreamError("Автор не разрешил скачивание этого трека", 403);
    return t.audiodownload;
  }
  if (prefix === "ia") {
    // Только CC / public domain — лицензия разрешает копирование
    const track = await archive.track(raw);
    const url = archive.fileUrl(raw);
    if (!track || !url) throw new UpstreamError("Файл не найден в Internet Archive", 404);
    return url;
  }
  if (prefix === "ov") {
    // CC-лицензия Openverse разрешает копирование; ссылка проверяется по белому списку хостов
    const url = openverseUrl(raw);
    if (!url) throw new UpstreamError("Файл не найден", 404);
    return url;
  }
  if (prefix === "yt") {
    const url = await ytdlp.streamUrl(raw).catch(() => null);
    if (!url) throw new UpstreamError("yt-dlp не смог получить аудио. Проверьте установку yt-dlp и доступность видео.", 502);
    return url;
  }
  throw new UpstreamError("Скачивание недоступно для этого трека", 403);
}

export const FULL_UNAVAILABLE = "Полная версия недоступна";

export const fullStreamUrlOf = (t: Track) => {
  const [p, r] = splitId(t.id);
  return streamSourceUrl(p, r);
};

/** Ссылка, по которой сервер берёт аудио для плеера (клиент всегда ходит через наш сервер) */
export async function streamSourceUrl(prefix: string, raw: string): Promise<string | null> {
  // Deezer и iTunes отдают только 30-секундные фрагменты — их не воспроизводим вообще
  if (prefix === "au") return audius.streamUrl(raw);
  if (prefix === "jm") return (await jamendo.raw(raw))?.audio ?? null;
  if (prefix === "ia") return archive.fileUrl(raw);
  if (prefix === "ov") return openverseUrl(raw);
  if (prefix === "yt") return ytdlp.streamUrl(raw).catch(() => null);
  return null;
}

export async function mediaRoutes(app: FastifyInstance) {
  /*
   * Всё аудио идёт через сервер: если у пользователя заблокирован домен источника
   * (CDN Deezer, узлы Audius, archive.org), сервер за рубежом всё равно его получит.
   */
  app.get("/api/stream/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const [prefix, raw] = splitId(id);
    if (isPreviewOnlyId(id)) throw new UpstreamError(FULL_UNAVAILABLE, 410);
    // Уже в кэше — играем с диска сервера
    const cached = cachedPath(id);
    if (cached) return serveCached(req, reply, cached);

    let url: string | null;
    let mime: string | undefined;
    if (prefix === "lib") {
      const row = libraryRow(raw);
      if ((row.size ?? 0) > TG_DOWNLOAD_LIMIT) throw new UpstreamError("Файл больше 20 МБ — Telegram не позволяет его проигрывать", 413);
      url = await telegramFileUrl(row.fileId);
      mime = row.mime ?? undefined;
    } else {
      url = await streamSourceUrl(prefix, raw);
    }
    if (!url) throw new UpstreamError("Аудио недоступно", 404);
    // Параллельно кладём полный файл в кэш (только для источников, где копирование разрешено)
    if (isCacheable(id)) {
      const [track] = getTracks([id]);
      if (track && isConfirmedFull(track)) void fillCache(id, url, track.duration, mime);
    }
    return proxyAudio(req, reply, url, mime ? { "content-type": mime } : {});
  });

  app.get("/api/cache", async () => cacheStats());

  /** Скачивание для офлайна — мои файлы и источники, где скачивание разрешено */
  app.get("/api/download/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const [prefix, raw] = splitId(id);
    const [track] = getTracks([id]);
    const name = safeFileName(track ? `${track.artist} - ${track.title}` : id);
    const cached = cachedPath(id);
    if (cached && track && isConfirmedFull(track) && (prefix === "lib" || track.downloadable)) {
      return serveCached(req, reply, cached, { "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name + ".mp3")}` });
    }
    if (prefix === "lib") {
      const row = libraryRow(raw);
      if ((row.size ?? 0) > TG_DOWNLOAD_LIMIT) throw new UpstreamError("Файл больше 20 МБ — Telegram не отдаёт такие файлы ботам", 413);
      const ext = row.fileName?.match(/\.[a-z0-9]+$/i)?.[0] ?? ".mp3";
      return proxyAudio(req, reply, await telegramFileUrl(row.fileId), {
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name + ext)}`,
        ...(row.mime ? { "content-type": row.mime } : {}),
      });
    }
    // Скачиваем только подтверждённые полные треки — фрагмент под видом песни не сохраняем
    const full = await resolveTrack(id).catch(() => null);
    if (!full || !isConfirmedFull(full)) throw new UpstreamError(`${FULL_UNAVAILABLE} — скачивать нечего`, 403);
    const url = await downloadableUrl(prefix, raw);
    return proxyAudio(req, reply, url, { "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name + ".mp3")}` });
  });

  /** Бот присылает файл в чат */
  app.post("/api/send/:id", async (req) => {
    const id = (req.params as { id: string }).id;
    const [prefix, raw] = splitId(id);
    const track = await resolveTrack(id);
    if (!track) throw new UpstreamError("Трек не найден", 404);
    if (prefix === "lib") {
      const row = libraryRow(raw);
      await sendTrackToChat({ fileId: row.fileId, filename: row.fileName ?? "track.mp3", title: track.title, performer: track.artist });
      return { ok: true };
    }
    if (!isConfirmedFull(track)) throw new UpstreamError(`${FULL_UNAVAILABLE} — отправлять нечего`, 403);
    const url = await downloadableUrl(prefix, raw);
    const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
    if (!res.ok || !res.body) throw new UpstreamError("Источник не отдал файл", 502);
    const size = Number(res.headers.get("content-length") ?? 0);
    if (size > 50 * 1024 * 1024) {
      await res.body.cancel();
      throw new UpstreamError("Файл больше 50 МБ — Telegram не позволит боту его отправить", 413);
    }
    await sendTrackToChat({
      stream: Readable.fromWeb(res.body as import("node:stream/web").ReadableStream),
      filename: `${safeFileName(`${track.artist} - ${track.title}`)}.mp3`,
      title: track.title,
      performer: track.artist,
      duration: track.duration,
      cover: track.cover,
    });
    return { ok: true };
  });

  /** Поиск полной версии трека (для превью Deezer/iTunes) в легальных полных источниках */
  app.get("/api/tracks/:id/full", async (req) => {
    const track = await resolveTrack((req.params as { id: string }).id);
    if (!track) throw new UpstreamError("Трек не найден", 404);
    if (isConfirmedFull(track)) return { track, checked: [] };
    return findFullVersion(track, { streamUrlOf: fullStreamUrlOf });
  });

  /** Обложки через сервер — на случай, если CDN источника заблокирован у пользователя */
  app.get("/api/img", async (req, reply) => {
    const u = String((req.query as { u?: string }).u ?? "");
    let url: URL;
    try {
      url = new URL(u);
    } catch {
      throw new UpstreamError("Некорректная ссылка", 400);
    }
    if (url.protocol !== "https:" || isPrivateHost(url.hostname)) throw new UpstreamError("Недопустимый адрес", 400);
    const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(10_000) });
    const type = res.headers.get("content-type") ?? "";
    if (!res.ok || !type.startsWith("image/")) throw new UpstreamError("Картинка недоступна", 404);
    const size = Number(res.headers.get("content-length") ?? 0);
    if (size > 8 * 1024 * 1024) throw new UpstreamError("Слишком большая картинка", 413);
    reply.header("content-type", type).header("cache-control", "private, max-age=604800");
    return reply.send(Buffer.from(await res.arrayBuffer()));
  });

  app.get("/api/cover/lib/:id", async (req, reply) => {
    const row = libraryRow((req.params as { id: string }).id);
    if (!row.coverPath || !fs.existsSync(row.coverPath)) throw new UpstreamError("Нет обложки", 404);
    reply.header("content-type", row.coverPath.endsWith(".png") ? "image/png" : "image/jpeg");
    reply.header("cache-control", "private, max-age=604800");
    return reply.send(fs.createReadStream(row.coverPath));
  });
}
