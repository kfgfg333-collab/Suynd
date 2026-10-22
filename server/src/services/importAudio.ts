import { parseBuffer } from "music-metadata";
import { UpstreamError } from "../http.js";
import { TG_DOWNLOAD_LIMIT } from "../telegramFiles.js";

export const IMPORT_LIMIT = TG_DOWNLOAD_LIMIT; // больше 20 МБ Telegram не отдаст боту обратно для плеера
const AUDIO_EXT = /\.(mp3|m4a|aac|ogg|oga|opus|flac|wav)$/i;

export interface AudioCheck {
  duration: number;
  container: string;
  codec: string | null;
  bitrate: number | null;
}

/** Проверка, что это настоящее аудио: парсим контейнер и смотрим длительность */
export async function verifyAudio(buffer: Buffer, mime?: string): Promise<AudioCheck> {
  if (buffer.length < 1024) throw new UpstreamError("Файл слишком маленький — это не аудио", 422);
  let meta;
  try {
    meta = await parseBuffer(buffer, { mimeType: mime, size: buffer.length }, { duration: true, skipCovers: true });
  } catch {
    throw new UpstreamError("Не удалось распознать аудиоформат", 422);
  }
  const duration = meta.format.duration ?? 0;
  if (!meta.format.container || duration < 1) throw new UpstreamError("В файле нет звуковой дорожки", 422);
  return {
    duration: Math.round(duration),
    container: meta.format.container,
    codec: meta.format.codec ?? null,
    bitrate: meta.format.bitrate ? Math.round(meta.format.bitrate / 1000) : null,
  };
}

export function looksLikeAudio(fileName: string, mime: string) {
  return mime.startsWith("audio/") || AUDIO_EXT.test(fileName);
}

/** Скачать аудио по прямой ссылке с ограничением размера */
export async function fetchAudioFromUrl(raw: string, isPrivateHost: (h: string) => boolean) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UpstreamError("Некорректная ссылка", 400);
  }
  if (!["http:", "https:"].includes(url.protocol) || isPrivateHost(url.hostname)) throw new UpstreamError("Недопустимый адрес", 400);

  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(60_000) }).catch(() => null);
  if (!res || !res.ok || !res.body) throw new UpstreamError(`Ссылка не открылась${res ? ` (HTTP ${res.status})` : ""}`, 422);
  const mime = (res.headers.get("content-type") ?? "").split(";")[0].trim();
  const nameFromUrl = decodeURIComponent(url.pathname.split("/").pop() || "track");
  const disposition = res.headers.get("content-disposition")?.match(/filename\*?=(?:UTF-8'')?"?([^";]+)/i)?.[1];
  const fileName = disposition ? decodeURIComponent(disposition) : nameFromUrl;
  if (mime.startsWith("text/html")) {
    await res.body.cancel();
    throw new UpstreamError("По ссылке веб-страница, а не аудиофайл. Нужна прямая ссылка на .mp3/.m4a/.flac…", 422);
  }
  if (!looksLikeAudio(fileName, mime) && mime !== "application/octet-stream") {
    await res.body.cancel();
    throw new UpstreamError(`По ссылке не аудио (${mime || "неизвестный тип"})`, 422);
  }
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > IMPORT_LIMIT) {
    await res.body.cancel();
    throw new UpstreamError("Файл больше 20 МБ — Telegram не даст его проигрывать", 413);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.length;
    if (size > IMPORT_LIMIT) throw new UpstreamError("Файл больше 20 МБ — Telegram не даст его проигрывать", 413);
    chunks.push(Buffer.from(chunk));
  }
  const ext = AUDIO_EXT.test(fileName) ? "" : ".mp3";
  return { buffer: Buffer.concat(chunks), fileName: fileName + ext, mime: mime || "application/octet-stream" };
}
