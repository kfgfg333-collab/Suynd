import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";

const cache = new Map<string, unknown>();

/** Загрузка данных с кэшем: при возврате на экран данные видны сразу, а затем тихо обновляются */
export function useApi<T>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | undefined>(() => (path ? (cache.get(path) as T | undefined) : undefined));
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(path) && !cache.has(path ?? ""));
  const current = useRef(path);

  const load = useCallback(async () => {
    if (!path) return;
    current.current = path;
    setError(null);
    if (!cache.has(path)) setLoading(true);
    try {
      const result = await api<T>(path);
      if (current.current !== path) return;
      cache.set(path, result);
      setData(result);
    } catch (e) {
      if (current.current === path) setError((e as Error).message);
    } finally {
      if (current.current === path) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ...deps]);

  useEffect(() => {
    setData(path ? (cache.get(path) as T | undefined) : undefined);
    void load();
  }, [load, path]);

  const mutate = useCallback(
    (updater: (prev: T | undefined) => T) => {
      setData((prev) => {
        const next = updater(prev);
        if (path) cache.set(path, next);
        return next;
      });
    },
    [path],
  );

  return { data, error, loading: loading && !data, reload: load, mutate };
}

export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
