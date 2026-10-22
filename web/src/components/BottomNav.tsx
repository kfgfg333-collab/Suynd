import { motion } from "framer-motion";
import { Download, Home, Library, Search } from "lucide-react";
import { NavLink, useLocation } from "react-router-dom";
import { haptic } from "../lib/telegram";
import { usePlayer } from "../store/player";

const tabs = [
  { to: "/", label: "Главная", icon: Home },
  { to: "/search", label: "Поиск", icon: Search },
  { to: "/wave", label: "Волна", icon: null },
  { to: "/collection", label: "Коллекция", icon: Library },
  { to: "/downloads", label: "Скачанное", icon: Download },
];

export function BottomNav() {
  const { pathname } = useLocation();
  const waveActive = usePlayer((s) => s.context?.kind === "wave" && s.isPlaying);

  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-bg/85 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl">
      <div className="mx-auto flex h-[var(--nav-h)] max-w-xl items-center justify-around px-2">
        {tabs.map((t) => {
          const active = t.to === "/" ? pathname === "/" : pathname.startsWith(t.to);
          if (!t.icon) {
            return (
              <NavLink key={t.to} to={t.to} onClick={() => haptic.impact("medium")} className="-mt-6 flex flex-col items-center" aria-label="Моя волна">
                <motion.div
                  whileTap={{ scale: 0.9 }}
                  className="wave-gradient relative flex h-14 w-14 items-center justify-center rounded-full shadow-[0_8px_30px_rgb(var(--accent-rgb)/0.45)] ring-4 ring-bg"
                >
                  <WaveGlyph animate={waveActive} />
                </motion.div>
                <span className={`mt-0.5 text-[10px] font-bold ${active ? "text-white" : "text-muted"}`}>Волна</span>
              </NavLink>
            );
          }
          const Icon = t.icon;
          return (
            <NavLink key={t.to} to={t.to} onClick={() => haptic.select()} className="relative flex w-16 flex-col items-center gap-1 py-1">
              <Icon className={`h-[22px] w-[22px] transition-colors ${active ? "text-white" : "text-muted"}`} strokeWidth={active ? 2.4 : 2} />
              <span className={`text-[10px] font-bold transition-colors ${active ? "text-white" : "text-muted"}`}>{t.label}</span>
              {active && <motion.span layoutId="nav-dot" className="absolute -top-1 h-1 w-1 rounded-full bg-accent" />}
            </NavLink>
          );
        })}
      </div>
    </nav>
  );
}

export function WaveGlyph({ animate, size = 26 }: { animate?: boolean; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
      <motion.path
        d="M3 16c3-8 6-8 9 0s6 8 9 0 6-8 8 0"
        stroke="white"
        strokeWidth="3"
        strokeLinecap="round"
        animate={animate ? { pathLength: [0.6, 1, 0.6], opacity: [0.85, 1, 0.85] } : { pathLength: 1 }}
        transition={animate ? { duration: 1.6, repeat: Infinity, ease: "easeInOut" } : undefined}
      />
    </svg>
  );
}
