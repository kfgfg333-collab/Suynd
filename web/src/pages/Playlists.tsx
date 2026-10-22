import { motion } from "framer-motion";
import { ListMusic, Plus } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { PlaylistCollage } from "../components/PlaylistCollage";
import { Button, EmptyState, ErrorState, PageTitle, Skeleton } from "../components/ui";
import { api } from "../lib/api";
import { tracksCount } from "../lib/format";
import type { Playlist } from "../lib/types";
import { useApi } from "../lib/useApi";
import { useLibrary } from "../store/library";
import { useUi } from "../store/ui";

export default function PlaylistsPage() {
  const version = useLibrary((s) => s.version);
  const { data, error, loading, reload } = useApi<{ items: Playlist[] }>("/api/playlists", [version]);
  const navigate = useNavigate();

  const create = async () => {
    const name = await useUi.getState().askText("Новый плейлист");
    if (!name) return;
    const { playlist } = await api<{ playlist: Playlist }>("/api/playlists", { method: "POST", body: { name } });
    useLibrary.getState().bump();
    navigate(`/playlist/${playlist.id}`);
  };

  return (
    <div>
      <PageTitle
        right={
          <motion.button whileTap={{ scale: 0.9 }} onClick={create} aria-label="Создать плейлист" className="flex h-10 w-10 items-center justify-center rounded-full bg-accent text-black">
            <Plus className="h-5 w-5" />
          </motion.button>
        }
      >
        Плейлисты
      </PageTitle>
      {error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : loading ? (
        <div className="grid grid-cols-2 gap-3 px-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="aspect-square w-full rounded-2xl" />
          ))}
        </div>
      ) : !data?.items.length ? (
        <EmptyState
          icon={<ListMusic className="h-7 w-7" />}
          title="Плейлистов пока нет"
          text="Соберите музыку под настроение. Добавлять треки можно через меню «⋯»."
          action={
            <Button onClick={create}>
              <Plus className="h-4 w-4" /> Создать плейлист
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-2 gap-x-3 gap-y-5 px-4">
          {data.items.map((p) => (
            <Link key={p.id} to={`/playlist/${p.id}`}>
              <motion.div whileTap={{ scale: 0.97 }}>
                <PlaylistCollage covers={p.covers ?? []} className="aspect-square w-full" />
                <div className="mt-2 truncate text-sm font-semibold">{p.name}</div>
                <div className="text-xs text-muted">{tracksCount(p.count ?? 0)}</div>
              </motion.div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
