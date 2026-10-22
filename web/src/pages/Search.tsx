import { AnimatePresence, motion } from "framer-motion";
import { Clock, ExternalLink, MoreHorizontal, Pause, Play, Search as SearchIcon, SearchX, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { TrackList } from "../components/TrackRow";
import { Button, Cover, EmptyState, ErrorState, Segmented, Skeleton, SourceBadge } from "../components/ui";
import { enc, SOURCE_LABELS } from "../lib/api";
import { formatTime } from "../lib/format";
import { openLink } from "../lib/telegram";
import type { Album, Artist, BestResult, Track, WebResult, WebSearchResult } from "../lib/types";
import { useApi, useDebounced } from "../lib/useApi";
import { useCurrentTrack, usePlayer } from "../store/player";
import { useUi } from "../store/ui";

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
          <EmptyState icon={<SearchIcon className="h-7 w-7" />} title="Найдите любимую музыку" text="Напишите песню или исполнителя. Suynd ищет полную версию в Audius, Jamendo, Internet Archive, Openverse и ваших файлах, проверяет, что звук доступен, и показывает один лучший результат." />
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
  if (tab === "tracks") return <TrackResults q={q} />;
  return <CatalogResults q={q} tab={tab} />;
}

/**
 * Один основной результат. Порядок: точное совпадение в источниках Suynd (играет здесь) →
 * лучшая страница в интернете (открывается в браузере) → совпадение по словам запроса → честное «не найдено».
 * Оба поиска идут параллельно: результат Suynd показывается сразу, веб-страницы догружаются.
 */
function TrackResults({ q }: { q: string }) {
  const own = useApi<BestResult>(`/api/search?q=${enc(q)}&type=tracks`);
  const web = useApi<WebSearchResult>(`/api/search/web?q=${enc(q)}`);
  const [showMore, setShowMore] = useState(false);
  useEffect(() => setShowMore(false), [q]);

  const data = own.data;
  const exact = data?.best && data.mode === "track" ? data.best : null;
  const webDone = Boolean(web.data || web.error);
  const webBest = web.data?.best ?? null;

  if (own.error && web.error) return <ErrorState message={own.error} onRetry={() => (own.reload(), web.reload())} />;
  // Ждём, пока станет ясно, что показывать главным: точный трек Suynd или страницу из интернета
  if (!exact && (!webDone || (own.loading && !own.error))) return <BestSkeleton />;

  const webList = [webBest, ...(web.data?.others ?? [])].filter((w): w is WebResult => Boolean(w));
  const main: "own" | "web" | "none" = exact ? "own" : webBest ? "web" : data?.best ? "own" : "none";
  const ownTrack = exact ?? data?.best ?? null;
  const restWeb = main === "web" ? webList.slice(1) : webList;
  const partial = Boolean(data?.partial || web.data?.partial);

  return (
    <div>
      {main === "own" && ownTrack && <OwnCard track={ownTrack} q={q} />}
      {main === "web" && webBest && <WebCard result={webBest} />}
      {main === "none" && <NothingFound q={q} data={data} />}

      {main === "own" && data && data.more.length > 0 && (
        <div className="mt-4">
          {showMore ? (
            <TrackList tracks={data.more} title={`Поиск: ${q}`} />
          ) : (
            <button onClick={() => setShowMore(true)} className="mx-4 text-sm font-bold text-white/80">
              Другие песни по запросу ({data.more.length})
            </button>
          )}
        </div>
      )}

      {restWeb.length > 0 && (
        <div className="mx-4 mt-5">
          <div className="mb-2 text-xs font-bold uppercase tracking-widest text-muted">Где ещё послушать</div>
          <div className="space-y-2">
            {restWeb.map((w) => (
              <WebRow key={w.url} result={w} />
            ))}
          </div>
        </div>
      )}
      {!webDone && main === "own" && <div className="mx-4 mt-5 text-xs text-muted">Ищем, где ещё можно послушать…</div>}
      {web.data?.notice && <div className="mx-4 mt-4 text-[11px] text-muted">{web.data.notice}</div>}
      {partial && (
        <div className="mx-4 mt-3 flex items-center justify-between gap-3 rounded-2xl bg-surface px-4 py-3 text-xs text-muted">
          <span>Часть источников сейчас не ответила — результат может быть неполным.</span>
          <button onClick={() => (own.reload(), web.reload())} className="shrink-0 font-bold text-white/80">
            Повторить
          </button>
        </div>
      )}
    </div>
  );
}

/** Трек из разрешённого источника — играет в плеере Suynd */
function OwnCard({ track, q }: { track: Track; q: string }) {
  const playList = usePlayer((s) => s.playList);
  const isPlaying = usePlayer((s) => s.isPlaying);
  const current = useCurrentTrack();
  const openSheet = useUi((s) => s.openSheet);
  const active = current?.id === track.id;
  return (
    <div className="mx-4 rounded-3xl bg-surface p-4">
      <div className="mb-3 text-xs font-bold uppercase tracking-widest text-muted">Лучший результат · играет в Suynd</div>
      <div className="flex items-center gap-4">
        <Cover src={track.cover} className="h-24 w-24" rounded="rounded-2xl" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-lg font-bold">{track.title}</div>
          <div className="truncate text-sm text-muted">{track.artist}</div>
          <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-muted">
            <SourceBadge track={track} />
            <span className="truncate">
              {SOURCE_LABELS[track.source]}
              {track.duration ? ` · ${formatTime(track.duration)}` : ""}
            </span>
          </div>
        </div>
      </div>
      <div className="mt-4 flex items-center gap-2">
        <Button className="flex-1" onClick={() => playList([track], 0, `Поиск: ${q}`)}>
          {active && isPlaying ? <Pause className="h-4 w-4 fill-black" /> : <Play className="h-4 w-4 fill-black" />}
          {active && isPlaying ? "Пауза" : "Слушать"}
        </Button>
        <Button variant="secondary" onClick={() => openSheet(track, {})}>
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </div>
      {(track.alternates?.length ?? 0) > 0 && (
        <div className="mt-3 text-[11px] text-muted">
          Запасные источники этой записи: {[...new Set(track.alternates!.map((a) => SOURCE_LABELS[a.source]))].join(", ")} — включатся сами, если основной не ответит.
        </div>
      )}
    </div>
  );
}

