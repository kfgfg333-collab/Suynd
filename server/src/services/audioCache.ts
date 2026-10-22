import type { FastifyReply, FastifyRequest } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { parseFile } from "music-metadata";
import { env } from "../env.js";
import { isFullLengthAudio } from "./fullOnly.js";

/*
 * Кэш полных аудиофайлов на диске сервера (LRU по времени доступа).
 * Кэшируем только источники, чьи лицензии разрешают копирование (CC / public domain) и ваши файлы.
 * В кэш попадает только файл, чья реальная длительность подтверждена — обрезки не сохраняются.
 */
const CACHE_DIR = path.join(env.dataDir, "audio-cache");
const MAX_BYTES = env.audioCacheMb * 1024 * 1024;
const MAX_FILE_BYTES = 80 * 1024 * 1024;
const CACHEABLE = new Set(["ia", "ov", "jm", "lib"]);

fs.mkdirSync(CACHE_DIR, { recursive: true });
const inflight = new Map<string, Promise<boolean>>();

const fileFor = (id: string) => path.join(CACHE_DIR, Buffer.from(id).toString("base64url").slice(0, 200) + ".audio");

export const isCacheable = (id: string) => MAX_BYTES > 0 && CACHEABLE.has(id.split(":")[0]);

export function cachedPath(id: string): string | null {
  const file = fileFor(id);
  if (!fs.existsSync(file)) return null;
  const now = new Date();
  fs.utimesSync(file, now, now); // отметка для LRU
  return file;
}

function evict() {
  const files = fs
    .readdirSync(CACHE_DIR)
    .filter((f) => f.endsWith(".audio"))
    .map((f) => {
      const p = path.join(CACHE_DIR, f);
      const st = fs.statSync(p);
      return { p, size: st.size, at: st.mtimeMs };
    })
    .sort((a, b) => a.at - b.at);
  let total = files.reduce((s, f) => s + f.size, 0);
  for (const f of files) {
    if (total <= MAX_BYTES) break;
    fs.rmSync(f.p, { force: true });
    total -= f.size;
  }
}

/** Скачать файл целиком в кэш (в фоне). true — файл сохранён и подтверждён как полный */
export function fillCache(id: string, url: string, expectedSec: number, mime = "audio/mpeg"): Promise<boolean> {
  if (!isCacheable(id) || cachedPath(id)) return Promise.resolve(Boolean(cachedPath(id)));
  const running = inflight.get(id);
  if (running) return running;
  const job = (async () => {
    const tmp = `${fileFor(id)}.${process.pid}.tmp`;
    try {
      const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(180_000) });
      if (!res.ok || !res.body) return false;
      if (Number(res.headers.get("content-length") ?? 0) > MAX_FILE_BYTES) return false;
      const out = fs.createWriteStream(tmp);
      let size = 0;
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        size += chunk.length;
        if (size > MAX_FILE_BYTES) throw new Error("too big");
        if (!out.write(chunk)) await new Promise<void>((r) => out.once("drain", () => r()));
      }
      await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
      const meta = await parseFile(tmp, { duration: true, skipCovers: true });
      if (!isFullLengthAudio(expectedSec, meta.format.duration ?? 0)) return false;
      fs.writeFileSync(`${fileFor(id)}.type`, res.headers.get("content-type")?.split(";")[0] || mime);
      fs.renameSync(tmp, fileFor(id));
      evict();
      return true;
    } catch {
      return false;
    } finally {
      fs.rmSync(tmp, { force: true });
      inflight.delete(id);
    }
  })();
  inflight.set(id, job);
  return job;
}

/** Отдать файл из кэша с поддержкой Range (перемотка) */
export function serveCached(req: FastifyRequest, reply: FastifyReply, file: string, extraHeaders: Record<string, string> = {}) {
  const size = fs.statSync(file).size;
  let type = "audio/mpeg";
  try {
    type = fs.readFileSync(`${file}.type`, "utf8") || type;
  } catch {
    /* по умолчанию mp3 */
  }
  reply.header("content-type", type).header("accept-ranges", "bytes").header("cache-control", "private, max-age=86400").header("x-suynd-cache", "hit");
  for (const [k, v] of Object.entries(extraHeaders)) reply.header(k, v);
  const m = req.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
  if (m && (m[1] || m[2])) {
    let start = m[1] ? Number(m[1]) : size - Number(m[2]);
    let end = m[1] && m[2] ? Number(m[2]) : size - 1;
    start = Math.max(0, start);
    end = Math.min(end, size - 1);
    if (start > end) return reply.code(416).header("content-range", `bytes */${size}`).send();
    reply.code(206).header("content-range", `bytes ${start}-${end}/${size}`).header("content-length", String(end - start + 1));
    return reply.send(fs.createReadStream(file, { start, end }));
  }
  reply.header("content-length", String(size));
  return reply.send(fs.createReadStream(file) as Readable);
}

export function cacheStats() {
  const files = fs.readdirSync(CACHE_DIR).filter((f) => f.endsWith(".audio"));
  const bytes = files.reduce((s, f) => s + fs.statSync(path.join(CACHE_DIR, f)).size, 0);
  return { files: files.length, bytes, maxBytes: MAX_BYTES };
}
