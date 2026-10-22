import { AnimatePresence, motion } from "framer-motion";
import { Lock, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { BottomNav } from "./components/BottomNav";
import { FullPlayer } from "./components/FullPlayer";
import { MiniPlayer } from "./components/MiniPlayer";
import { AccentSync, PromptModal, Toasts } from "./components/Overlays";
import { TrackSheet } from "./components/TrackSheet";
import { Button } from "./components/ui";
import { login } from "./lib/api";
import { backButton, isTelegram } from "./lib/telegram";
import AlbumPage from "./pages/Album";
import ArtistPage from "./pages/Artist";
import CollectionPage from "./pages/Collection";
import DownloadsPage from "./pages/Downloads";
import FavoritesPage from "./pages/Favorites";
import HistoryPage from "./pages/History";
import HomePage from "./pages/Home";
import LibraryFilesPage from "./pages/LibraryFiles";
import PlaylistPage from "./pages/Playlist";
import PlaylistsPage from "./pages/Playlists";
import ReleasesPage from "./pages/Releases";
import SearchPage from "./pages/Search";
import SubscriptionsPage from "./pages/Subscriptions";
import WavePage from "./pages/Wave";
import { useLibrary } from "./store/library";

const ROOT_TABS = ["/", "/search", "/wave", "/collection", "/downloads"];

export default function App() {
  const [state, setState] = useState<"loading" | "ready" | { error: string }>("loading");

  const start = () => {
    setState("loading");
    login()
      .then(() => {
        setState("ready");
        void useLibrary.getState().loadInitial();
      })
      .catch((e) => setState({ error: (e as Error).message }));
  };
  useEffect(start, []);

  if (state === "loading") return <Splash />;
  if (typeof state === "object") return <AuthError message={state.error} onRetry={start} />;
  return <Shell />;
}

function Shell() {
  const location = useLocation();
  const navigate = useNavigate();
  const isRoot = ROOT_TABS.includes(location.pathname);

  // Кнопка «Назад» Telegram на вложенных экранах
  useEffect(() => {
    if (isRoot) return;
    return backButton.show(() => (window.history.length > 1 ? navigate(-1) : navigate("/")));
  }, [isRoot, navigate]);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [location.pathname]);

  return (
    <div className="mx-auto min-h-dvh max-w-xl pt-[env(safe-area-inset-top)]">
      <AccentSync />
      <AnimatePresence mode="wait" initial={false}>
        <motion.main
          key={location.pathname}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          className="pb-player"
        >
          <Routes location={location}>
            <Route path="/" element={<HomePage />} />
            <Route path="/search" element={<SearchPage />} />
            <Route path="/wave" element={<WavePage />} />
            <Route path="/collection" element={<CollectionPage />} />
            <Route path="/collection/favorites" element={<FavoritesPage />} />
            <Route path="/collection/history" element={<HistoryPage />} />
            <Route path="/collection/playlists" element={<PlaylistsPage />} />
            <Route path="/collection/library" element={<LibraryFilesPage />} />
            <Route path="/collection/releases" element={<ReleasesPage />} />
            <Route path="/collection/subscriptions" element={<SubscriptionsPage />} />
            <Route path="/downloads" element={<DownloadsPage />} />
            <Route path="/artist/:id" element={<ArtistPage />} />
            <Route path="/album/:id" element={<AlbumPage />} />
            <Route path="/playlist/:id" element={<PlaylistPage />} />
            <Route path="*" element={<HomePage />} />
          </Routes>
        </motion.main>
      </AnimatePresence>
      <MiniPlayer />
      <BottomNav />
      <FullPlayer />
      <TrackSheet />
      <PromptModal />
      <Toasts />
    </div>
  );
}

function Splash() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-5">
      <motion.div
        className="wave-gradient h-20 w-20 rounded-[28px]"
        animate={{ rotate: [0, 8, -8, 0], scale: [1, 1.05, 1] }}
        transition={{ duration: 2.4, repeat: Infinity }}
      />
      <Loader2 className="h-5 w-5 animate-spin text-muted" />
    </div>
  );
}

function AuthError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-8 text-center">
      <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-surface-2 text-accent">
        <Lock className="h-7 w-7" />
      </div>
      <h1 className="font-display text-xl font-bold">{isTelegram ? "Нет доступа" : "Откройте через Telegram"}</h1>
      <p className="mt-2 max-w-xs text-sm text-muted">
        {isTelegram ? message : "Это личный плеер — он работает только внутри Telegram через вашего бота."}
      </p>
      {!isTelegram && <p className="mt-2 max-w-xs text-xs text-muted/70">{message}</p>}
      <Button className="mt-6" onClick={onRetry}>
        Попробовать снова
      </Button>
    </div>
  );
}
