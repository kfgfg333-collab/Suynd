import { motion } from "framer-motion";
import { Bell, ChevronRight, Clock, FileAudio, Heart, ListMusic, Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { PlaylistCollage } from "../components/PlaylistCollage";
import { PageTitle, SectionHeader } from "../components/ui";
import { tracksCount } from "../lib/format";
import type { Playlist } from "../lib/types";
import { useApi } from "../lib/useApi";
import { useLibrary } from "../store/library";

interface Summary {
  favorites: number;
  playlists: number;
  library: number;
  subscriptions: number;
  history: number;
  newReleases: number;
}

export default function CollectionPage() {
  const version = useLibrary((s) => s.version);
  const { data } = useApi<Summary>("/api/collection/summary", [version]);
  const playlists = useApi<{ items: Playlist[] }>("/api/playlists", [version]);

  return (
    <div>
      <PageTitle>Коллекция</PageTitle>
      <div className="px-4">
        <Link to="/collection/favorites">
          <motion.div
            whileTap={{ scale: 0.98 }}
            className="relative flex h-32 items-end overflow-hidden rounded-3xl p-5"
            style={{ background: "linear-gradient(135deg, rgb(var(--accent-rgb)) 0%, #ff5f6d 120%)" }}
          >
            <Heart className="absolute right-4 top-4 h-16 w-16 fill-white/25 text-white/0" />
            <div>
              <div className="font-display text-2xl font-bold text-white">Любимые</div>
              <div className="text-sm font-semibold text-white/85">{data ? tracksCount(data.favorites) : "…"}</div>
            </div>
          </motion.div>
        </Link>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 px-4">
        <Tile to="/collection/history" icon={<Clock />} title="История" sub={data ? `${data.history} за 3 дня` : ""} />
        <Tile to="/collection/library" icon={<FileAudio />} title="Мои файлы" sub={data ? tracksCount(data.library) : ""} />
        <Tile to="/collection/releases" icon={<Sparkles />} title="Новинки" sub={data ? (data.newReleases ? `${data.newReleases} за месяц` : "радар релизов") : ""} />
        <Tile to="/collection/subscriptions" icon={<Bell />} title="Подписки" sub={data ? `${data.subscriptions} артистов` : ""} />
      </div>

      <section className="mt-8">
        <SectionHeader
          title="Плейлисты"
          action={
            <Link to="/collection/playlists" className="flex items-center text-xs font-bold text-muted">
              Все <ChevronRight className="h-4 w-4" />
            </Link>
          }
        />
        {playlists.data && playlists.data.items.length === 0 ? (
          <Link to="/collection/playlists" className="mx-4 flex items-center gap-3 rounded-2xl bg-surface p-4">
            <ListMusic className="h-6 w-6 text-accent" />
            <span className="text-sm font-semibold">Создайте первый плейлист</span>
          </Link>
        ) : (
          <div className="grid grid-cols-2 gap-3 px-4">
            {playlists.data?.items.slice(0, 4).map((p) => (
              <Link key={p.id} to={`/playlist/${p.id}`}>
                <PlaylistCollage covers={p.covers ?? []} className="aspect-square w-full" />
                <div className="mt-2 truncate text-sm font-semibold">{p.name}</div>
                <div className="text-xs text-muted">{tracksCount(p.count ?? 0)}</div>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function Tile({ to, icon, title, sub }: { to: string; icon: ReactNode; title: string; sub: string }) {
  return (
    <Link to={to}>
      <motion.div whileTap={{ scale: 0.97 }} className="flex h-24 flex-col justify-between rounded-2xl bg-surface p-4">
        <span className="text-accent [&>svg]:h-5 [&>svg]:w-5">{icon}</span>
        <div>
          <div className="font-bold">{title}</div>
          <div className="truncate text-xs text-muted">{sub}</div>
        </div>
      </motion.div>
    </Link>
  );
}
