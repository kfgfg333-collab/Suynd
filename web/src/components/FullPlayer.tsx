import { AnimatePresence, motion, Reorder, useDragControls } from "framer-motion";
import {
  Ban,
  Check,
  ChevronDown,
  Download,
  GripVertical,
  Heart,
  ListMusic,
  Loader2,
  MoreHorizontal,
  Pause,
  Play,
  Repeat,
  Repeat1,
  Send,
  SearchCheck,
  Shuffle,
  SkipBack,
  SkipForward,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, enc, mediaUrl } from "../lib/api";
import { formatTime } from "../lib/format";
import { backButton } from "../lib/telegram";
import type { Track } from "../lib/types";
import { useLibrary } from "../store/library";
import { usePlayer, useCurrentTrack, type QueueItem } from "../store/player";
import { toast } from "../store/toast";
import { useUi } from "../store/ui";
import { Cover, IconButton, SourceBadge } from "./ui";

export function FullPlayer() {
  const open = usePlayer((s) => s.fullOpen);
  const track = useCurrentTrack();
  const setFullOpen = usePlayer((s) => s.setFullOpen);
  const [queueOpen, setQueueOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    return backButton.show(() => (queueOpen ? setQueueOpen(false) : setFullOpen(false)));
  }, [open, queueOpen, setFullOpen]);

  useEffect(() => {
    if (!open) setQueueOpen(false);
  }, [open]);

  return (
    <AnimatePresence>
      {open && track && (
        <motion.div
          className="fixed inset-0 z-50 overflow-hidden bg-bg"
          initial={{ y: "100%" }}
          animate={{ y: 0 }}
          exit={{ y: "100%" }}
          transition={{ type: "spring", damping: 32, stiffness: 300 }}
          drag={queueOpen ? false : "y"}
          dragConstraints={{ top: 0, bottom: 0 }}
          dragElastic={{ top: 0, bottom: 0.7 }}
          onDragEnd={(_, info) => {
            if (info.offset.y > 120 || info.velocity.y > 700) setFullOpen(false);
          }}
        >
          <Backdrop cover={track.cover} />
          <div className="relative mx-auto flex h-full max-w-md flex-col px-6 pb-[max(20px,env(safe-area-inset-bottom))] pt-[max(12px,env(safe-area-inset-top))]">
            <Header onClose={() => setFullOpen(false)} track={track} />
            <AnimatePresence mode="wait" initial={false}>
              {queueOpen ? (
                <motion.div key="queue" className="min-h-0 flex-1" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 20 }}>
                  <QueueView />
                </motion.div>
              ) : (
                <motion.div key="art" className="flex min-h-0 flex-1 items-center justify-center py-4" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                  <Artwork track={track} />
                </motion.div>
              )}
            </AnimatePresence>
            <TrackInfo track={track} />
            <Progress track={track} />
            <Controls />
            <BottomActions track={track} queueOpen={queueOpen} onQueue={() => setQueueOpen((v) => !v)} />
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Backdrop({ cover }: { cover: string | null }) {
  const url = mediaUrl(cover);
  return (
    <div className="pointer-events-none absolute inset-0">
      <AnimatePresence>
        {url && (
          <motion.img
            key={url}
            src={url}
            alt=""
            initial={{ opacity: 0 }}
            animate={{ opacity: 0.55 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.8 }}
            className="absolute inset-0 h-full w-full scale-150 object-cover blur-3xl"
          />
        )}
      </AnimatePresence>
      <div
        className="absolute inset-0 transition-[background] duration-700"
        style={{ background: "linear-gradient(180deg, rgb(var(--accent-rgb) / 0.45) 0%, rgb(11 11 16 / 0.75) 45%, #0b0b10 92%)" }}
      />
    </div>
  );
}

function Header({ onClose, track }: { onClose: () => void; track: Track }) {
  const context = usePlayer((s) => s.context);
  const openSheet = useUi((s) => s.openSheet);
  return (
    <div className="flex items-center justify-between py-2">
      <IconButton label="Свернуть" onClick={onClose} className="h-10 w-10">
        <ChevronDown className="h-7 w-7" />
      </IconButton>
      <div className="min-w-0 px-2 text-center">
        <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-white/60">{context?.kind === "wave" ? "Играет волна" : "Сейчас играет"}</div>
        <div className="truncate text-sm font-bold">{context?.title || track.album || ""}</div>
      </div>
      <IconButton label="Ещё" onClick={() => openSheet(track)} className="h-10 w-10">
        <MoreHorizontal className="h-6 w-6" />
      </IconButton>
    </div>
  );
}

function Artwork({ track }: { track: Track }) {
  const isPlaying = usePlayer((s) => s.isPlaying);
  const { next, prev } = usePlayer.getState();
  return (
    <motion.div
      key={track.id}
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: isPlaying ? 1 : 0.88 }}
      transition={{ type: "spring", damping: 20, stiffness: 200 }}
      drag="x"
      dragConstraints={{ left: 0, right: 0 }}
      dragElastic={0.5}
      onDragEnd={(_, info) => {
        if (info.offset.x < -80) next();
        else if (info.offset.x > 80) prev();
      }}
      className="aspect-square w-full max-w-[min(100%,46dvh)]"
    >
      <Cover src={track.cover} className="h-full w-full shadow-[0_30px_80px_-10px_rgb(0_0_0/0.7)]" rounded="rounded-[28px]" />
    </motion.div>
  );
}

