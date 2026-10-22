import { spawn } from "node:child_process";
import type { Track } from "../types.js";

/** Optional yt-dlp integration. Install yt-dlp on the API server; no npm wrapper needed. */
const BIN = process.env.YT_DLP_PATH?.trim() || "yt-dlp";
const TIMEOUT_MS = Math.max(5_000, Math.min(Number(process.env.YT_DLP_TIMEOUT_MS ?? 18_000), 60_000));
const MAX_OUTPUT = 8 * 1024 * 1024;

type Video = {
  id?: string;
  title?: string;
  fulltitle?: string;
  uploader?: string;
  channel?: string;
  duration?: number;
  webpage_url?: string;
  original_url?: string;
  thumbnail?: string;
  live_status?: string;
  is_live?: boolean;
  availability?: string;
  extractor_key?: string;
  _type?: string;
};

function run(args: string[], timeout = TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(BIN, ["--ignore-config", "--no-warnings", "--no-playlist", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("yt-dlp timed out"));
    }, timeout);
    const finish = (error?: Error | null, output?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(output ?? stdout);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > MAX_OUTPUT) {
        child.kill("SIGKILL");
        finish(new Error("yt-dlp output too large"));
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-4000);
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (code === 0) finish(null, stdout.trim());
      else finish(new Error(stderr.trim() || `yt-dlp exited with code ${code}`));
    });
  });
}

function validVideo(v: Video): boolean {
  return Boolean(
    v.id && /^[\w-]{11}$/.test(v.id) &&
    (v.extractor_key === undefined || /youtube/i.test(v.extractor_key)) &&
    (v.duration ?? 0) >= 45 && !v.is_live && v.live_status !== "is_live" &&
    v.availability !== "private" && v.availability !== "needs_auth" &&
    v._type !== "playlist" && (v.webpage_url ?? "https://www.youtube.com/watch?v=" + v.id).startsWith("https://www.youtube.com/"),
  );
}

function mapVideo(v: Video): Track | null {
  if (!validVideo(v)) return null;
  const id = v.id!;
  return {
    id: `yt:${id}`,
    source: "ytdlp",
    title: (v.title ?? v.fulltitle ?? "Untitled").trim().slice(0, 200),
    artist: (v.uploader ?? v.channel ?? "YouTube").trim().slice(0, 120),
    artistId: null,
    album: null,
    albumId: null,
    cover: v.thumbnail && /^https:\/\//.test(v.thumbnail) ? v.thumbnail : `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    duration: Math.floor(v.duration!),
    full: true,
    // yt-dlp is only enabled for public, directly accessible YouTube videos. Download permission remains subject to the source's rights and terms.
    downloadable: true,
  };
}

export const ytdlp = {
  async searchTracks(query: string, limit = 10): Promise<Track[]> {
    if (!query.trim()) return [];
    const n = Math.max(1, Math.min(Math.floor(limit), 15));
    const raw = await run(["--flat-playlist", "--dump-single-json", `ytsearch${n}:${query.trim().slice(0, 120)}`]);
    const parsed = JSON.parse(raw) as { entries?: Video[] };
    return (parsed.entries ?? []).map(mapVideo).filter((t): t is Track => Boolean(t));
  },

  /** Resolve a fresh direct audio URL on each request; YouTube URLs expire. */
  async streamUrl(id: string): Promise<string | null> {
    if (!/^[\w-]{11}$/.test(id)) return null;
    const raw = await run(["--format", "bestaudio/best", "--get-url", `https://www.youtube.com/watch?v=${id}`], 25_000);
    const url = raw.split(/\r?\n/).find((line) => /^https:\/\//.test(line.trim()))?.trim();
    if (!url) return null;
    const parsed = new URL(url);
    // Only return HTTPS media URLs; never pass arbitrary schemes downstream.
    return parsed.protocol === "https:" ? url : null;
  },
};
