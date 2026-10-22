import { Reorder, useDragControls } from "framer-motion";
import { GripVertical, ListMusic, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { PlayButtons } from "../components/ListHeader";
import { PlaylistCollage } from "../components/PlaylistCollage";
import { Sheet, SheetItem } from "../components/Sheet";
import { Cover, EmptyState, ErrorState, SourceBadge, Skeleton, TrackListSkeleton } from "../components/ui";
import { api } from "../lib/api";
import { tracksCount } from "../lib/format";
import { confirmDialog, haptic } from "../lib/telegram";
import type { Playlist, Track } from "../lib/types";
import { useApi } from "../lib/useApi";
import { useLibrary } from "../store/library";
import { useCurrentTrack, usePlayer } from "../store/player";
import { toast } from "../store/toast";
import { useUi } from "../store/ui";

export default function PlaylistPage() {
  const id = Number(useParams().id);
  const navigate = useNavigate();
  const { data, error, loading, reload, mutate } = useApi<{ playlist: Playlist; tracks: Track[] }>(`/api/playlists/${id}`);
  const [order, setOrder] = useState<Track[]>([]);
  const [menu, setMenu] = useState(false);

  useEffect(() => {
    if (data) setOrder(data.tracks);
  }, [data]);

  const saveOrder = async (tracks: Track[]) => {
    try {
      await api(`/api/playlists/${id}/order`, { method: "PUT", body: { trackIds: tracks.map((t) => t.id) } });
      mutate((prev) => ({ playlist: prev!.playlist, tracks }));
      useLibrary.getState().bump();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  const rename = async () => {
    setMenu(false);
    const name = await useUi.getState().askText("Название плейлиста", data?.playlist.name);
    if (!name) return;
    await api(`/api/playlists/${id}`, { method: "PATCH", body: { name } });
    mutate((prev) => ({ ...prev!, playlist: { ...prev!.playlist, name } }));
    useLibrary.getState().bump();
  };

  const remove = async () => {
    setMenu(false);
    if (!(await confirmDialog(`Удалить плейлист «${data?.playlist.name}»?`))) return;
    await api(`/api/playlists/${id}`, { method: "DELETE" });
    useLibrary.getState().bump();
    toast("Плейлист удалён");
    navigate("/collection/playlists", { replace: true });
  };

  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (loading || !data)
    return (
      <div className="px-4 pt-6">
        <Skeleton className="mx-auto h-52 w-52 rounded-3xl" />
        <Skeleton className="mx-auto mt-4 h-6 w-40" />
        <div className="mt-6">
          <TrackListSkeleton />
        </div>
      </div>
    );

  return (
    <div>
      <div className="flex flex-col items-center px-4 pt-6 text-center">
        <PlaylistCollage covers={order.slice(0, 4).map((t) => t.cover)} className="h-52 w-52 shadow-2xl" />
        <h1 className="mt-4 font-display text-2xl font-bold">{data.playlist.name}</h1>
        <p className="mt-1 text-sm text-muted">{tracksCount(order.length)}</p>
      </div>
      <PlayButtons
        tracks={order}
        title={data.playlist.name}
        extra={
          <button aria-label="Меню плейлиста" onClick={() => setMenu(true)} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white/10">
            <MoreHorizontal className="h-5 w-5" />
          </button>
        }
      />
      {order.length === 0 ? (
        <EmptyState icon={<ListMusic className="h-7 w-7" />} title="В плейлисте пусто" text="Откройте меню «⋯» у любого трека и выберите «Добавить в плейлист»." />
      ) : (
        <>
          <p className="px-4 pb-1 text-xs text-muted">Потяните за ⋮⋮, чтобы поменять порядок</p>
          <Reorder.Group axis="y" values={order} onReorder={setOrder}>
            {order.map((t, i) => (
              <PlaylistRow
                key={t.id}
                track={t}
                onPlay={() => usePlayer.getState().playList(order, i, data.playlist.name)}
                onDrop={() => saveOrder(order)}
                onRemoved={() => {
                  const next = order.filter((x) => x.id !== t.id);
                  setOrder(next);
                  mutate((prev) => ({ ...prev!, tracks: next }));
                }}
                playlistId={id}
              />
            ))}
          </Reorder.Group>
        </>
      )}
      <Sheet open={menu} onClose={() => setMenu(false)}>
        <SheetItem icon={<Pencil />} label="Переименовать" onClick={rename} />
        <SheetItem icon={<Trash2 />} label="Удалить плейлист" danger onClick={remove} />
      </Sheet>
    </div>
  );
}

function PlaylistRow({ track, onPlay, onDrop, onRemoved, playlistId }: { track: Track; onPlay: () => void; onDrop: () => void; onRemoved: () => void; playlistId: number }) {
  const controls = useDragControls();
  const current = useCurrentTrack();
  const openSheet = useUi((s) => s.openSheet);
  const active = current?.id === track.id;
  return (
    <Reorder.Item
      value={track}
      dragListener={false}
      dragControls={controls}
      onDragEnd={onDrop}
      className="relative flex items-center gap-3 bg-bg px-4 py-2"
      whileDrag={{ scale: 1.02, boxShadow: "0 10px 30px rgba(0,0,0,0.5)", zIndex: 10 }}
    >
      <div
        onPointerDown={(e) => {
          haptic.impact("light");
          controls.start(e);
        }}
        className="-ml-2 flex h-10 w-7 touch-none items-center justify-center text-muted"
        aria-label="Перетащить"
      >
        <GripVertical className="h-5 w-5" />
      </div>
      <button className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={onPlay}>
        <Cover src={track.cover} className="h-12 w-12" />
        <div className="min-w-0 flex-1">
          <div className={`truncate text-[15px] font-semibold ${active ? "text-accent" : ""}`}>{track.title}</div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[13px] text-muted">
            <SourceBadge track={track} />
            <span className="truncate">{track.artist}</span>
          </div>
        </div>
      </button>
      <button aria-label="Ещё" onClick={() => openSheet(track, { playlistId, onRemoved })} className="-mr-2 flex h-9 w-9 items-center justify-center text-muted">
        <MoreHorizontal className="h-5 w-5" />
      </button>
    </Reorder.Item>
  );
}
