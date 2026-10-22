import { motion } from "framer-motion";
import { Ban, Loader2, Pause, Play, SkipForward, ThumbsDown, ThumbsUp } from "lucide-react";
import { Cover, IconButton, Segmented, SourceBadge } from "../components/ui";
import type { WaveEnergy, WaveMode } from "../lib/types";
import { usePlayer, useCurrentTrack } from "../store/player";

export default function WavePage() {
  const isWave = usePlayer((s) => s.context?.kind === "wave");
  const isPlaying = usePlayer((s) => s.isPlaying);
  const wave = usePlayer((s) => s.wave);
  const loading = usePlayer((s) => s.waveLoading && (s.context?.kind !== "wave" || s.queue.length === 0));
  const queue = usePlayer((s) => s.queue);
  const index = usePlayer((s) => s.index);
  const track = useCurrentTrack();
  const { playWave, toggle, next, setWave, waveFeedback, blockArtist, playAt, setFullOpen } = usePlayer.getState();
  const active = isWave && track;
  const upcoming = isWave ? queue.slice(index + 1, index + 6) : [];

  return (
    <div className="relative min-h-[80dvh] overflow-hidden">
      <Orb playing={Boolean(isWave && isPlaying)} />

      <div className="relative px-4 pt-6">
        <p className="text-center text-xs font-bold uppercase tracking-[0.25em] text-white/60">Персональный поток</p>
        <h1 className="mt-1 text-center font-display text-3xl font-bold">Моя волна</h1>

        <div className="mt-8 flex flex-col items-center">
          {active ? (
            <motion.button key={track.id} initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} onClick={() => setFullOpen(true)} className="flex flex-col items-center">
              <Cover src={track.cover} className="h-44 w-44 shadow-2xl" rounded="rounded-[28px]" />
              <div className="mt-4 max-w-[80vw] truncate text-lg font-bold">{track.title}</div>
              <div className="mt-1 flex items-center gap-2 text-sm text-white/70">
                <SourceBadge track={track} />
                <span className="truncate">{track.artist}</span>
              </div>
            </motion.button>
          ) : (
            <div className="h-44" />
          )}

          <div className="mt-6 flex items-center gap-4">
            {active && (
              <IconButton label="Не нравится" onClick={() => waveFeedback(-1)} className="h-12 w-12 bg-white/10">
                <ThumbsDown className="h-5 w-5" />
              </IconButton>
            )}
            <motion.button
              whileTap={{ scale: 0.9 }}
              onClick={() => (isWave ? toggle() : void playWave())}
              className="flex h-20 w-20 items-center justify-center rounded-full bg-white text-black shadow-[0_10px_50px_rgb(var(--accent-rgb)/0.6)]"
              aria-label={isWave && isPlaying ? "Пауза" : "Запустить волну"}
            >
              {loading ? <Loader2 className="h-8 w-8 animate-spin" /> : isWave && isPlaying ? <Pause className="h-8 w-8 fill-black" /> : <Play className="ml-1 h-8 w-8 fill-black" />}
            </motion.button>
            {active && (
              <IconButton label="Нравится" onClick={() => waveFeedback(1)} className="h-12 w-12 bg-white/10">
                <ThumbsUp className="h-5 w-5" />
              </IconButton>
            )}
          </div>
          {active && (
            <div className="mt-4 flex gap-2">
              <button onClick={next} className="flex items-center gap-1.5 rounded-full bg-white/8 px-3.5 py-2 text-xs font-bold">
                <SkipForward className="h-4 w-4" /> Дальше
              </button>
              {track.artistId && (
                <button onClick={() => blockArtist(track)} className="flex items-center gap-1.5 rounded-full bg-white/8 px-3.5 py-2 text-xs font-bold">
                  <Ban className="h-4 w-4" /> Не показывать артиста
                </button>
              )}
            </div>
          )}
        </div>

        <div className="mx-auto mt-10 max-w-sm space-y-3">
          <p className="text-center text-xs font-bold uppercase tracking-widest text-white/50">Настроение волны</p>
          <Segmented<WaveMode>
            value={wave.mode}
            onChange={(mode) => setWave({ mode })}
            options={[
              { value: "familiar", label: "Знакомое" },
              { value: "mix", label: "Микс" },
              { value: "new", label: "Новое" },
            ]}
          />
          <Segmented<WaveEnergy>
            value={wave.energy}
            onChange={(energy) => setWave({ energy })}
            options={[
              { value: "calm", label: "Спокойное" },
              { value: "any", label: "Любое" },
              { value: "energetic", label: "Энергичное" },
            ]}
          />
          {!isWave && <p className="pt-1 text-center text-xs text-muted">Чем больше лайков и 👍, тем точнее волна. Треки за последние 3 дня не повторяются.</p>}
        </div>

        {upcoming.length > 0 && (
          <div className="mx-auto mt-8 max-w-sm">
            <p className="mb-2 text-xs font-bold uppercase tracking-widest text-white/50">Дальше в волне</p>
            {upcoming.map((item, i) => (
              <button key={item.uid} onClick={() => playAt(index + 1 + i)} className="flex w-full items-center gap-3 py-1.5 text-left">
                <Cover src={item.track.cover} className="h-10 w-10" rounded="rounded-lg" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold">{item.track.title}</div>
                  <div className="truncate text-xs text-muted">{item.track.artist}</div>
                </div>
                <SourceBadge track={item.track} />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Orb({ playing }: { playing: boolean }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 h-[460px]">
      <motion.div
        className="absolute left-1/2 top-24 h-80 w-80 -translate-x-1/2 rounded-full opacity-70 blur-3xl"
        style={{ background: "radial-gradient(circle, rgb(var(--accent-rgb)) 0%, transparent 70%)" }}
        animate={playing ? { scale: [1, 1.2, 0.95, 1.1, 1], rotate: [0, 30, -20, 0] } : { scale: 1 }}
        transition={{ duration: 6, repeat: Infinity, ease: "easeInOut" }}
      />
      <motion.div
        className="absolute left-[15%] top-40 h-56 w-56 rounded-full bg-[#ff5f6d] opacity-30 blur-3xl"
        animate={playing ? { x: [0, 40, -10, 0], y: [0, -20, 20, 0] } : {}}
        transition={{ duration: 8, repeat: Infinity, ease: "easeInOut" }}
      />
      <motion.div
        className="absolute right-[10%] top-16 h-48 w-48 rounded-full bg-[#3b82f6] opacity-30 blur-3xl"
        animate={playing ? { x: [0, -30, 20, 0], y: [0, 30, -10, 0] } : {}}
        transition={{ duration: 7, repeat: Infinity, ease: "easeInOut" }}
      />
    </div>
  );
}
