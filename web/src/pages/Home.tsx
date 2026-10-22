import { motion } from "framer-motion";
import { ChevronRight, Loader2, Play } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AlbumCard, Carousel, TrackCard } from "../components/Cards";
import { WaveGlyph } from "../components/BottomNav";
import { TrackList } from "../components/TrackRow";
import { CardsSkeleton, Cover, ErrorState, SectionHeader, TrackListSkeleton } from "../components/ui";
import { api, enc } from "../lib/api";
import { formatDate, greeting } from "../lib/format";
import { telegramUserName } from "../lib/telegram";
import type { Album, Release, Track } from "../lib/types";
import { useApi } from "../lib/useApi";
import { useLibrary } from "../store/library";
import { usePlayer } from "../store/player";

const GENRES = ["", "Electronic", "Hip-Hop/Rap", "Pop", "Alternative", "R&B/Soul", "House", "Lo-Fi", "Rock", "Ambient"];

export default function HomePage() {
  const version = useLibrary((s) => s.version);
  const home = useApi<{ chart: Track[]; chartAlbums: Album[]; trending: Track[] }>("/api/home");
  const recent = useApi<{ items: Track[] }>("/api/history/recent", [version]);
  const releases = useApi<{ items: Release[] }>("/api/releases", [version]);
  const name = telegramUserName();

  return (
    <div className="space-y-8 pt-5">
      <div className="px-4">
        <p className="text-sm font-semibold text-muted">{greeting()}{name ? `, ${name}` : ""}</p>
        <h1 className="font-display text-2xl font-bold tracking-tight">Что послушаем?</h1>
      </div>

      <WaveCard />

      {recent.data && recent.data.items.length > 0 && (
        <section>
          <SectionHeader title="Продолжить слушать" action={<MoreLink to="/collection/history" />} />
          <Carousel>
            {recent.data.items.map((_, i) => (
              <TrackCard key={recent.data!.items[i].id} tracks={recent.data!.items} index={i} title="Недавнее" />
            ))}
          </Carousel>
        </section>
      )}

      {releases.data && releases.data.items.length > 0 && (
        <section>
          <SectionHeader title="Новинки подписок" action={<MoreLink to="/collection/releases" />} />
          <Carousel>
            {releases.data.items.slice(0, 12).map((r) => (
              <ReleaseCard key={r.id} release={r} />
            ))}
          </Carousel>
        </section>
      )}

      <section>
        <SectionHeader title="Чарт" />
        {home.error ? (
          <ErrorState message={home.error} onRetry={home.reload} />
        ) : home.loading ? (
          <TrackListSkeleton rows={5} />
        ) : (
          <TrackList tracks={home.data!.chart.slice(0, 10)} title="Чарт" numbered />
        )}
      </section>

      <section>
        <SectionHeader title="Популярные альбомы" />
        {home.loading ? (
          <CardsSkeleton />
        ) : (
          home.data && (
            <Carousel>
              {home.data.chartAlbums.map((a) => (
                <AlbumCard key={a.id} album={a} />
              ))}
            </Carousel>
          )
        )}
      </section>

      <Trending initial={home.data?.trending} loading={home.loading} />
    </div>
  );
}

function MoreLink({ to }: { to: string }) {
  return (
    <Link to={to} className="flex items-center text-xs font-bold text-muted">
      Все <ChevronRight className="h-4 w-4" />
    </Link>
  );
}

