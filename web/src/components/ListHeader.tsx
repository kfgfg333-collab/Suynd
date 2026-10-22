import { motion } from "framer-motion";
import { Play, Shuffle } from "lucide-react";
import type { ReactNode } from "react";
import type { Track } from "../lib/types";
import { usePlayer } from "../store/player";

/** Кнопки «Играть всё / Перемешать» */
export function PlayButtons({ tracks, title, extra }: { tracks: Track[]; title: string; extra?: ReactNode }) {
  const { playList, playShuffled } = usePlayer.getState();
  const disabled = tracks.length === 0;
  return (
    <div className="flex items-center gap-2 px-4 py-3">
      <motion.button
        whileTap={{ scale: 0.95 }}
        disabled={disabled}
        onClick={() => {
          usePlayer.setState({ shuffle: false });
          playList(tracks, 0, title);
        }}
        className="flex flex-1 items-center justify-center gap-2 rounded-full bg-accent py-3 text-sm font-bold text-black disabled:opacity-40"
      >
        <Play className="h-4 w-4 fill-black" /> Играть всё
      </motion.button>
      <motion.button
        whileTap={{ scale: 0.95 }}
        disabled={disabled}
        onClick={() => playShuffled(tracks, title)}
        className="flex flex-1 items-center justify-center gap-2 rounded-full bg-white/10 py-3 text-sm font-bold disabled:opacity-40"
      >
        <Shuffle className="h-4 w-4" /> Перемешать
      </motion.button>
      {extra}
    </div>
  );
}
