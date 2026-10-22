import { SearchCheck } from "lucide-react";
import { formatTime } from "../lib/format";
import type { Track } from "../lib/types";
import { usePlayer } from "../store/player";
import { Cover } from "./ui";

/**
 * Строка каталога (Deezer): у источника только превью, поэтому здесь нет воспроизведения.
 * Нажатие ищет полную версию в подключённых источниках и включает её, только если она подтверждена.
 */
function CatalogRow({ track, index }: { track: Track; index?: number }) {
  const findFull = usePlayer((s) => s.findFull);
  return (
    <button onClick={() => findFull(track)} className="flex w-full items-center gap-3 px-4 py-2 text-left active:bg-white/[0.03]">
      {index !== undefined ? (
        <span className="w-6 shrink-0 text-center text-sm font-bold text-muted">{index + 1}</span>
      ) : (
        <Cover src={track.cover} className="h-12 w-12 opacity-60" />
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate text-[15px] font-semibold text-white/75">{track.title}</div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[13px] text-muted">
          {track.explicit && (
            <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] bg-white/60 text-[10px] font-black text-black">E</span>
          )}
          <span className="truncate">{track.artist}</span>
        </div>
      </div>
      <span className="hidden w-10 shrink-0 text-right text-xs text-muted min-[380px]:block">{formatTime(track.duration)}</span>
      <span className="flex shrink-0 items-center gap-1 rounded-full bg-white/8 px-2.5 py-1.5 text-[11px] font-bold text-white/80">
        <SearchCheck className="h-3.5 w-3.5" /> Найти полную
      </span>
    </button>
  );
}

export function CatalogList({ tracks, numbered }: { tracks: Track[]; numbered?: boolean }) {
  if (!tracks.length) return null;
  return (
    <div>
      <p className="px-4 pb-1 text-xs text-muted">
        Из каталога Deezer: там только 30-секундные фрагменты, поэтому они не играют. Нажмите на трек — поищем полную версию в других источниках.
      </p>
      {tracks.map((t, i) => (
        <CatalogRow key={t.id} track={t} index={numbered ? i : undefined} />
      ))}
    </div>
  );
}
