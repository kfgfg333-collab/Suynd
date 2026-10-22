import { create } from "zustand";
import { api, enc, mediaUrl, SOURCE_LABELS, streamUrl } from "../lib/api";
import { getOffline } from "../lib/offline";
import { shuffleArray } from "../lib/format";
import { FULL_UNAVAILABLE, isFullLengthAudio, isFullTrack, onlyFull, planPlayback } from "../lib/fullOnly";
import { haptic } from "../lib/telegram";
import type { Track, WaveEnergy, WaveMode } from "../lib/types";
import { useLibrary } from "./library";
import { toast } from "./toast";

export interface QueueItem {
  uid: string;
  track: Track;
  queued?: boolean; // добавлен вручную «в очередь»
}

type Repeat = "off" | "all" | "one";
interface Context {
  kind: "list" | "wave";
  title: string;
}

interface PlayerState {
  queue: QueueItem[];
  index: number;
  isPlaying: boolean;
  buffering: boolean;
  currentTime: number;
  duration: number;
  repeat: Repeat;
  shuffle: boolean;
  context: Context | null;
  wave: { mode: WaveMode; energy: WaveEnergy };
  waveLoading: boolean;
  fullOpen: boolean;
  unshuffled: QueueItem[] | null;

  current: () => Track | null;
  playList: (tracks: Track[], start?: number, title?: string) => void;
  playShuffled: (tracks: Track[], title?: string) => void;
  playWave: () => Promise<void>;
  playAt: (i: number) => void;
  toggle: () => void;
  next: () => void;
  prev: () => void;
  seek: (t: number) => void;
  addToQueue: (t: Track) => void;
  playNext: (t: Track) => void;
  removeFromQueue: (uid: string) => void;
  reorderUpcoming: (items: QueueItem[]) => void;
  cycleRepeat: () => void;
  toggleShuffle: () => void;
  setWave: (w: Partial<{ mode: WaveMode; energy: WaveEnergy }>) => void;
  setFullOpen: (open: boolean) => void;
  waveFeedback: (value: 1 | -1) => Promise<void>;
  blockArtist: (t: Track) => Promise<void>;
  findFull: (t: Track) => Promise<void>;
}

let uidSeq = 0;
const toItem = (track: Track, queued = false): QueueItem => ({ uid: `q${++uidSeq}`, track, queued });

const WAVE_KEY = "suynd.wave";
function loadWaveSettings(): { mode: WaveMode; energy: WaveEnergy } {
  try {
    return { mode: "mix", energy: "any", ...JSON.parse(localStorage.getItem(WAVE_KEY) ?? "{}") };
  } catch {
    return { mode: "mix", energy: "any" };
  }
}

/* ───────── Аудио-движок ───────── */
export const audio = new Audio();
audio.preload = "auto";
(audio as HTMLAudioElement & { playsInline?: boolean }).playsInline = true;
const preloader = new Audio();
preloader.preload = "auto";
preloader.muted = true;

let blobUrl: string | null = null;
let listened = 0;
let lastTime = 0;
let counted = false;
let errorStreak = 0;
let loadToken = 0;
let retriedId: string | null = null;

/** Почему сервер не отдал поток (удалено, регион, нет yt-dlp…): <audio> сам этого не сообщает */
async function streamProblem(track: Track): Promise<string | null> {
  try {
    const res = await fetch(streamUrl(track), { headers: { range: "bytes=0-1" } });
    if (res.ok) {
      await res.body?.cancel();
      return null;
    }
    const data = await res.json().catch(() => ({}));
    return typeof data.message === "string" ? data.message : null;
  } catch {
    return "нет соединения с сервером";
  }
}

