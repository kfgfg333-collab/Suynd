import {
  Ban,
  Check,
  Disc3,
  Download,
  ExternalLink,
  Heart,
  ListEnd,
  ListPlus,
  ListStart,
  Mic2,
  Plus,
  Send,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, enc, SOURCE_LABELS } from "../lib/api";
import { confirmDialog, haptic, openLink } from "../lib/telegram";
import type { Playlist, Track } from "../lib/types";
import { useLibrary } from "../store/library";
import { usePlayer } from "../store/player";
import { toast } from "../store/toast";
import { useUi } from "../store/ui";
import { Sheet, SheetItem } from "./Sheet";
import { Cover, SourceBadge } from "./ui";

export function TrackSheet() {
  const sheet = useUi((s) => s.sheet);
  const close = useUi((s) => s.closeSheet);
  const [view, setView] = useState<"main" | "playlists">("main");
  useEffect(() => setView("main"), [sheet]);

  return (
    <Sheet open={Boolean(sheet)} onClose={close}>
      {sheet && (view === "main" ? <MainActions track={sheet.track} ctx={sheet.ctx} onPlaylists={() => setView("playlists")} /> : <PlaylistPicker track={sheet.track} />)}
    </Sheet>
  );
}

function MainActions({ track, ctx, onPlaylists }: { track: Track; ctx: { playlistId?: number; onRemoved?: () => void }; onPlaylists: () => void }) {
  const navigate = useNavigate();
  const close = useUi((s) => s.closeSheet);
  const liked = useLibrary((s) => s.liked.has(track.id));
  const offline = useLibrary((s) => s.offline.has(track.id));
  const progress = useLibrary((s) => s.downloading.get(track.id));
  const lib = useLibrary.getState();
  const player = usePlayer.getState();
  // YouTube: скачать можно только ролик под Creative Commons — сервер проверяет лицензию при открытии меню
  const [license, setLicense] = useState<{ downloadable: boolean; reason?: string } | null>(null);
  useEffect(() => {
    setLicense(null);
    if (track.source !== "ytdlp" || track.downloadable) return;
    let alive = true;
    api<{ downloadable: boolean; reason?: string }>(`/api/tracks/${enc(track.id)}/download-check`)
      .then((r) => alive && setLicense(r))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [track.id, track.source, track.downloadable]);
  const dl = license?.downloadable ? { ...track, downloadable: true } : track;

  const run = (fn: () => void) => () => {
    haptic.impact("light");
    close();
    fn();
  };

  const go = (path: string) => {
    usePlayer.getState().setFullOpen(false);
    navigate(path);
  };

  const playSimilar = async () => {
    toast("Ищу похожее…");
    try {
      const { items } = await api<{ items: Track[] }>(`/api/tracks/${enc(track.id)}/similar`);
      if (!items.length) return toast("Похожих треков не нашлось");
      player.playList([track, ...items], 0, `Похожее на «${track.title}»`);
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  return (
    <div>
      <div className="flex items-center gap-3 px-5 pb-3">
        <Cover src={track.cover} className="h-14 w-14" />
        <div className="min-w-0 flex-1">
          <div className="truncate font-bold">{track.title}</div>
          <div className="truncate text-sm text-muted">{track.artist}</div>
          <div className="mt-1 flex items-center gap-1.5">
            <SourceBadge track={track} />
            <span className="text-[11px] text-muted">{SOURCE_LABELS[track.source]}</span>
          </div>
        </div>
      </div>
      <div className="h-px bg-line" />
      <SheetItem icon={<Heart className={liked ? "fill-accent text-accent" : ""} />} label={liked ? "Убрать из любимых" : "В любимые"} onClick={run(() => lib.toggleLike(track))} />
      <SheetItem icon={<ListStart />} label="Играть следующим" onClick={run(() => player.playNext(track))} />
      <SheetItem icon={<ListEnd />} label="Добавить в очередь" onClick={run(() => player.addToQueue(track))} />
      <SheetItem icon={<ListPlus />} label="Добавить в плейлист" onClick={onPlaylists} />
      <SheetItem icon={<Sparkles />} label="Похожее" onClick={run(playSimilar)} />
      {dl.downloadable && (
        <>
          <SheetItem
            icon={offline ? <Check className="text-full" /> : <Download />}
            label={offline ? "Удалить из скачанного" : progress !== undefined ? `Скачивается… ${Math.round(progress * 100)}%` : "Скачать для офлайна"}
            onClick={run(() => (offline ? lib.removeDownload(track.id).then(() => toast("Удалено из скачанного")) : lib.download(dl)))}
          />
          <SheetItem icon={<Send />} label="Отправить файл в чат" onClick={run(() => lib.sendToChat(dl))} />
        </>
      )}
      {track.source === "ytdlp" && license && !license.downloadable && license.reason && (
        <div className="px-5 py-2 text-xs text-muted">{license.reason}</div>
      )}
      {track.artistId && <SheetItem icon={<Mic2 />} label="К артисту" onClick={run(() => go(`/artist/${enc(track.artistId!)}`))} />}
      {track.albumId && <SheetItem icon={<Disc3 />} label="К альбому" onClick={run(() => go(`/album/${enc(track.albumId!)}`))} />}
      {track.links && (
        <>
          <div className="mx-5 my-1 h-px bg-line" />
          <SheetItem icon={<ExternalLink />} label="Открыть в Яндекс Музыке" onClick={run(() => openLink(track.links!.yandex))} />
          <SheetItem icon={<ExternalLink />} label="Открыть в Spotify" onClick={run(() => openLink(track.links!.spotify))} />
          <SheetItem icon={<ExternalLink />} label="Открыть в YouTube Music" onClick={run(() => openLink(track.links!.youtube))} />
        </>
      )}
      <div className="mx-5 my-1 h-px bg-line" />
      {track.artistId && <SheetItem icon={<Ban />} label="Не показывать артиста в волне" onClick={run(() => player.blockArtist(track))} />}
      {ctx.playlistId !== undefined && (
        <SheetItem
          danger
          icon={<Trash2 />}
          label="Убрать из плейлиста"
          onClick={run(async () => {
            await api(`/api/playlists/${ctx.playlistId}/tracks/${enc(track.id)}`, { method: "DELETE" });
            ctx.onRemoved?.();
            useLibrary.getState().bump();
            toast("Убрано из плейлиста");
          })}
        />
      )}
      {track.source === "library" && (
        <SheetItem
          danger
          icon={<Trash2 />}
          label="Удалить из моих файлов"
          onClick={run(async () => {
            if (!(await confirmDialog(`Удалить «${track.title}» из библиотеки?`))) return;
            await api(`/api/library/${enc(track.id)}`, { method: "DELETE" });
            await useLibrary.getState().removeDownload(track.id).catch(() => {});
            ctx.onRemoved?.();
            useLibrary.getState().bump();
            toast("Файл удалён");
          })}
        />
      )}
    </div>
  );
}

function PlaylistPicker({ track }: { track: Track }) {
  const close = useUi((s) => s.closeSheet);
  const askText = useUi((s) => s.askText);
  const [lists, setLists] = useState<Playlist[] | null>(null);

  useEffect(() => {
    api<{ items: Playlist[] }>("/api/playlists")
      .then((r) => setLists(r.items))
      .catch(() => setLists([]));
  }, []);

  const add = async (id: number, name: string) => {
    close();
    try {
      const r = await api<{ added: boolean }>(`/api/playlists/${id}/tracks`, { method: "POST", body: { track } });
      haptic.success();
      toast(r.added ? `Добавлено в «${name}»` : `Уже есть в «${name}»`, r.added ? "success" : "info");
      useLibrary.getState().bump();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  const create = async () => {
    const name = await askText("Новый плейлист");
    if (!name) return;
    const { playlist } = await api<{ playlist: Playlist }>("/api/playlists", { method: "POST", body: { name } });
    await add(playlist.id, playlist.name);
  };

  return (
    <div>
      <div className="px-5 pb-2 font-display text-lg font-bold">В плейлист</div>
      <SheetItem icon={<Plus />} label="Создать плейлист" onClick={create} />
      {lists === null && <div className="px-5 py-4 text-sm text-muted">Загружаю…</div>}
      {lists?.map((p) => (
        <button key={p.id} onClick={() => add(p.id, p.name)} className="flex w-full items-center gap-3 px-5 py-2.5 text-left active:bg-white/5">
          <Cover src={p.covers?.[0]} className="h-11 w-11" rounded="rounded-lg" />
          <div className="min-w-0 flex-1">
            <div className="truncate font-semibold">{p.name}</div>
            <div className="text-xs text-muted">{p.count ?? 0} тр.</div>
          </div>
        </button>
      ))}
    </div>
  );
}
