import { Sparkles } from "lucide-react";
import { Link } from "react-router-dom";
import { Button, EmptyState, ErrorState, PageTitle, Skeleton } from "../components/ui";
import type { Release } from "../lib/types";
import { useApi } from "../lib/useApi";
import { useLibrary } from "../store/library";
import { ReleaseCard } from "./Home";

export default function ReleasesPage() {
  const version = useLibrary((s) => s.version);
  const { data, error, loading, reload } = useApi<{ items: Release[] }>("/api/releases", [version]);

  return (
    <div>
      <PageTitle>Новинки</PageTitle>
      <p className="-mt-2 px-4 pb-4 text-xs text-muted">Радар проверяет ваших артистов каждый час и присылает уведомление в бота.</p>
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
          icon={<Sparkles className="h-7 w-7" />}
          title="Подпишитесь на артистов"
          text="Откройте страницу артиста и нажмите «Следить» — новые релизы появятся здесь."
          action={
            <Link to="/search">
              <Button>Найти артиста</Button>
            </Link>
          }
        />
      ) : (
        <div className="grid grid-cols-2 justify-items-center gap-y-5 px-2 min-[400px]:grid-cols-3">
          {data.items.map((r) => (
            <ReleaseCard key={r.id} release={r} />
          ))}
        </div>
      )}
    </div>
  );
}
