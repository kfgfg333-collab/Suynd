import { motion } from "framer-motion";
import { Play } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { enc } from "../lib/api";
import type { Album, Artist, Track } from "../lib/types";
import { useCurrentTrack, usePlayer } from "../store/player";
import { Cover, Equalizer, SourceBadge } from "./ui";

export function Carousel({ children }: { children: ReactNode }) {
  return <div className="no-scrollbar flex snap-x snap-mandatory gap-3 overflow-x-auto scroll-px-4 px-4 pb-1">{children}</div>;
}

export function TrackCard({ tracks, index, title }: { tracks: Track[]; index: number; title?: string }) {
  const t = tracks[index];
  const current = useCurrentTrack();
  const isPlaying = usePlayer((s) => s.isPlaying);
  const active = current?.id === t.id;
  return (
    <motion.button
      whileTap={{ scale: 0.96 }}
      onClick={() => usePlayer.getState().playList(tracks, index, title)}
      className="w-36 shrink-0 snap-start text-left"
    >
      <div className="relative">
        <Cover src={t.cover} className="h-36 w-36" rounded="rounded-2xl" />
        <div className="absolute bottom-2 right-2 flex h-9 w-9 items-center justify-center rounded-full bg-black/55 backdrop-blur">
          {active ? <Equalizer playing={isPlaying} /> : <Play className="ml-0.5 h-4 w-4 fill-white" />}
        </div>
      </div>
      <div className={`mt-2 truncate text-sm font-semibold ${active ? "text-accent" : ""}`}>{t.title}</div>
      <div className="mt-0.5 flex items-center gap-1 text-xs text-muted">
        <SourceBadge track={t} />
        <span className="truncate">{t.artist}</span>
      </div>
    </motion.button>
  );
}

export function AlbumCard({ album, subtitle }: { album: Album; subtitle?: string }) {
  return (
    <Link to={`/album/${enc(album.id)}`} className="w-36 shrink-0 snap-start">
      <motion.div whileTap={{ scale: 0.96 }}>
        <Cover src={album.cover} className="h-36 w-36" rounded="rounded-2xl" />
        <div className="mt-2 truncate text-sm font-semibold">{album.title}</div>
        <div className="truncate text-xs text-muted">{subtitle ?? album.artist}</div>
      </motion.div>
    </Link>
  );
}

export function ArtistCard({ artist }: { artist: Artist }) {
  return (
    <Link to={`/artist/${enc(artist.id)}`} className="w-28 shrink-0 snap-start text-center">
      <motion.div whileTap={{ scale: 0.96 }}>
        <Cover src={artist.picture} className="mx-auto h-28 w-28" round />
        <div className="mt-2 truncate text-sm font-semibold">{artist.name}</div>
        <div className="text-[11px] text-muted">{artist.source === "audius" ? "Audius" : "Артист"}</div>
      </motion.div>
    </Link>
  );
}
