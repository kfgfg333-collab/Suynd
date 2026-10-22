import { Clock, Trash2 } from "lucide-react";
import { TrackRow } from "../components/TrackRow";
import { EmptyState, ErrorState, PageTitle, TrackListSkeleton } from "../components/ui";
import { api } from "../lib/api";
import { DAY_LABELS, daysAgo } from "../lib/format";
import { confirmDialog, haptic } from "../lib/telegram";
import type { Track } from "../lib/types";
import { useApi } from "../lib/useApi";
import { useLibrary } from "../store/library";
import { usePlayer } from "../store/player";
import { toast } from "../store/toast";

interface Item {
  playId: number;
  playedAt: number;
  track: Track;
}

export default function HistoryPage() {
  const version = useLibrary((s) => s.version);
  const { data, error, loading, reload, mutate } = useApi<{ items: Item[] }>("/api/history", [version]);

  const groups = [0, 1, 2].map((d) => ({ label: DAY_LABELS[d], items: (data?.items ?? []).filter((i) => Math.min(2, daysAgo(i.playedAt)) === d) })).filter((g) => g.items.length);

  const clear = async () => {
    if (!(await confirmDialog("Очистить всю историю прослушивания?"))) return;
    await api("/api/history", { method: "DELETE" });
    mutate(() => ({ items: [] }));
    haptic.success();
    toast("История очищена");
    useLibrary.getState().bump();
  };

  return (
    <div>
      <PageTitle
        right={
          data?.items.length ? (
            <button onClick={clear} className="flex items-center gap-1.5 rounded-full bg-white/8 px-3 py-1.5 text-xs font-bold text-white/80">
              <Trash2 className="h-3.5 w-3.5" /> Очистить
            </button>
          ) : null
        }
      >
        История
      </PageTitle>
      <p className="-mt-2 px-4 text-xs text-muted">Трек попадает сюда после 15 секунд. Хранится 3 дня.</p>
      {error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : loading ? (
        <TrackListSkeleton />
      ) : !groups.length ? (
        <EmptyState icon={<Clock className="h-7 w-7" />} title="Здесь появится то, что вы слушали" text="Включите что-нибудь — история за последние 3 дня будет здесь." />
      ) : (
        groups.map((g) => {
          const tracks = g.items.map((i) => i.track);
          return (
            <section key={g.label} className="mt-5">
              <h2 className="px-4 pb-1 font-display text-base font-bold">{g.label}</h2>
              {g.items.map((item, i) => (
                <TrackRow
                  key={item.playId}
                  track={item.track}
                  subtitle={`${item.track.artist} · ${new Date(item.playedAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}`}
                  onPlay={() => usePlayer.getState().playList(tracks, i, `История · ${g.label}`)}
                />
              ))}
            </section>
          );
        })
      )}
    </div>
  );
}
