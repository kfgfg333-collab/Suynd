import { CloudOff, HardDrive, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { PlayButtons } from "../components/ListHeader";
import { TrackRow } from "../components/TrackRow";
import { EmptyState, PageTitle, TrackListSkeleton } from "../components/ui";
import { formatBytes, tracksCount } from "../lib/format";
import { clearOffline, listOffline, storageEstimate, type OfflineEntry } from "../lib/offline";
import { confirmDialog, haptic } from "../lib/telegram";
import { useLibrary } from "../store/library";
import { usePlayer } from "../store/player";
import { toast } from "../store/toast";

export default function DownloadsPage() {
  const offline = useLibrary((s) => s.offline);
  const downloading = useLibrary((s) => s.downloading);
  const [entries, setEntries] = useState<OfflineEntry[] | null>(null);
  const [quota, setQuota] = useState<{ usage: number; quota: number } | null>(null);

  useEffect(() => {
    listOffline().then(setEntries);
    storageEstimate().then(setQuota);
  }, [offline]);

  const used = entries?.reduce((s, e) => s + e.size, 0) ?? 0;
  const tracks = entries?.map((e) => e.track) ?? [];

  const removeAll = async () => {
    if (!(await confirmDialog("Удалить все скачанные треки с устройства?"))) return;
    await clearOffline();
    await useLibrary.getState().refreshOffline();
    haptic.success();
    toast("Скачанное очищено");
  };

  return (
    <div>
      <PageTitle>Скачанное</PageTitle>

      <div className="mx-4 rounded-2xl bg-surface p-4">
        <div className="flex items-center gap-3">
          <HardDrive className="h-5 w-5 text-accent" />
          <div className="flex-1">
            <div className="font-bold">{formatBytes(used)}</div>
            <div className="text-xs text-muted">
              {tracksCount(tracks.length)} на устройстве{quota?.quota ? ` · доступно ~${formatBytes(Math.max(0, quota.quota - quota.usage))}` : ""}
            </div>
          </div>
          {tracks.length > 0 && (
            <button onClick={removeAll} className="flex items-center gap-1.5 rounded-full bg-white/8 px-3 py-1.5 text-xs font-bold text-red-300">
              <Trash2 className="h-3.5 w-3.5" /> Всё
            </button>
          )}
        </div>
        {quota?.quota ? (
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/10">
            <div className="h-full rounded-full bg-accent" style={{ width: `${Math.min(100, Math.max(2, (quota.usage / quota.quota) * 100))}%` }} />
          </div>
        ) : null}
      </div>

      {downloading.size > 0 && (
        <div className="mx-4 mt-3 space-y-2 rounded-2xl bg-surface p-4">
          <div className="text-xs font-bold uppercase tracking-widest text-muted">Скачивается</div>
          {[...downloading.entries()].map(([id, p]) => (
            <div key={id} className="h-1.5 overflow-hidden rounded-full bg-white/10">
              <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${Math.round(p * 100)}%` }} />
            </div>
          ))}
        </div>
      )}

      {entries === null ? (
        <TrackListSkeleton />
      ) : tracks.length === 0 ? (
        <EmptyState
          icon={<CloudOff className="h-7 w-7" />}
          title="Ничего не скачано"
          text="Скачивать можно ваши файлы и треки Audius, где автор разрешил скачивание. Ищите кнопку ⬇ в плеере или в меню «⋯»."
        />
      ) : (
        <>
          <PlayButtons tracks={tracks} title="Скачанное" />
          {entries.map((e, i) => (
            <TrackRow key={e.id} track={e.track} subtitle={`${e.track.artist} · ${formatBytes(e.size)}`} onPlay={() => usePlayer.getState().playList(tracks, i, "Скачанное")} />
          ))}
        </>
      )}
    </div>
  );
}
