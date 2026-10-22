import { AnimatePresence, motion } from "framer-motion";
import { Clock, Search as SearchIcon, SearchX, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { TrackList } from "../components/TrackRow";
import { Cover, EmptyState, ErrorState, Segmented, Skeleton, TrackListSkeleton } from "../components/ui";
import { enc } from "../lib/api";
import type { Album, Artist, Track } from "../lib/types";
import { useApi, useDebounced } from "../lib/useApi";

type Tab = "tracks" | "artists" | "albums";
const RECENT_KEY = "suynd.recentSearches";

function loadRecent(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
  } catch {
    return [];
  }
}

export default function SearchPage() {
  const [q, setQ] = useState(() => sessionStorage.getItem("suynd.q") ?? "");
  const [tab, setTab] = useState<Tab>(() => (sessionStorage.getItem("suynd.tab") as Tab) ?? "tracks");
  const [recent, setRecent] = useState<string[]>(loadRecent);
  const debounced = useDebounced(q.trim(), 300);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    sessionStorage.setItem("suynd.q", q);
    sessionStorage.setItem("suynd.tab", tab);
  }, [q, tab]);

  // Запоминаем запрос, если по нему что-то искали дольше секунды
  useEffect(() => {
    if (debounced.length < 2) return;
    const t = setTimeout(() => {
      const next = [debounced, ...loadRecent().filter((x) => x.toLowerCase() !== debounced.toLowerCase())].slice(0, 10);
      localStorage.setItem(RECENT_KEY, JSON.stringify(next));
      setRecent(next);
    }, 1200);
    return () => clearTimeout(t);
  }, [debounced]);

  const clearRecent = () => {
    localStorage.removeItem(RECENT_KEY);
    setRecent([]);
  };

  return (
    <div>
      <div className="sticky top-0 z-30 bg-bg/90 px-4 pb-3 pt-4 backdrop-blur-xl">
        <div className="flex items-center gap-2 rounded-2xl bg-surface-2 px-4 py-3 ring-accent/60 focus-within:ring-2">
          <SearchIcon className="h-5 w-5 shrink-0 text-muted" />
          <input
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Треки, артисты, альбомы"
            enterKeyHint="search"
            onKeyDown={(e) => e.key === "Enter" && input.current?.blur()}
            className="min-w-0 flex-1 bg-transparent text-[16px] outline-none placeholder:text-muted"
          />
          {q && (
            <button aria-label="Очистить" onClick={() => setQ("")} className="text-muted">
              <X className="h-5 w-5" />
            </button>
          )}
        </div>
        {debounced && (
          <div className="mt-3">
            <Segmented
              value={tab}
              onChange={setTab}
              options={[
                { value: "tracks", label: "Треки" },
                { value: "artists", label: "Артисты" },
                { value: "albums", label: "Альбомы" },
              ]}
            />
          </div>
        )}
      </div>

      {!debounced ? (
        recent.length ? (
          <div className="px-4">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="font-display font-bold">Недавние запросы</h2>
              <button onClick={clearRecent} className="text-xs font-bold text-muted">
                Очистить
              </button>
            </div>
            {recent.map((r) => (
              <button key={r} onClick={() => setQ(r)} className="flex w-full items-center gap-3 py-2.5 text-left">
                <Clock className="h-4 w-4 text-muted" />
                <span className="flex-1 truncate">{r}</span>
              </button>
            ))}
          </div>
        ) : (
          <EmptyState icon={<SearchIcon className="h-7 w-7" />} title="Найдите любимую музыку" text="Только полные треки: Audius, Internet Archive, Openverse, Jamendo, YouTube (если на сервере есть yt-dlp) и ваши файлы. Совпадения из каталога Deezer проверяем — нет ли где-то полной версии." />
        )
      ) : (
        <AnimatePresence mode="wait">
          <motion.div key={tab} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
            <Results q={debounced} tab={tab} />
          </motion.div>
        </AnimatePresence>
      )}
    </div>
  );
}