function TrackInfo({ track }: { track: Track }) {
  const navigate = useNavigate();
  const liked = useLibrary((s) => s.liked.has(track.id));
  const toggleLike = useLibrary((s) => s.toggleLike);
  const setFullOpen = usePlayer((s) => s.setFullOpen);
  return (
    <div className="flex items-center gap-3 pt-2">
      <div className="min-w-0 flex-1">
        <motion.h2 key={track.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="truncate font-display text-xl font-bold">
          {track.title}
        </motion.h2>
        <div className="mt-1 flex items-center gap-2">
          <SourceBadge track={track} />
          <button
            className="truncate text-[15px] text-white/70"
            onClick={() => {
              if (!track.artistId) return;
              setFullOpen(false);
              navigate(`/artist/${enc(track.artistId)}`);
            }}
          >
            {track.artist}
          </button>
        </div>
      </div>
      <IconButton label="Лайк" onClick={() => toggleLike(track)} className="h-11 w-11">
        <motion.div key={String(liked)} initial={{ scale: liked ? 0.4 : 1 }} animate={{ scale: 1 }} transition={{ type: "spring", stiffness: 500, damping: 12 }}>
          <Heart className={`h-7 w-7 ${liked ? "fill-accent text-accent" : ""}`} />
        </motion.div>
      </IconButton>
    </div>
  );
}

function Progress({ track }: { track: Track }) {
  const currentTime = usePlayer((s) => s.currentTime);
  const duration = usePlayer((s) => s.duration);
  const seek = usePlayer((s) => s.seek);
  const [dragging, setDragging] = useState<number | null>(null);
  const value = dragging ?? currentTime;
  const max = duration || (track.full ? track.duration : 30);
  const pct = max ? (value / max) * 100 : 0;
  return (
    <div className="pt-4">
      <input
        type="range"
        className="seek"
        min={0}
        max={max || 1}
        step={0.1}
        value={value}
        style={{ "--p": `${pct}%` } as React.CSSProperties}
        onChange={(e) => setDragging(Number(e.target.value))}
        onPointerUp={() => {
          if (dragging !== null) seek(dragging);
          setDragging(null);
        }}
        onTouchEnd={() => {
          if (dragging !== null) seek(dragging);
          setDragging(null);
        }}
        onKeyUp={() => {
          if (dragging !== null) seek(dragging);
          setDragging(null);
        }}
        aria-label="Перемотка"
      />
      <div className="flex justify-between text-xs font-semibold text-white/60">
        <span>{formatTime(value)}</span>
        <span>{track.full ? formatTime(max) : `${formatTime(max)} · превью`}</span>
      </div>
    </div>
  );
}

function Controls() {
  const isPlaying = usePlayer((s) => s.isPlaying);
  const buffering = usePlayer((s) => s.buffering);
  const shuffle = usePlayer((s) => s.shuffle);
  const repeat = usePlayer((s) => s.repeat);
  const isWave = usePlayer((s) => s.context?.kind === "wave");
  const { toggle, next, prev, toggleShuffle, cycleRepeat, waveFeedback } = usePlayer.getState();

  return (
    <div className="flex items-center justify-between py-3">
      {isWave ? (
        <IconButton label="Не нравится" onClick={() => waveFeedback(-1)} className="h-12 w-12">
          <ThumbsDown className="h-6 w-6" />
        </IconButton>
      ) : (
        <IconButton label="Перемешать" onClick={toggleShuffle} active={shuffle} className="h-12 w-12">
          <Shuffle className="h-6 w-6" />
        </IconButton>
      )}
      <IconButton label="Предыдущий" onClick={prev} className="h-14 w-14">
        <SkipBack className="h-8 w-8 fill-white text-white" />
      </IconButton>
      <motion.button
        whileTap={{ scale: 0.9 }}
        onClick={toggle}
        aria-label={isPlaying ? "Пауза" : "Играть"}
        className="flex h-[72px] w-[72px] items-center justify-center rounded-full bg-white text-black shadow-[0_10px_40px_rgb(var(--accent-rgb)/0.5)]"
      >
        {buffering && isPlaying ? <Loader2 className="h-8 w-8 animate-spin" /> : isPlaying ? <Pause className="h-8 w-8 fill-black" /> : <Play className="ml-1 h-8 w-8 fill-black" />}
      </motion.button>
      <IconButton label="Следующий" onClick={next} className="h-14 w-14">
        <SkipForward className="h-8 w-8 fill-white text-white" />
      </IconButton>
      {isWave ? (
        <IconButton label="Нравится" onClick={() => waveFeedback(1)} className="h-12 w-12">
          <ThumbsUp className="h-6 w-6" />
        </IconButton>
      ) : (
        <IconButton label="Повтор" onClick={cycleRepeat} active={repeat !== "off"} className="h-12 w-12">
          {repeat === "one" ? <Repeat1 className="h-6 w-6" /> : <Repeat className="h-6 w-6" />}
        </IconButton>
      )}
    </div>
  );
}

function BottomActions({ track, queueOpen, onQueue }: { track: Track; queueOpen: boolean; onQueue: () => void }) {
  const offline = useLibrary((s) => s.offline.has(track.id));
  const progress = useLibrary((s) => s.downloading.get(track.id));
  const { download, removeDownload, sendToChat } = useLibrary.getState();
  const isWave = usePlayer((s) => s.context?.kind === "wave");
  const { playList, blockArtist, findFull } = usePlayer.getState();

  const similar = async () => {
    toast("Ищу похожее…");
    try {
      const { items } = await api<{ items: Track[] }>(`/api/tracks/${enc(track.id)}/similar`);
      if (!items.length) return toast("Похожих треков не нашлось");
      playList([track, ...items], 0, `Похожее на «${track.title}»`);
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  return (
    <div className="flex items-center justify-between px-1 pt-1">
      <IconButton label="Похожее" onClick={similar} className="h-11 w-11">
        <Sparkles className="h-5 w-5" />
      </IconButton>
      {!track.full && (
        <IconButton label="Найти полную версию" onClick={() => findFull(track)} className="h-11 w-11 text-preview">
          <SearchCheck className="h-5 w-5" />
        </IconButton>
      )}
      {isWave && track.artistId && (
        <IconButton label="Не показывать артиста" onClick={() => blockArtist(track)} className="h-11 w-11">
          <Ban className="h-5 w-5" />
        </IconButton>
      )}
      {track.downloadable && (
        <>
          <IconButton
            label={offline ? "Скачано" : "Скачать"}
            active={offline}
            onClick={() => (offline ? removeDownload(track.id).then(() => toast("Удалено из скачанного")) : download(track))}
            className="relative h-11 w-11"
          >
            {progress !== undefined ? <ProgressRing value={progress} /> : offline ? <Check className="h-5 w-5" /> : <Download className="h-5 w-5" />}
          </IconButton>
          <IconButton label="Отправить в чат" onClick={() => sendToChat(track)} className="h-11 w-11">
            <Send className="h-5 w-5" />
          </IconButton>
        </>
      )}
      <IconButton label="Очередь" onClick={onQueue} active={queueOpen} className="h-11 w-11">
        <ListMusic className="h-5 w-5" />
      </IconButton>
    </div>
  );
}

export function ProgressRing({ value, size = 22 }: { value: number; size?: number }) {
  const r = size / 2 - 2;
  const c = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} className="-rotate-90">
      <circle cx={size / 2} cy={size / 2} r={r} stroke="rgb(255 255 255 / 0.2)" strokeWidth="2.5" fill="none" />
      <circle cx={size / 2} cy={size / 2} r={r} stroke="currentColor" strokeWidth="2.5" fill="none" strokeDasharray={c} strokeDashoffset={c * (1 - value)} strokeLinecap="round" />
    </svg>
  );
}

function QueueView() {
  const queue = usePlayer((s) => s.queue);
  const index = usePlayer((s) => s.index);
  const waveLoading = usePlayer((s) => s.waveLoading);
  const context = usePlayer((s) => s.context);
  const { reorderUpcoming } = usePlayer.getState();
  const current = queue[index];
  const upcoming = queue.slice(index + 1);

  return (
    <div className="flex h-full flex-col pt-2">
      {current && (
        <div className="mb-3 flex items-center gap-3 rounded-2xl bg-white/8 p-2.5">
          <Cover src={current.track.cover} className="h-12 w-12" rounded="rounded-lg" />
          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-bold uppercase tracking-widest text-accent">Сейчас</div>
            <div className="truncate font-bold">{current.track.title}</div>
            <div className="truncate text-xs text-white/60">{current.track.artist}</div>
          </div>
        </div>
      )}
      <div className="mb-1 flex items-center justify-between text-xs font-bold uppercase tracking-widest text-white/50">
        <span>Далее</span>
        {context?.kind === "wave" && waveLoading && <Loader2 className="h-4 w-4 animate-spin" />}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto no-scrollbar" onPointerDownCapture={(e) => e.stopPropagation()}>
        {upcoming.length === 0 ? (
          <div className="py-10 text-center text-sm text-white/50">Очередь пуста</div>
        ) : (
          <Reorder.Group axis="y" values={upcoming} onReorder={reorderUpcoming} className="space-y-0.5">
            {upcoming.map((item, i) => (
              <QueueRow key={item.uid} item={item} absIndex={index + 1 + i} />
            ))}
          </Reorder.Group>
        )}
      </div>
    </div>
  );
}

function QueueRow({ item, absIndex }: { item: QueueItem; absIndex: number }) {
  const controls = useDragControls();
  const { playAt, removeFromQueue } = usePlayer.getState();
  return (
    <Reorder.Item value={item} dragListener={false} dragControls={controls} className="flex items-center gap-2 rounded-xl bg-transparent py-1.5" whileDrag={{ scale: 1.02, backgroundColor: "rgba(255,255,255,0.08)" }}>
      <button className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={() => playAt(absIndex)}>
        <Cover src={item.track.cover} className="h-10 w-10" rounded="rounded-lg" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{item.track.title}</div>
          <div className="flex items-center gap-1.5 truncate text-xs text-white/60">
            {item.queued && <span className="font-bold text-accent">в очереди ·</span>}
            <span className="truncate">{item.track.artist}</span>
          </div>
        </div>
      </button>
      <button aria-label="Убрать" onClick={() => removeFromQueue(item.uid)} className="flex h-9 w-9 items-center justify-center text-white/40">
        <X className="h-4 w-4" />
      </button>
      <div onPointerDown={(e) => controls.start(e)} className="flex h-9 w-9 touch-none items-center justify-center text-white/50" aria-label="Перетащить">
        <GripVertical className="h-5 w-5" />
      </div>
    </Reorder.Item>
  );
}