const VERIFIED_LABEL: Record<WebResult["verified"], string> = {
  ok: "страница проверена",
  blocked: "сайт не пускает проверку",
  robots: "проверка запрещена сайтом",
  gone: "страница не найдена",
  error: "страницу проверить не удалось",
};

/** Страница в интернете: открывается в браузере, это не плеер Suynd */
function WebCard({ result }: { result: WebResult }) {
  return (
    <div className="mx-4 rounded-3xl bg-surface p-4">
      <div className="mb-3 text-xs font-bold uppercase tracking-widest text-muted">Лучший результат · {result.official ? "официальный сервис" : "внешний сайт"}</div>
      <div className="flex items-center gap-4">
        <Cover src={result.cover} className="h-24 w-24" rounded="rounded-2xl" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-lg font-bold">{result.title}</div>
          {result.artist && <div className="truncate text-sm text-muted">{result.artist}</div>}
          <div className="mt-1.5 truncate text-[11px] text-muted">
            {result.site}
            {result.duration ? ` · ${formatTime(result.duration)}${result.durationSource === "catalog" ? " (по каталогу)" : ""}` : ""}
          </div>
        </div>
      </div>
      <Button className="mt-4 w-full" onClick={() => openLink(result.url)}>
        <ExternalLink className="h-4 w-4" />
        Открыть на {result.domain}
      </Button>
      <div className="mt-3 text-[11px] leading-snug text-muted">
        {VERIFIED_LABEL[result.verified].charAt(0).toUpperCase() + VERIFIED_LABEL[result.verified].slice(1)}. {result.note}.
      </div>
    </div>
  );
}

function WebRow({ result }: { result: WebResult }) {
  return (
    <button onClick={() => openLink(result.url)} className="flex w-full items-center gap-3 rounded-2xl bg-surface px-4 py-3 text-left active:bg-white/5">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold">{result.site}</div>
        <div className="truncate text-[11px] text-muted">
          {result.official ? "официальный сервис" : "внешний сайт, права не проверены"} · {VERIFIED_LABEL[result.verified]}
        </div>
      </div>
      <ExternalLink className="h-4 w-4 shrink-0 text-muted" />
    </button>
  );
}

function NothingFound({ q, data }: { q: string; data: BestResult | undefined }) {
  const c = data?.catalog;
  return (
    <>
      <EmptyState
        icon={<SearchX className="h-7 w-7" />}
        title="Полной версии не нашлось"
        text={
          c
            ? `«${c.artist} — ${c.title}» есть в каталоге, но ни подключённые источники, ни веб-поиск не нашли, где её послушать целиком. Превью, ремиксы и чужие версии мы не подставляем.`
            : `По запросу «${q}» подходящих треков не нашлось. Попробуйте написать иначе.`
        }
      />
      {data?.links && (
        <div className="mx-4 space-y-2">
          <div className="text-xs font-bold uppercase tracking-widest text-muted">Поискать в официальных сервисах</div>
          {data.links.deezer && <LinkRow label="Deezer" url={data.links.deezer} />}
          <LinkRow label="Spotify" url={data.links.spotify} />
          <LinkRow label="Яндекс Музыка" url={data.links.yandex} />
        </div>
      )}
    </>
  );
}

function LinkRow({ label, url }: { label: string; url: string }) {
  return (
    <button onClick={() => openLink(url)} className="flex w-full items-center justify-between rounded-2xl bg-surface px-4 py-3 text-sm font-semibold active:bg-white/5">
      {label}
      <ExternalLink className="h-4 w-4 text-muted" />
    </button>
  );
}

function BestSkeleton() {
  return (
    <div className="mx-4 rounded-3xl bg-surface p-4">
      <Skeleton className="mb-3 h-3 w-1/3" />
      <div className="flex items-center gap-4">
        <Skeleton className="h-24 w-24 rounded-2xl" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      </div>
      <Skeleton className="mt-4 h-10 w-full rounded-full" />
      <div className="mt-3 text-center text-xs text-muted">Ищем во всех источниках и проверяем, что звук доступен…</div>
    </div>
  );
}

function CatalogResults({ q, tab }: { q: string; tab: Exclude<Tab, "tracks"> }) {
  const { data, error, loading, reload } = useApi<{ items: (Artist | Album)[] }>(`/api/search?q=${enc(q)}&type=${tab}`);
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (loading || !data) return <GridSkeleton round={tab === "artists"} />;
  if (!data.items.length)
    return <EmptyState icon={<SearchX className="h-7 w-7" />} title="Ничего не нашлось" text={`По запросу «${q}» пусто. Попробуйте написать иначе.`} />;
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
