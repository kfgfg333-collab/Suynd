import { Bell, BellOff, EyeOff } from "lucide-react";
import { Link } from "react-router-dom";
import { Cover, EmptyState, ErrorState, PageTitle, TrackListSkeleton } from "../components/ui";
import { api, enc } from "../lib/api";
import type { Subscription } from "../lib/types";
import { useApi } from "../lib/useApi";
import { useLibrary } from "../store/library";
import { toast } from "../store/toast";

export default function SubscriptionsPage() {
  const version = useLibrary((s) => s.version);
  const subs = useApi<{ items: Subscription[] }>("/api/subscriptions", [version]);
  const blocked = useApi<{ items: { artistKey: string; name: string }[] }>("/api/blocked", [version]);
  const toggle = useLibrary((s) => s.toggleSubscription);

  const unblock = async (key: string, name: string) => {
    await api(`/api/blocked/${enc(key)}`, { method: "DELETE" });
    blocked.mutate((prev) => ({ items: (prev?.items ?? []).filter((b) => b.artistKey !== key) }));
    toast(`${name} снова может попасть в волну`);
  };

  return (
    <div>
      <PageTitle>Подписки</PageTitle>
      {subs.error ? (
        <ErrorState message={subs.error} onRetry={subs.reload} />
      ) : subs.loading ? (
        <TrackListSkeleton rows={4} />
      ) : !subs.data?.items.length ? (
        <EmptyState icon={<Bell className="h-7 w-7" />} title="Нет подписок" text="Нажмите «Следить» на странице артиста — бот сообщит о новых релизах." />
      ) : (
        subs.data.items.map((s) => (
          <div key={s.artistKey} className="flex items-center gap-3 px-4 py-2">
            <Link to={`/artist/${enc(s.artistKey)}`} className="flex min-w-0 flex-1 items-center gap-3">
              <Cover src={s.picture} className="h-12 w-12" round />
              <div className="min-w-0">
                <div className="truncate font-semibold">{s.name}</div>
                <div className="text-xs text-muted">{s.source === "audius" ? "Audius" : "Deezer"}</div>
              </div>
            </Link>
            <button
              onClick={() => toggle({ id: s.artistKey, name: s.name, picture: s.picture, source: s.source })}
              className="flex items-center gap-1.5 rounded-full bg-white/8 px-3 py-1.5 text-xs font-bold"
            >
              <BellOff className="h-3.5 w-3.5" /> Отписаться
            </button>
          </div>
        ))
      )}

      {blocked.data && blocked.data.items.length > 0 && (
        <section className="mt-8">
          <h2 className="px-4 pb-2 font-display text-base font-bold">Скрыты из волны</h2>
          {blocked.data.items.map((b) => (
            <div key={b.artistKey} className="flex items-center gap-3 px-4 py-2">
              <EyeOff className="h-5 w-5 text-muted" />
              <span className="flex-1 truncate">{b.name}</span>
              <button onClick={() => unblock(b.artistKey, b.name)} className="rounded-full bg-white/8 px-3 py-1.5 text-xs font-bold">
                Вернуть
              </button>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