async function loadTrack(track: Track, autoplay: boolean) {
  const token = ++loadToken;
  listened = 0;
  lastTime = 0;
  counted = false;
  retriedId = null;
  if (blobUrl) {
    URL.revokeObjectURL(blobUrl);
    blobUrl = null;
  }
  let src = streamUrl(track);
  if (useLibrary.getState().offline.has(track.id)) {
    const entry = await getOffline(track.id);
    if (token !== loadToken) return;
    if (entry) src = blobUrl = URL.createObjectURL(entry.blob);
  }
  audio.src = src;
  usePlayer.setState({ currentTime: 0, duration: track.duration, buffering: autoplay });
  updateMediaSession(track);
  if (autoplay) {
    audio.play().catch((e) => {
      if (e?.name === "NotAllowedError") usePlayer.setState({ isPlaying: false, buffering: false });
    });
  }
  preloadNext();
}

function preloadNext() {
  const { queue, index } = usePlayer.getState();
  const next = queue[index + 1]?.track;
  if (next && !useLibrary.getState().offline.has(next.id)) {
    preloader.src = streamUrl(next);
    preloader.load();
  }
}

audio.addEventListener("play", () => usePlayer.setState({ isPlaying: true }));
audio.addEventListener("pause", () => usePlayer.setState({ isPlaying: false }));
audio.addEventListener("waiting", () => usePlayer.setState({ buffering: true }));
audio.addEventListener("playing", () => {
  errorStreak = 0;
  usePlayer.setState({ buffering: false, isPlaying: true });
});
audio.addEventListener("durationchange", () => {
  if (Number.isFinite(audio.duration) && audio.duration > 0) usePlayer.setState({ duration: audio.duration });
});
// Последняя линия защиты: если источник прислал обрезок вместо песни — не играем его
audio.addEventListener("loadedmetadata", () => {
  const track = usePlayer.getState().current();
  if (!track || !Number.isFinite(audio.duration)) return;
  if (!isFullLengthAudio(track.duration, audio.duration)) {
    audio.pause();
    audio.removeAttribute("src");
    usePlayer.setState({ isPlaying: false, buffering: false });
    toast(`«${track.title}»: источник отдал фрагмент. ${FULL_UNAVAILABLE}`, "error");
    setTimeout(() => usePlayer.getState().next(), 600);
  }
});
audio.addEventListener("timeupdate", () => {
  const t = audio.currentTime;
  const delta = t - lastTime;
  if (delta > 0 && delta < 2) listened += delta;
  lastTime = t;
  usePlayer.setState({ currentTime: t });
  // Трек засчитывается в историю после 15 секунд прослушивания
  if (!counted && listened >= 15) {
    counted = true;
    const track = usePlayer.getState().current();
    if (track) api("/api/plays", { method: "POST", body: { track } }).catch(() => {});
  }
  if ("mediaSession" in navigator && Number.isFinite(audio.duration) && audio.duration > 0) {
    try {
      navigator.mediaSession.setPositionState({ duration: audio.duration, position: Math.min(t, audio.duration), playbackRate: 1 });
    } catch {
      /* ignore */
    }
  }
});
audio.addEventListener("ended", () => {
  const { repeat } = usePlayer.getState();
  if (repeat === "one") {
    audio.currentTime = 0;
    void audio.play();
    return;
  }
  usePlayer.getState().next();
});
audio.addEventListener("error", () => {
  if (!audio.src) return;
  const track = usePlayer.getState().current();
  usePlayer.setState({ buffering: false, isPlaying: false });
  if (!track) return;
  // Прямая ссылка источника могла истечь посреди трека: сервер возьмёт свежую — один раз продолжаем с того же места
  if (!blobUrl && retriedId !== track.id && lastTime > 1) {
    retriedId = track.id;
    const at = lastTime;
    const token = loadToken;
    audio.src = `${streamUrl(track)}&retry=${Date.now()}`;
    audio.addEventListener("loadedmetadata", () => token === loadToken && (audio.currentTime = at), { once: true });
    audio.play().catch(() => {});
    return;
  }
  errorStreak++;
  const token = loadToken;
  void streamProblem(track).then((reason) => {
    if (token !== loadToken) return;
    if (errorStreak >= 3) {
      toast(reason ? `Не получается воспроизвести: ${reason}` : "Не получается воспроизвести треки. Проверьте интернет.", "error");
      return;
    }
    toast(`«${track.title}»: ${reason ?? "трек недоступен"} — включаю следующий`, "error");
    setTimeout(() => token === loadToken && usePlayer.getState().next(), 900);
  });
});

