/** Небольшой fetch-помощник: таймаут, повтор при сетевой ошибке и кэш в памяти. */
const cache = new Map<string, { expires: number; value: unknown }>();
const MAX_CACHE = 2000;

export class UpstreamError extends Error {
  constructor(
    message: string,
    public status = 502,
    /** Машиночитаемая причина для клиента (например, source_unreachable) */
    public code?: string,
  ) {
    super(message);
  }
}

export async function getJson<T>(url: string, opts: { ttlSec?: number; timeoutMs?: number } = {}): Promise<T> {
  const { ttlSec = 0, timeoutMs = 8000 } = opts;
  if (ttlSec > 0) {
    const hit = cache.get(url);
    if (hit && hit.expires > Date.now()) return hit.value as T;
  }

  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { "user-agent": "Suynd/1.0 (personal music app)", accept: "application/json" },
      });
      if (!res.ok) throw new UpstreamError(`HTTP ${res.status} от ${new URL(url).host}`, res.status >= 500 ? 502 : res.status);
      const value = (await res.json()) as T;
      if (ttlSec > 0) {
        if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value!);
        cache.set(url, { expires: Date.now() + ttlSec * 1000, value });
      }
      return value;
    } catch (err) {
      lastError = err;
      if (err instanceof UpstreamError && err.status < 500) break;
    }
  }
  throw lastError instanceof UpstreamError ? lastError : new UpstreamError(`Сервис недоступен: ${new URL(url).host}`);
}

/** Выполнить задачи с ограничением параллельности. Ошибки отдельных задач не роняют остальные. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<(R | null)[]> {
  const results: (R | null)[] = new Array(items.length).fill(null);
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const i = index++;
      try {
        results[i] = await fn(items[i]);
      } catch {
        results[i] = null;
      }
    }
  });
  await Promise.all(workers);
  return results;
}
