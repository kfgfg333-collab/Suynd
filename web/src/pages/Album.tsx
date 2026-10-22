import { Link, useParams } from "react-router-dom";
import { PlayButtons } from "../components/ListHeader";
import { TrackList } from "../components/TrackRow";
import { Cover, EmptyState, ErrorState, Skeleton, TrackListSkeleton } from "../components/ui";
import { enc } from "../lib/api";
import { formatDate, tracksCount } from "../lib/format";
import type { Album, Track } from "../lib/types";
import { useApi } from "../lib/useApi";
import { Disc3 } from "lucide-react";

export default function AlbumPage() {
  const id = useParams().id!;
  const { data, error, loading, reload } = useApi<{ album: Album; tracks: Track[] }>(`/api/albums/${encodeURIComponent(id)}`);

  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (loading || !data)
    return (
      <div className="px-4 pt-6">
        <Skeleton className="mx-auto h-56 w-56 rounded-3xl" />
        <Skeleton className="mx-auto mt-4 h-6 w-48" />
        <div className="mt-6">
          <TrackListSkeleton />
        </div>
      </div>
    );

  const { album, tracks } = data;
  return (
    <div>
      <div className="relative overflow-hidden">
        <div className="absolute inset-0 opacity-50">
          <Cover src={album.cover} className="h-full w-full scale-125 blur-3xl" rounded="" />
        </div>
        <div className="absolute inset-0 bg-gradient-to-b from-transparent to-bg" />
        <div className="relative flex flex-col items-center px-4 pb-2 pt-6 text-center">
          <Cover src={album.cover} className="h-56 w-56 shadow-2xl" rounded="rounded-3xl" />
          <h1 className="mt-4 font-display text-2xl font-bold">{album.title}</h1>
          {album.artistId ? (
            <Link to={`/artist/${enc(album.artistId)}`} className="mt-1 font-semibold text-accent">
              {album.artist}
            </Link>
          ) : (
            <span className="mt-1 text-muted">{album.artist}</span>
          )}
          <p className="mt-1 text-xs text-muted">
            {[album.type === "single" ? "Сингл" : album.type === "playlist" ? "Плейлист" : "Альбом", formatDate(album.releaseDate), tracksCount(tracks.length)].filter(Boolean).join(" · ")}
          </p>
        </div>
      </div>
      <PlayButtons tracks={tracks} title={album.title} />
      {tracks.length ? (
        <TrackList tracks={tracks} title={album.title} numbered={album.source === "deezer"} />
      ) : (
        <EmptyState icon={<Disc3 className="h-7 w-7" />} title="Треки недоступны" text="Этот релиз нельзя прослушать в вашем регионе или он ещё не вышел." />
      )}
    </div>
  );
}