function updateMediaSession(track: Track) {
  if (!("mediaSession" in navigator)) return;
  const cover = mediaUrl(track.cover);
  navigator.mediaSession.metadata = new MediaMetadata({
    title: track.title,
    artist: track.artist,
    album: track.album ?? "",
    artwork: cover ? [{ src: cover, sizes: "512x512", type: "image/jpeg" }] : [],
  });
}

if ("mediaSession" in navigator) {
  const ms = navigator.mediaSession;
  const set = (a: MediaSessionAction, h: MediaSessionActionHandler) => {
    try {
      ms.setActionHandler(a, h);
    } catch {
      /* не поддерживается */
    }
  };
  set("play", () => void audio.play());
  set("pause", () => audio.pause());
  set("nexttrack", () => usePlayer.getState().next());
  set("previoustrack", () => usePlayer.getState().prev());
  set("seekto", (d) => d.seekTime !== undefined && usePlayer.getState().seek(d.seekTime));
  set("seekbackward", () => usePlayer.getState().seek(audio.currentTime - 10));
  set("seekforward", () => usePlayer.getState().seek(audio.currentTime + 10));
}

/* ───────── Моя волна: подгрузка ───────── */
const WAVE_AHEAD = 10;
let waveRequest: Promise<void> | null = null;

function fetchWave(): Promise<void> {
  waveRequest ??= (async () => {
    usePlayer.setState({ waveLoading: true });
    try {
      const { wave, queue } = usePlayer.getState();
      const { items } = await api<{ items: Track[] }>("/api/wave/next", {
        method: "POST",
        body: { ...wave, exclude: queue.map((q) => q.track.id) },
      });
      const known = new Set(usePlayer.getState().queue.map((q) => q.track.id));
      const fresh = onlyFull(items)
        .filter((t) => !known.has(t.id))
        .map((t) => toItem(t));
      if (usePlayer.getState().context?.kind === "wave") usePlayer.setState({ queue: [...usePlayer.getState().queue, ...fresh] });
    } catch (e) {
      toast(`Волна: ${(e as Error).message}`, "error");
    } finally {
      usePlayer.setState({ waveLoading: false });
      waveRequest = null;
    }
  })();
  return waveRequest;
}

function ensureWaveAhead() {
  const { context, queue, index } = usePlayer.getState();
  if (context?.kind === "wave" && queue.length - index - 1 < WAVE_AHEAD) {
    void fetchWave().then(preloadNext);
  }
}

