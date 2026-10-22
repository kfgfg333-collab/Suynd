import { FileAudio, Link2, Loader2, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { PlayButtons } from "../components/ListHeader";
import { TrackList } from "../components/TrackRow";
import { EmptyState, ErrorState, PageTitle, TrackListSkeleton } from "../components/ui";
import { api, uploadFile } from "../lib/api";
import { formatTime, tracksCount } from "../lib/format";
import { haptic } from "../lib/telegram";
import type { Track } from "../lib/types";
import { useApi } from "../lib/useApi";
import { useLibrary } from "../store/library";
import { toast } from "../store/toast";
import { useUi } from "../store/ui";

interface ImportResult {
  track: Track;
  existed: boolean;
  check: { duration: number; container: string; codec: string | null; bitrate: number | null };
}

const MAX_MB = 20;

function describe(r: ImportResult) {
  const { check } = r;
  return `${r.track.artist} — ${r.track.title} · ${formatTime(check.duration)} · ${check.container}${check.bitrate ? ` ${check.bitrate} кбит/с` : ""}`;
}

export default function LibraryFilesPage() {
  const version = useLibrary((s) => s.version);
  const { data, error, loading, reload } = useApi<{ items: Track[] }>("/api/library", [version]);
  const bump = useLibrary((s) => s.bump);
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<{ label: string; progress: number | null } | null>(null);

  const onFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    for (const file of Array.from(files)) {
      if (file.size > MAX_MB * 1024 * 1024) {
        toast(`«${file.name}» больше ${MAX_MB} МБ — Telegram не даст его проигрывать`, "error");
        continue;
      }
      setBusy({ label: file.name, progress: 0 });
      try {
        const r = await uploadFile<ImportResult>("/api/library/upload", file, (p) => setBusy({ label: file.name, progress: p }));
        haptic.success();
        toast(r.existed ? "Этот файл уже был в библиотеке" : `Добавлено: ${describe(r)}`, "success");
      } catch (e) {
        haptic.error();
        toast(`${file.name}: ${(e as Error).message}`, "error");
      }
    }
    setBusy(null);
    if (input.current) input.current.value = "";
    bump();
  };

  const importUrl = async () => {
    const url = await useUi.getState().askText("Прямая ссылка на аудиофайл (.mp3, .m4a, .flac…)");
    if (!url) return;
    setBusy({ label: "Скачиваю и проверяю файл…", progress: null });
    try {
      const r = await api<ImportResult>("/api/library/import-url", { method: "POST", body: { url } });
      haptic.success();
      toast(r.existed ? "Этот файл уже был в библиотеке" : `Добавлено: ${describe(r)}`, "success");
      bump();
    } catch (e) {
      haptic.error();
      toast((e as Error).message, "error");
    } finally {
      setBusy(null);
    }
  };

  const actions = (
    <div className="flex gap-2 px-4 pb-2">
      <input ref={input} type="file" accept="audio/*,.mp3,.m4a,.flac,.ogg,.opus,.wav" multiple hidden onChange={(e) => onFiles(e.target.files)} />
      <button
        disabled={Boolean(busy)}
        onClick={() => input.current?.click()}
        className="flex flex-1 items-center justify-center gap-2 rounded-2xl bg-surface py-3 text-sm font-bold disabled:opacity-50"
      >
        <Upload className="h-4 w-4 text-accent" /> Загрузить файлы
      </button>
      <button disabled={Boolean(busy)} onClick={importUrl} className="flex flex-1 items-center justify-center gap-2 rounded-2xl bg-surface py-3 text-sm font-bold disabled:opacity-50">
        <Link2 className="h-4 w-4 text-accent" /> По ссылке
      </button>
    </div>
  );

  return (
    <div>
      <PageTitle>Мои файлы</PageTitle>
      {actions}
      {busy && (
        <div className="mx-4 mb-3 rounded-2xl bg-surface p-3">
          <div className="flex items-center gap-2 text-sm">
            <Loader2 className="h-4 w-4 animate-spin text-accent" />
            <span className="truncate">{busy.label}</span>
          </div>
          {busy.progress !== null && (
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10">
              <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${Math.round(busy.progress * 100)}%` }} />
            </div>
          )}
        </div>
      )}
      {error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : loading ? (
        <TrackListSkeleton />
      ) : !data?.items.length ? (
        <EmptyState
          icon={<FileAudio className="h-7 w-7" />}
          title="Добавьте свою музыку"
          text={`Загрузите файлы с телефона, вставьте прямую ссылку на аудио или просто отправьте файл боту. До ${MAX_MB} МБ, играют целиком и офлайн.`}
        />
      ) : (
        <>
          <p className="px-4 text-sm text-muted">{tracksCount(data.items.length)} · играют полностью, можно скачать</p>
          <PlayButtons tracks={data.items} title="Мои файлы" />
          <TrackList tracks={data.items} title="Мои файлы" sheetCtx={{ onRemoved: bump }} />
        </>
      )}
    </div>
  );
}