function WaveCard() {
  const navigate = useNavigate();
  const isWave = usePlayer((s) => s.context?.kind === "wave");
  const isPlaying = usePlayer((s) => s.isPlaying);
  const loading = usePlayer((s) => s.waveLoading && s.queue.length === 0);
  const { playWave, toggle } = usePlayer.getState();

  return (
    <div className="px-4">
      <motion.div
        whileTap={{ scale: 0.98 }}
        onClick={() => navigate("/wave")}
        className="wave-gradient relative h-48 cursor-pointer overflow-hidden rounded-[28px] p-5"
      >
        <motion.div
          className="absolute -right-10 -top-10 h-48 w-48 rounded-full bg-white/15 blur-2xl"
          animate={{ scale: isWave && isPlaying ? [1, 1.25, 1] : 1 }}
          transition={{ duration: 3, repeat: Infinity }}
        />
        <div className="relative flex h-full flex-col justify-between">
          <div className="flex items-center gap-2">
            <WaveGlyph animate={isWave && isPlaying} size={28} />
            <span className="text-xs font-bold uppercase tracking-[0.2em] text-white/80">Персональный поток</span>
          </div>
          <div className="flex items-end justify-between">
            <div>
              <h2 className="font-display text-3xl font-bold">Моя волна</h2>
              <p className="mt-1 text-sm text-white/80">Бесконечно, под ваш вкус</p>
            </div>
            <motion.button
              whileTap={{ scale: 0.9 }}
              aria-label="Запустить волну"
              onClick={(e) => {
                e.stopPropagation();
                if (isWave) toggle();
                else void playWave();
              }}
              className="flex h-14 w-14 items-center justify-center rounded-full bg-white text-black shadow-xl"
            >
              {loading ? <Loader2 className="h-6 w-6 animate-spin" /> : isWave && isPlaying ? <span className="flex gap-1"><span className="h-5 w-1.5 rounded bg-black" /><span className="h-5 w-1.5 rounded bg-black" /></span> : <Play className="ml-1 h-6 w-6 fill-black" />}
            </motion.button>
          </div>
        </div>
      </motion.div>
    </div>
  );
}

export function ReleaseCard({ release }: { release: Release }) {
  const navigate = useNavigate();
  const open = async () => {
    if (release.albumId) return navigate(`/album/${enc(release.albumId)}`);
    if (!release.trackId) return navigate(`/artist/${enc(release.artistKey)}`);
    // Новый трек Audius — играем его вместе со свежими треками артиста
    try {
      const { latest = [] } = await api<{ latest?: Track[] }>(`/api/artists/${enc(release.artistKey)}`);
      const idx = latest.findIndex((t) => t.id === release.trackId);
      if (idx >= 0) usePlayer.getState().playList(latest, idx, release.artistName);
      else navigate(`/artist/${enc(release.artistKey)}`);
    } catch {
      navigate(`/artist/${enc(release.artistKey)}`);
    }
  };
  return (
    <motion.button whileTap={{ scale: 0.96 }} onClick={open} className="w-36 shrink-0 snap-start text-left">
      <div className="relative">
        <Cover src={release.cover} className="h-36 w-36" rounded="rounded-2xl" />
        <span className="absolute left-2 top-2 rounded-md bg-black/60 px-1.5 py-0.5 text-[10px] font-bold uppercase backdrop-blur">{release.kind}</span>
      </div>
      <div className="mt-2 truncate text-sm font-semibold">{release.title}</div>
      <div className="truncate text-xs text-muted">
        {release.artistName}
        {release.releaseDate ? ` · ${formatDate(release.releaseDate)}` : ""}
      </div>
    </motion.button>
  );
}

function Trending({ initial, loading }: { initial?: Track[]; loading: boolean }) {
  const [genre, setGenre] = useState("");
  const byGenre = useApi<{ items: Track[] }>(genre ? `/api/trending?genre=${enc(genre)}` : null);
  const tracks = genre ? byGenre.data?.items : initial;
  const isLoading = genre ? byGenre.loading : loading;

  return (
    <section>
      <SectionHeader title="Тренды Audius" />
      <div className="no-scrollbar mb-3 flex gap-2 overflow-x-auto px-4">
        {GENRES.map((g) => (
          <button
            key={g || "all"}
            onClick={() => setGenre(g)}
            className={`shrink-0 rounded-full px-3.5 py-1.5 text-xs font-bold transition-colors ${genre === g ? "bg-white text-black" : "bg-white/8 text-white/80"}`}
          >
            {g || "Все"}
          </button>
        ))}
      </div>
      {byGenre.error ? (
        <ErrorState message={byGenre.error} onRetry={byGenre.reload} />
      ) : isLoading || !tracks ? (
        <TrackListSkeleton rows={5} />
      ) : (
        <TrackList tracks={tracks.slice(0, 15)} title={`Тренды${genre ? ` · ${genre}` : ""}`} />
      )}
    </section>
  );
}
