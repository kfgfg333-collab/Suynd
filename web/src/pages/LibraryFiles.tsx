import { FileAudio } from "lucide-react";
import { PlayButtons } from "../components/ListHeader";
import { TrackList } from "../components/TrackRow";
import { EmptyState, ErrorState, PageTitle, TrackListSkeleton } from "../components/ui";
import { tracksCount } from "../lib/format";
import type { Track } from "../lib/types";
import { useApi } from "../lib/useApi";
import { useLibrary } from "../store/library";

export default function LibraryFilesPage() {
  const version = useLibrary((s) => s.version);
  const { data, error, loading, reload } = useApi<{ items: Track[] }>("/api/library", [version]);
  const bump = useLibrary((s) => s.bump);

  return (
    <div>
      <PageTitle>Мои файлы</PageTitle>
      {error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : loading ? (
        <TrackListSkeleton />
      ) : !data?.items.length ? (
        <EmptyState
          icon={<FileAudio className="h-7 w-7" />}
          title="Пришлите музыку боту"
          text="Отправьте аудиофайл (mp3, m4a, flac…) в чат с ботом — он появится здесь с обложкой из тегов и будет играть целиком."
        />
      ) : (
        <>
          <p className="-mt-2 px-4 text-sm text-muted">{tracksCount(data.items.length)} · играют полностью, можно скачать</p>
          <PlayButtons tracks={data.items} title="Мои файлы" />
          <TrackList tracks={data.items} title="Мои файлы" sheetCtx={{ onRemoved: bump }} />
        </>
      )}
    </div>
  );
}
