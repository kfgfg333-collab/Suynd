import { initData, isTelegram } from "./telegram";
import type { Track } from "./types";

export const API_URL = (import.meta.env.VITE_API_URL ?? "http://localhost:3000").replace(/\/$/, "");

let token: string | null = null;
let loginPromise: Promise<void> | null = null;

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
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
  if (!res.ok) throw new ApiError(data.message ?? `Ошибка ${res.status}`, res.status);
  return data as T;
}

/** Ссылка на ресурс бэкенда, понятная тегам <audio>/<img> (токен в query) */
export function mediaUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  if (/^https?:|^blob:|^data:/.test(path)) return path;
  return `${API_URL}${path}${path.includes("?") ? "&" : "?"}t=${encodeURIComponent(token ?? "")}`;
}

export const streamUrl = (t: Track) => mediaUrl(`/api/stream/${encodeURIComponent(t.id)}`)!;
export const downloadUrl = (t: Track) => mediaUrl(`/api/download/${encodeURIComponent(t.id)}`)!;
export const enc = encodeURIComponent;
