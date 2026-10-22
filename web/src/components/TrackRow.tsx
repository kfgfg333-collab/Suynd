import { motion, useMotionValue, useTransform, type PanInfo } from "framer-motion";
import { Download, Heart, ListPlus, MoreHorizontal } from "lucide-react";
import { memo } from "react";
import { formatTime } from "../lib/format";
import { haptic } from "../lib/telegram";
import type { Track } from "../lib/types";
import { useLibrary } from "../store/library";
import { useCurrentTrack, usePlayer } from "../store/player";
import { useUi } from "../store/ui";
import { Cover, Equalizer, SourceBadge } from "./ui";

interface Props {
  track: Track;
  onPlay: () => void;
  index?: number;
  showCover?: boolean;
  sheetCtx?: { playlistId?: number; onRemoved?: () => void };
  subtitle?: string;
}

const SWIPE = 72;

export const TrackRow = memo(function TrackRow({ track, onPlay, index, showCover = true, sheetCtx, subtitle }: Props) {
  const current = useCurrentTrack();
  const isPlaying = usePlayer((s) => s.isPlaying);
  const liked = useLibrary((s) => s.liked.has(track.id));
  const offline = useLibrary((s) => s.offline.has(track.id));
  const openSheet = useUi((s) => s.openSheet);
  const active = current?.id === track.id;

  const x = useMotionValue(0);
  const hintOpacity = useTransform(x, [0, SWIPE], [0, 1]);
  const hintScale = useTransform(x, [0, SWIPE], [0.6, 1]);

  const onDragEnd = (_: unknown, info: PanInfo) => {
    if (info.offset.x > SWIPE) {
      haptic.impact("medium");
      usePlayer.getState().addToQueue(track);
    }
  };

  return (
    <div className="relative overflow-hidden">
      <motion.div style={{ opacity: hintOpacity, scale: hintScale }} className="absolute inset-y-0 left-5 flex items-center gap-2 text-sm font-bold text-accent">
        <ListPlus className="h-5 w-5" /> В очередь
      </motion.div>
      <motion.div
        drag="x"
        dragDirectionLock
        dragConstraints={{ left: 0, right: 0 }}
        dragElastic={{ left: 0, right: 0.6 }}
        style={{ x }}
        onDragEnd={onDragEnd}
        className="relative flex items-center gap-3 bg-bg px-4 py-2 active:bg-white/[0.03]"
      >
        <button className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={onPlay}>
          {index !== undefined && !showCover && (
            <span className={`w-6 shrink-0 text-center text-sm font-bold ${active ? "text-accent" : "text-muted"}`}>
              {active ? <Equalizer playing={isPlaying} /> : index + 1}
            </span>
          )}
          {showCover && (
            <div className="relative">
              <Cover src={track.cover} className="h-12 w-12" />
              {active && (
                <div className="absolute inset-0 flex items-center justify-center rounded-xl bg-black/50">
                  <Equalizer playing={isPlaying} />
                </div>
              )}
            </div>
          )}
          <div className="min-w-0 flex-1">
            <div className={`truncate text-[15px] font-semibold ${active ? "text-accent" : ""}`}>{track.title}</div>
            <div className="mt-0.5 flex items-center gap-1.5 text-[13px] text-muted">
              <SourceBadge track={track} />
              {offline && <Download className="h-3 w-3 shrink-0 text-full" />}
              <span className="truncate">{subtitle ?? track.artist}</span>
            </div>
          </div>
        </button>
        {liked && <Heart className="h-4 w-4 shrink-0 fill-accent text-accent" />}
        <span className="hidden w-10 shrink-0 text-right text-xs text-muted min-[380px]:block">{formatTime(track.duration)}</span>
        <button
          aria-label="Ещё"
          className="-mr-2 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted active:bg-white/10"
          onClick={() => {
            haptic.impact("light");
            openSheet(track, sheetCtx);
          }}
        >
          <MoreHorizontal className="h-5 w-5" />
        </button>
      </motion.div>
    </div>
  );
});

export function TrackList({
  tracks,
  title,
  numbered,
  sheetCtx,
}: {
  tracks: Track[];
  title?: string;
  numbered?: boolean;
  sheetCtx?: { playlistId?: number; onRemoved?: () => void };
}) {
  const playList = usePlayer((s) => s.playList);
  return (
    <div>
      {tracks.map((t, i) => (
        <TrackRow key={`${t.id}-${i}`} track={t} index={i} showCover={!numbered} sheetCtx={sheetCtx} onPlay={() => playList(tracks, i, title)} />
      ))}
    </div>
  );
}
