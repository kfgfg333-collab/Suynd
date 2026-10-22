import { motion } from "framer-motion";
import { Bell, BellRing, Play } from "lucide-react";
import { useParams } from "react-router-dom";
import { AlbumCard, ArtistCard, Carousel } from "../components/Cards";
import { CatalogList } from "../components/CatalogRow";
import { TrackList } from "../components/TrackRow";
import { CardsSkeleton, Cover, ErrorState, SectionHeader, Skeleton, TrackListSkeleton } from "../components/ui";
import { mediaUrl } from "../lib/api";
import { formatFans } from "../lib/format";
import type { Album, Artist, Track } from "../lib/types";
import { useApi } from "../lib/useApi";
import { useLibrary } from "../store/library";
import { usePlayer } from "../store/player";

interface ArtistData {
  artist: Artist;
  top: Track[];
  catalog?: Track[];
  latest?: Track[];
  albums: Album[];
  related: Artist[];
}

export default function ArtistPage() {
  const id = useParams().id!;
  const { data, error, loading, reload } = useApi<ArtistData>(`/api/artists/${encodeURIComponent(id)}`);
  const subscribed = useLibrary((s) => s.subscriptions.has(id));
  const toggleSubscription = useLibrary((s) => s.toggleSubscription);

  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (loading || !data)
    return (
      <div>
        <Skeleton className="h-72 w-full rounded-none" />
        <div className="mt-6">
          <TrackListSkeleton rows={5} />
        </div>
      </div>
    );

  const { artist, top, latest, albums, related, catalog = [] } = data;
  const picture = mediaUrl(artist.picture);

  return (
    <div>
      <div className="relative h-80 overflow-hidden">
        {picture ? <img src={picture} alt="" className="absolute inset-0 h-full w-full object-cover" /> : <Cover src={null} className="absolute inset-0 h-full w-full" rounded="" />}
        <div className="absolute inset-0 bg-gradient-to-b from-black/20 via-bg/40 to-bg" />
        <div className="absolute inset-x-0 bottom-0 px-4 pb-4">
          <p className="text-xs font-bold uppercase tracking-widest text-white/70">{artist.source === "audius" ? "Артист Audius · полные треки" : "Артист"}</p>
          <h1 className="mt-1 font-display text-4xl font-bold leading-tight">{artist.name}</h1>
          {artist.fans ? <p className="mt-1 text-sm text-white/70">{formatFans(artist.fans)}</p> : null}
        </div>
      </div>

      <div className="flex items-center gap-2 px-4 py-3">
        <motion.button
          whileTap={{ scale: 0.95 }}
          disabled={!top.length}
          onClick={() => usePlayer.getState().playList(top, 0, artist.name)}
          className="flex items-center gap-2 rounded-full bg-accent px-6 py-3 text-sm font-bold text-black disabled:opacity-40"
        >
          <Play className="h-4 w-4 fill-black" /> Слушать
        </motion.button>
        <motion.button
          whileTap={{ scale: 0.95 }}
          onClick={() => toggleSubscription(artist)}
          className={`flex items-center gap-2 rounded-full px-5 py-3 text-sm font-bold ${subscribed ? "bg-white text-black" : "bg-white/10"}`}
        >
          {subscribed ? <BellRing className="h-4 w-4" /> : <Bell className="h-4 w-4" />}
          {subscribed ? "Вы следите" : "Следить"}
        </motion.button>
      </div>

      {latest && latest.length > 0 && (
        <section className="mt-4">
          <SectionHeader title="Свежее" />
          <TrackList tracks={latest.slice(0, 5)} title={`${artist.name} · свежее`} />
        </section>
      )}

      <section className="mt-4">
        <SectionHeader title="Полные треки" />
        {top.length ? (
          <TrackList tracks={top.slice(0, 10)} title={artist.name} numbered />
        ) : (
          <p className="px-4 pb-2 text-sm text-muted">Полных треков этого артиста в подключённых источниках нет.</p>
        )}
      </section>

      {catalog.length > 0 && (
        <section className="mt-6">
          <SectionHeader title="Из каталога" />
          <CatalogList tracks={catalog.slice(0, 10)} numbered />
        </section>
      )}

      {albums.length > 0 && (
        <section className="mt-8">
          <SectionHeader title="Релизы" />
          <Carousel>
            {albums.map((a) => (
              <AlbumCard key={a.id} album={a} subtitle={`${a.releaseDate?.slice(0, 4) ?? ""} · ${a.type === "single" ? "Сингл" : a.type === "ep" ? "EP" : "Альбом"}`} />
            ))}
          </Carousel>
        </section>
      )}

      <section className="mt-8">
        <SectionHeader title="Похожие артисты" />
        {related.length ? (
          <Carousel>
            {related.map((a) => (
              <ArtistCard key={a.id} artist={a} />
            ))}
          </Carousel>
        ) : loading ? (
          <CardsSkeleton round />
        ) : (
          <p className="px-4 text-sm text-muted">Не нашли похожих.</p>
        )}
      </section>
    </div>
  );
}
