import { initData, isTelegram } from "./telegram";
import type { Track } from "./types";

export const API_URL = (import.meta.env.VITE_API_URL ?? "http://localhost:3000").replace(/\/$/, "");

let token: string | null = null;
let loginPromise: Promise<void> | null = null;

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    /** Причина от сервера, например ytdlp_not_installed */
    public code?: string,
  ) {
    super(message);
  }
}

const TOKEN_KEY = "suynd.session";

export async function login(force = false): Promise<void> {
  if (!force && token) return;
  if (!force) {
    try {
      const saved = JSON.parse(sessionStorage.getItem(TOKEN_KEY) ?? "null");
      if (saved && saved.expiresAt * 1000 > Date.now() + 60_000) {
        token = saved.token;
        return;
      }
    } catch {
      /* нет sessionStorage */
    }
  }
  loginPromise ??= (async () => {
    let res: Response;
    try {
      res = await fetch(`${API_URL}/api/auth`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ initData: isTelegram ? initData : undefined }),
      });
    } catch {
      throw new ApiError("Сервер недоступен. Проверьте интернет или подождите минуту — сервер мог «проснуться».", 0);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(data.message ?? "Не удалось войти", res.status);
    token = data.token;
    try {
      sessionStorage.setItem(TOKEN_KEY, JSON.stringify({ token: data.token, expiresAt: data.expiresAt }));
    } catch {
      /* ignore */
    }
  })().finally(() => {
    loginPromise = null;
  });
  return loginPromise;
}

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown; retry?: boolean } = {}): Promise<T> {
  await login();
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method: opts.method ?? "GET",
      headers: {
        authorization: `Bearer ${token}`,
        ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw new ApiError("Нет соединения с сервером", 0);
  }
  if (res.status === 401 && opts.retry !== false) {
    token = null;
    await login(true);
    return api<T>(path, { ...opts, retry: false });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.message ?? `Ошибка ${res.status}`, res.status, data.code);
  return data as T;
}

/** Ссылка на ресурс бэкенда, понятная тегам <audio>/<img> (токен в query) */
export function mediaUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  if (/^blob:|^data:/.test(path)) return path;
  // Внешние картинки — через сервер: CDN источника может быть заблокирован у пользователя
  if (/^https?:/.test(path)) return `${API_URL}/api/img?u=${encodeURIComponent(path)}&t=${encodeURIComponent(token ?? "")}`;
  return `${API_URL}${path}${path.includes("?") ? "&" : "?"}t=${encodeURIComponent(token ?? "")}`;
}

export const streamUrl = (t: Track) => mediaUrl(`/api/stream/${encodeURIComponent(t.id)}`)!;
export const downloadUrl = (t: Track) => mediaUrl(`/api/download/${encodeURIComponent(t.id)}`)!;
export const enc = encodeURIComponent;

export const SOURCE_LABELS: Record<Track["source"], string> = {
  deezer: "Deezer",
  audius: "Audius",
  library: "Мои файлы",
  itunes: "iTunes",
  archive: "Internet Archive · CC",
  jamendo: "Jamendo · CC",
  openverse: "Openverse · CC",
  ytdlp: "YouTube · yt-dlp",
};

/** Загрузка файла на сервер с прогрессом (fetch не умеет прогресс отправки) */
export function uploadFile<T>(path: string, file: File, onProgress: (p: number) => void): Promise<T> {
  return login().then(
    () =>
      new Promise<T>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", `${API_URL}${path}`);
        xhr.setRequestHeader("authorization", `Bearer ${token}`);
        xhr.setRequestHeader("content-type", "application/octet-stream");
        xhr.setRequestHeader("x-file-name", encodeURIComponent(file.name));
        xhr.setRequestHeader("x-file-type", file.type || "");
        xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
        xhr.onload = () => {
          let data: { message?: string } = {};
          try {
            data = JSON.parse(xhr.responseText);
          } catch {
            /* пустой ответ */
          }
          if (xhr.status >= 200 && xhr.status < 300) resolve(data as T);
          else reject(new ApiError(data.message ?? `Ошибка ${xhr.status}`, xhr.status));
        };
        xhr.onerror = () => reject(new ApiError("Нет соединения с сервером", 0));
        xhr.send(file);
      }),
  );
}
