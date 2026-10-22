import { AnimatePresence, motion } from "framer-motion";
import { Loader2, Pause, Play, SkipForward } from "lucide-react";
import { useCurrentTrack, usePlayer } from "../store/player";
import { Cover, SourceBadge } from "./ui";

export function MiniPlayer() {
  const track = useCurrentTrack();
  const isPlaying = usePlayer((s) => s.isPlaying);
  const buffering = usePlayer((s) => s.buffering);
  const progress = usePlayer((s) => (s.duration ? s.currentTime / s.duration : 0));
  const { toggle, next, setFullOpen } = usePlayer.getState();

  return (
    <AnimatePresence>
      {track && (
        <motion.div
          initial={{ y: 80, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 80, opacity: 0 }}
          className="fixed inset-x-2 z-40 mx-auto max-w-xl"
          style={{ bottom: "calc(var(--nav-h) + env(safe-area-inset-bottom) + 6px)" }}
        >
          <motion.div
            drag="y"
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0.4, bottom: 0.1 }}
            onDragEnd={(_, info) => {
              if (info.offset.y < -40 || info.velocity.y < -400) setFullOpen(true);
            }}
            onClick={() => setFullOpen(true)}
            className="relative flex h-[var(--mini-h)] cursor-pointer items-center gap-3 overflow-hidden rounded-2xl border border-white/5 px-2.5 shadow-2xl"
            style={{ background: "linear-gradient(90deg, rgb(var(--accent-rgb) / 0.35), rgb(var(--accent-rgb) / 0.12)), #17171f" }}
          >
            <div className="shrink-0">
              <Cover src={track.cover} className="h-11 w-11" rounded="rounded-lg" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-bold">{track.title}</div>
              <div className="flex items-center gap-1.5 text-xs text-white/70">
                <SourceBadge track={track} />
                <span className="truncate">{track.artist}</span>
              </div>
            </div>
            <button
              aria-label={isPlaying ? "Пауза" : "Играть"}
              onClick={(e) => {
                e.stopPropagation();
                toggle();
              }}
              className="flex h-10 w-10 items-center justify-center rounded-full active:bg-white/10"
            >
              {buffering && isPlaying ? (
                <Loader2 className="h-6 w-6 animate-spin" />
              ) : isPlaying ? (
                <Pause className="h-6 w-6 fill-white" />
              ) : (
                <Play className="h-6 w-6 fill-white" />
              )}
            </button>
            <button
              aria-label="Следующий"
              onClick={(e) => {
                e.stopPropagation();
                next();
              }}
              className="flex h-10 w-10 items-center justify-center rounded-full active:bg-white/10"
            >
              <SkipForward className="h-5 w-5 fill-white" />
            </button>
            <div className="absolute inset-x-3 bottom-0 h-[2px] overflow-hidden rounded-full bg-white/10">
              <div className="h-full bg-white" style={{ width: `${progress * 100}%` }} />
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