function Results({ q, tab }: { q: string; tab: Tab }) {
  const { data, error, loading, reload } = useApi<{
    items: (Track | Artist | Album)[];
    unavailable?: { id: string; title: string; artist: string; explicit: boolean }[];
    warnings?: string[];
  }>(
    `/api/search?q=${enc(q)}&type=${tab}`,
  );
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (loading || !data) return tab === "tracks" ? <TrackListSkeleton rows={8} /> : <GridSkeleton round={tab === "artists"} />;
  const unavailable = tab === "tracks" ? (data.unavailable ?? []) : [];
  // Источник не ответил (например, на сервере нет yt-dlp) — остальные результаты показываем, причину пишем строкой
  const warnings = (data.warnings ?? []).length > 0 && (
    <div className="mx-4 mb-3 flex items-start justify-between gap-3 rounded-2xl bg-surface px-4 py-3 text-xs text-muted">
      <div className="space-y-1">
        {data.warnings!.map((w) => (
          <div key={w}>{w}</div>
        ))}
      </div>
      <button onClick={reload} className="shrink-0 font-bold text-white/80">
        Повторить
      </button>
    </div>
  );
  if (!data.items.length && !unavailable.length)
    return (
      <>
        {warnings}
        <EmptyState icon={<SearchX className="h-7 w-7" />} title="Ничего не нашлось" text={`По запросу «${q}» пусто. Попробуйте написать иначе.`} />
      </>
    );

  if (tab === "tracks") {
    return (
      <>
        {warnings}
        {data.items.length > 0 ? (
          <TrackList tracks={data.items as Track[]} title={`Поиск: ${q}`} />
        ) : (
          <EmptyState icon={<SearchX className="h-7 w-7" />} title="Полная версия недоступна" text="Полных треков по этому запросу в подключённых источниках не нашлось." />
        )}
        {unavailable.length > 0 && (
          <div className="mx-4 mt-4 rounded-2xl bg-surface p-4">
            <div className="text-xs font-bold uppercase tracking-widest text-muted">Есть в каталоге, но полной версии нет</div>
            <ul className="mt-2 space-y-1.5">
              {unavailable.map((u) => (
                <li key={u.id} className="flex items-center gap-2 text-sm text-white/70">
                  {u.explicit && <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] bg-white/60 text-[10px] font-black text-black">E</span>}
                  <span className="truncate">
                    {u.artist} — {u.title}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </>
    );
  }
  if (tab === "artists") {
    return (
      <div className="grid grid-cols-3 gap-x-3 gap-y-5 px-4">
        {(data.items as Artist[]).map((a) => (
          <Link key={a.id} to={`/artist/${enc(a.id)}`} className="text-center">
            <Cover src={a.picture} className="aspect-square w-full" round />
            <div className="mt-2 truncate text-sm font-semibold">{a.name}</div>
            <div className="text-[11px] text-muted">{a.source === "audius" ? "Audius" : "Deezer"}</div>
          </Link>
        ))}
      </div>
    );
  }
  return (
    <div className="grid grid-cols-2 gap-x-3 gap-y-5 px-4">
      {(data.items as Album[]).map((a) => (
        <Link key={a.id} to={`/album/${enc(a.id)}`}>
          <Cover src={a.cover} className="aspect-square w-full" rounded="rounded-2xl" />
          <div className="mt-2 truncate text-sm font-semibold">{a.title}</div>
          <div className="truncate text-xs text-muted">
            {a.artist}
            {a.releaseDate ? ` · ${a.releaseDate.slice(0, 4)}` : ""}
          </div>
        </Link>
      ))}
    </div>
  );
}

function GridSkeleton({ round }: { round?: boolean }) {
  return (
    <div className={`grid gap-3 px-4 ${round ? "grid-cols-3" : "grid-cols-2"}`}>
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="space-y-2">
          <Skeleton className={`aspect-square w-full ${round ? "rounded-full" : "rounded-2xl"}`} />
          <Skeleton className="h-3 w-3/4" />
        </div>
      ))}
    </div>
  );
}