/* ───────── Стор ───────── */
export const usePlayer = create<PlayerState>((set, get) => ({
  queue: [],
  index: -1,
  isPlaying: false,
  buffering: false,
  currentTime: 0,
  duration: 0,
  repeat: "off",
  shuffle: false,
  context: null,
  wave: loadWaveSettings(),
  waveLoading: false,
  fullOpen: false,
  unshuffled: null,

  current: () => get().queue[get().index]?.track ?? null,

  playList(allTracks, start = 0, title = "") {
    if (!allTracks.length) return;
    // Только полные треки: превью не попадают в очередь, а на «не полный» трек плеер не стартует
    const plan = planPlayback(allTracks, start);
    if (!plan) {
      haptic.error();
      toast(FULL_UNAVAILABLE, "error");
      return;
    }
    const tracks = plan.queue;
    start = plan.index;
    haptic.impact("light");
    const cur = get().current();
    // Нажали на уже играющий трек — просто пауза/плей
    if (cur && cur.id === tracks[start]?.id && get().context?.kind === "list" && get().queue.length === tracks.length) {
      get().toggle();
      return;
    }
    let items = tracks.map((t) => toItem(t));
    let index = start;
    if (get().shuffle) {
      const first = items[start];
      items = [first, ...shuffleArray(items.filter((_, i) => i !== start))];
      index = 0;
    }
    set({ queue: items, index, context: { kind: "list", title }, unshuffled: null });
    void loadTrack(items[index].track, true);
  },

  playShuffled(allTracks, title = "") {
    const tracks = onlyFull(allTracks);
    if (!tracks.length) return toast(FULL_UNAVAILABLE, "error");
    const shuffled = shuffleArray(tracks);
    set({ shuffle: false });
    get().playList(shuffled, 0, title);
    set({ shuffle: true, unshuffled: tracks.map((t) => toItem(t)) });
  },

  async playWave() {
    haptic.impact("medium");
    set({ queue: [], index: -1, context: { kind: "wave", title: "Моя волна" }, shuffle: false, unshuffled: null, repeat: "off" });
    audio.pause();
    await fetchWave();
    if (!get().queue.length) return;
    set({ index: 0 });
    void loadTrack(get().queue[0].track, true);
    ensureWaveAhead(); // сразу подгружаем следующие 10, чтобы не было пауз
  },

  playAt(i) {
    const item = get().queue[i];
    if (!item) return;
    set({ index: i });
    void loadTrack(item.track, true);
    ensureWaveAhead();
  },

  toggle() {
    if (get().index < 0) return;
    haptic.impact("light");
    if (audio.paused) {
      if (!audio.src) void loadTrack(get().current()!, true);
      else void audio.play().catch(() => {});
    } else audio.pause();
  },

  next() {
    const { queue, index, repeat, context } = get();
    if (index + 1 < queue.length) {
      const q = queue.map((x, i) => (i === index + 1 ? { ...x, queued: false } : x));
      set({ queue: q });
      get().playAt(index + 1);
    } else if (context?.kind === "wave") {
      void fetchWave().then(() => get().index + 1 < get().queue.length && get().playAt(get().index + 1));
    } else if (repeat === "all" && queue.length) {
      get().playAt(0);
    } else {
      audio.pause();
      audio.currentTime = 0;
    }
  },

  prev() {
    if (audio.currentTime > 4 || get().index === 0) {
      get().seek(0);
      return;
    }
    get().playAt(get().index - 1);
  },

  seek(t) {
    const d = Number.isFinite(audio.duration) ? audio.duration : get().duration;
    audio.currentTime = Math.max(0, Math.min(t, d || t));
    set({ currentTime: audio.currentTime });
  },

  addToQueue(t) {
    if (!isFullTrack(t)) return toast(FULL_UNAVAILABLE, "error");
    const { queue, index } = get();
    if (index < 0) {
      get().playList([t], 0);
      return;
    }
    // Ставим после уже добавленных вручную треков
    let pos = index + 1;
    while (queue[pos]?.queued) pos++;
    const q = [...queue];
    q.splice(pos, 0, toItem(t, true));
    set({ queue: q });
    haptic.success();
    toast(`«${t.title}» — в очереди`);
    if (pos === index + 1) preloadNext();
  },

  playNext(t) {
    if (!isFullTrack(t)) return toast(FULL_UNAVAILABLE, "error");
    const { queue, index } = get();
    if (index < 0) {
      get().playList([t], 0);
      return;
    }
    const q = [...queue];
    q.splice(index + 1, 0, toItem(t, true));
    set({ queue: q });
    toast(`«${t.title}» заиграет следующим`);
    preloadNext();
  },

  removeFromQueue(uid) {
    const { queue, index } = get();
    const i = queue.findIndex((q) => q.uid === uid);
    if (i < 0 || i === index) return;
    set({ queue: queue.filter((q) => q.uid !== uid), index: i < index ? index - 1 : index });
    ensureWaveAhead();
  },

  reorderUpcoming(items) {
    const { queue, index } = get();
    set({ queue: [...queue.slice(0, index + 1), ...items] });
    preloadNext();
  },

  cycleRepeat() {
    const order: Repeat[] = ["off", "all", "one"];
    set({ repeat: order[(order.indexOf(get().repeat) + 1) % 3] });
    haptic.select();
  },

  toggleShuffle() {
    const { shuffle, queue, index, unshuffled } = get();
    haptic.select();
    if (!shuffle) {
      const upcoming = shuffleArray(queue.slice(index + 1));
      set({ shuffle: true, unshuffled: queue, queue: [...queue.slice(0, index + 1), ...upcoming] });
    } else {
      // Возвращаем исходный порядок, продолжая с текущего трека
      const cur = queue[index];
      if (unshuffled && cur) {
        const pos = unshuffled.findIndex((q) => q.uid === cur.uid || q.track.id === cur.track.id);
        if (pos >= 0) {
          const restored = [...unshuffled];
          restored[pos] = cur;
          set({ shuffle: false, unshuffled: null, queue: restored, index: pos });
          preloadNext();
          return;
        }
      }
      set({ shuffle: false, unshuffled: null });
    }
    preloadNext();
  },

  setWave(w) {
    const wave = { ...get().wave, ...w };
    set({ wave });
    try {
      localStorage.setItem(WAVE_KEY, JSON.stringify(wave));
    } catch {
      /* ignore */
    }
    haptic.select();
    // Настроение поменялось — пересобираем «хвост» волны
    if (get().context?.kind === "wave") {
      set({ queue: get().queue.slice(0, get().index + 2) });
      ensureWaveAhead();
    }
  },

  setFullOpen(open) {
    set({ fullOpen: open });
  },

  async waveFeedback(value) {
    const track = get().current();
    if (!track) return;
    value > 0 ? haptic.success() : haptic.impact("medium");
    api("/api/feedback", { method: "POST", body: { track, value } }).catch(() => {});
    if (value < 0) {
      toast("Понял, такое реже 👌");
      // Пересобираем будущие треки с учётом оценки
      if (get().context?.kind === "wave") set({ queue: get().queue.slice(0, get().index + 1) });
      get().next();
    } else {
      toast("Буду ставить похожее чаще");
      if (get().context?.kind === "wave") {
        set({ queue: get().queue.slice(0, get().index + 3) });
        ensureWaveAhead();
      }
    }
  },

  /** Ищет полную версию превью в легальных полных источниках и подменяет её в очереди */
  async findFull(track) {
    toast(`Ищу полную версию «${track.title}»…`);
    try {
      const r = await api<{ track: Track | null; checked: { source: string; title: string; ok: boolean }[] }>(`/api/tracks/${enc(track.id)}/full`);
      if (!r.track) {
        haptic.error();
        toast(
          r.checked.length
            ? `${FULL_UNAVAILABLE}: похожие записи нашлись, но ни одна не прошла проверку аудио`
            : `${FULL_UNAVAILABLE} в подключённых источниках (Audius, Jamendo, Internet Archive, Openverse, YouTube, ваши файлы)`,
          "error",
        );
        return;
      }
      const found = r.track;
      if (!isFullTrack(found)) {
        toast(FULL_UNAVAILABLE, "error");
        return;
      }
      const { index } = get();
      if (index < 0 || !get().isPlaying) get().playList([found], 0, `${found.artist} — ${found.title}`);
      else get().playNext(found);
      haptic.success();
      toast(`Полная версия: ${SOURCE_LABELS[found.source]}`, "success");
    } catch (e) {
      toast((e as Error).message, "error");
    }
  },

  async blockArtist(track) {
    if (!track.artistId) return;
    try {
      await api("/api/blocked", { method: "POST", body: { artistId: track.artistId, name: track.artist } });
      haptic.success();
      toast(`${track.artist} больше не появится в волне`);
      const { queue, index } = get();
      const filtered = queue.filter((q, i) => i <= index || q.track.artistId !== track.artistId);
      set({ queue: filtered });
      if (get().current()?.artistId === track.artistId) get().next();
      ensureWaveAhead();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  },
}));

export const useCurrentTrack = () => usePlayer((s) => s.queue[s.index]?.track ?? null);
