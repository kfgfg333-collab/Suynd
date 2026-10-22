import { Heart, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { PlayButtons } from "../components/ListHeader";
import { TrackList } from "../components/TrackRow";
import { EmptyState, ErrorState, PageTitle, Segmented, TrackListSkeleton } from "../components/ui";
import { tracksCount } from "../lib/format";
import type { Track } from "../lib/types";
import { useApi } from "../lib/useApi";
import { useLibrary } from "../store/library";

export default function FavoritesPage() {
  const version = useLibrary((s) => s.version);
  const liked = useLibrary((s) => s.liked);
  const { data, error, loading, reload } = useApi<{ items: Track[] }>("/api/favorites", [version]);
  const [sort, setSort] = useState<"date" | "artist">("date");
  const [q, setQ] = useState("");

  const tracks = useMemo(() => {
    // Сразу скрываем трек, если лайк сняли (не ждём перезагрузки)
    let list = (data?.items ?? []).filter((t) => liked.has(t.id));
    const query = q.trim().toLowerCase();
    if (query) list = list.filter((t) => `${t.title} ${t.artist} ${t.album ?? ""}`.toLowerCase().includes(query));
    if (sort === "artist") list = [...list].sort((a, b) => a.artist.localeCompare(b.artist, "ru") || a.title.localeCompare(b.title, "ru"));
    return list;
  }, [data, liked, q, sort]);

  return (
    <div>
      <PageTitle>Любимые</PageTitle>
      {error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : loading ? (
        <TrackListSkeleton />
      ) : !data?.items.length ? (
        <EmptyState icon={<Heart className="h-7 w-7" />} title="Пока пусто" text="Нажимайте ♥ на треках — они соберутся здесь." />
      ) : (
        <>
          <p className="-mt-2 px-4 text-sm text-muted">{tracksCount(tracks.length)}</p>
          <PlayButtons tracks={tracks} title="Любимые" />
          <div className="space-y-3 px-4 pb-2">
            <div className="flex items-center gap-2 rounded-xl bg-surface-2 px-3 py-2.5">
              <Search className="h-4 w-4 text-muted" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Поиск в любимых" className="min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-muted" />
            </div>
            <Segmented
              value={sort}
              onChange={setSort}
              options={[
                { value: "date", label: "По дате" },
                { value: "artist", label: "По артисту" },
              ]}
            />
          </div>
          {tracks.length ? <TrackList tracks={tracks} title="Любимые" /> : <p className="px-4 py-8 text-center text-sm text-muted">Ничего не найдено</p>}
        </>
      )}
    </div>
  );
}
