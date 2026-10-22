import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fs from "node:fs";
import { Readable } from "node:stream";
import { sendTrackToChat } from "../bot.js";
import { db, schema } from "../db/index.js";
import { UpstreamError } from "../http.js";
import { audius, isAudiusDownloadable } from "../providers/audius.js";
import { deezer } from "../providers/deezer.js";
import { itunes } from "../providers/itunes.js";
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

function safeFileName(s: string) {
  return s.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || "track";
}

export async function mediaRoutes(app: FastifyInstance) {
  app.get("/api/stream/:id", async (req, reply) => {
    const [prefix, raw] = splitId((req.params as { id: string }).id);
    if (prefix === "dz") {
      const url = await deezer.previewUrl(raw);
      if (!url) throw new UpstreamError("Превью недоступно", 404);
      return reply.redirect(url, 302);
    }
    if (prefix === "it") {
      const url = await itunes.previewUrl(raw);
      if (!url) throw new UpstreamError("Превью недоступно", 404);
      return reply.redirect(url, 302);
    }
    if (prefix === "au") return reply.redirect(audius.streamUrl(raw), 302);
    if (prefix === "lib") {
      const row = libraryRow(raw);
      if ((row.size ?? 0) > TG_DOWNLOAD_LIMIT) throw new UpstreamError("Файл больше 20 МБ — Telegram не позволяет его проигрывать", 413);
      return proxyAudio(req, reply, await telegramFileUrl(row.fileId), row.mime ? { "content-type": row.mime } : {});
    }
    throw new UpstreamError("Неизвестный трек", 404);
  });

  /** Скачивание для офлайна — только мои файлы и Audius с разрешением автора */
  app.get("/api/download/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const [prefix, raw] = splitId(id);
    const [track] = getTracks([id]);
    const name = safeFileName(track ? `${track.artist} - ${track.title}` : id);
    if (prefix === "lib") {
      const row = libraryRow(raw);
      if ((row.size ?? 0) > TG_DOWNLOAD_LIMIT) throw new UpstreamError("Файл больше 20 МБ — Telegram не отдаёт такие файлы ботам", 413);
      const ext = row.fileName?.match(/\.[a-z0-9]+$/i)?.[0] ?? ".mp3";
      return proxyAudio(req, reply, await telegramFileUrl(row.fileId), {
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name + ext)}`,
        ...(row.mime ? { "content-type": row.mime } : {}),
      });
    }
    if (prefix === "au") {
      const t = await audius.rawTrack(raw);
      if (!isAudiusDownloadable(t)) throw new UpstreamError("Автор не разрешил скачивание этого трека", 403);
      // Для офлайна берём mp3-поток: он компактный и точно играет в браузере
      return proxyAudio(req, reply, audius.streamUrl(raw), {
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name + ".mp3")}`,
      });
    }
    throw new UpstreamError("Скачивание недоступно для этого трека", 403);
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
    if (prefix === "au") {
      const t = await audius.rawTrack(raw);
      if (!isAudiusDownloadable(t)) throw new UpstreamError("Автор не разрешил скачивание этого трека", 403);
      const res = await fetch(audius.streamUrl(raw), { signal: AbortSignal.timeout(120_000) });
      if (!res.ok || !res.body) throw new UpstreamError("Audius не отдал файл", 502);
      const size = Number(res.headers.get("content-length") ?? 0);
      if (size > 50 * 1024 * 1024) throw new UpstreamError("Файл больше 50 МБ — Telegram не позволит боту его отправить", 413);
      await sendTrackToChat({
        stream: Readable.fromWeb(res.body as import("node:stream/web").ReadableStream),
        filename: `${safeFileName(`${track.artist} - ${track.title}`)}.mp3`,
        title: track.title,
        performer: track.artist,
        duration: track.duration,
        cover: track.cover,
      });
      return { ok: true };
    }
    throw new UpstreamError("Отправка недоступна для этого трека", 403);
  });

  app.get("/api/cover/lib/:id", async (req, reply) => {
    const row = libraryRow((req.params as { id: string }).id);
    if (!row.coverPath || !fs.existsSync(row.coverPath)) throw new UpstreamError("Нет обложки", 404);
    reply.header("content-type", row.coverPath.endsWith(".png") ? "image/png" : "image/jpeg");
    reply.header("cache-control", "private, max-age=604800");
    return reply.send(fs.createReadStream(row.coverPath));
  });
}
