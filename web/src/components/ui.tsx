import { motion } from "framer-motion";
import { AlertTriangle, Music2, RefreshCw } from "lucide-react";
import { useState, type ReactNode } from "react";
import { mediaUrl } from "../lib/api";
import type { Track } from "../lib/types";

export function Cover({
  src,
  alt = "",
  className = "",
  rounded = "rounded-xl",
  round = false,
}: {
  src: string | null | undefined;
  alt?: string;
  className?: string;
  rounded?: string;
  round?: boolean;
}) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const url = mediaUrl(src);
  const shape = round ? "rounded-full" : rounded;
  return (
    <div className={`relative shrink-0 overflow-hidden bg-surface-2 ${shape} ${className}`}>
      {(!url || failed) && (
        <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-accent/40 to-surface-2">
          <Music2 className="h-1/3 w-1/3 text-white/60" />
        </div>
      )}
      {url && !failed && (
        <img
          src={url}
          alt={alt}
          loading="lazy"
          decoding="async"
          draggable={false}
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          className={`h-full w-full object-cover transition-opacity duration-300 ${loaded ? "opacity-100" : "opacity-0"}`}
        />
      )}
    </div>
  );
}

export function SourceBadge({ track, className = "" }: { track: Track; className?: string }) {
  const explicit = track.explicit ? (
    <span title="Explicit — без цензуры" className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] bg-white/80 text-[10px] font-black text-black">
      E
    </span>
  ) : null;
  return (
    <>
      {explicit}
      <SourceBadgeInner track={track} className={className} />
    </>
  );
}

function SourceBadgeInner({ track, className = "" }: { track: Track; className?: string }) {
  return track.full ? (
    <span className={`inline-flex shrink-0 items-center rounded-md bg-full/15 px-1.5 py-px text-[10px] font-bold uppercase tracking-wide text-full ${className}`}>
      полный
    </span>
  ) : (
    <span className={`inline-flex shrink-0 items-center rounded-md bg-preview/15 px-1.5 py-px text-[10px] font-bold uppercase tracking-wide text-preview ${className}`}>
      превью 30с
    </span>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`skeleton rounded-lg ${className}`} />;
}

export function TrackListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="space-y-1 px-4">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 py-2">
          <Skeleton className="h-12 w-12 rounded-xl" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3.5 w-3/5" />
            <Skeleton className="h-3 w-2/5" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function CardsSkeleton({ count = 4, round = false }: { count?: number; round?: boolean }) {
  return (
    <div className="flex gap-3 overflow-hidden px-4">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="w-36 shrink-0 space-y-2">
          <Skeleton className={`h-36 w-36 ${round ? "rounded-full" : "rounded-2xl"}`} />
          <Skeleton className="h-3 w-24" />
        </div>
      ))}
    </div>
  );
}

export function EmptyState({ icon, title, text, action }: { icon: ReactNode; title: string; text?: string; action?: ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex flex-col items-center px-8 py-14 text-center"
    >
      <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-surface-2 text-accent">{icon}</div>
      <h3 className="text-lg font-bold">{title}</h3>
      {text && <p className="mt-1.5 max-w-xs text-sm text-muted">{text}</p>}
      {action && <div className="mt-5">{action}</div>}
    </motion.div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <EmptyState
      icon={<AlertTriangle className="h-7 w-7" />}
      title="Не удалось загрузить"
      text={message}
      action={
        onRetry && (
          <Button onClick={onRetry} variant="secondary">
            <RefreshCw className="h-4 w-4" /> Повторить
          </Button>
        )
      }
    />
  );
}

export function Button({
  children,
  onClick,
  variant = "primary",
  className = "",
  disabled,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "secondary" | "ghost";
  className?: string;
  disabled?: boolean;
}) {
  const styles = {
    primary: "bg-accent text-black",
    secondary: "bg-white/10 text-white",
    ghost: "text-white/80",
  }[variant];
  return (
    <motion.button
      whileTap={{ scale: 0.95 }}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex items-center justify-center gap-2 rounded-full px-5 py-2.5 text-sm font-bold transition-colors disabled:opacity-40 ${styles} ${className}`}
    >
      {children}
    </motion.button>
  );
}

export function IconButton({
  children,
  onClick,
  label,
  className = "",
  active = false,
}: {
  children: ReactNode;
  onClick?: (e: React.MouseEvent) => void;
  label: string;
  className?: string;
  active?: boolean;
}) {
  return (
    <motion.button
      whileTap={{ scale: 0.85 }}
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`flex items-center justify-center rounded-full transition-colors ${active ? "text-accent" : "text-white/80"} ${className}`}
    >
      {children}
    </motion.button>
  );
}

export function SectionHeader({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="mb-3 flex items-end justify-between px-4">
      <h2 className="font-display text-lg font-bold tracking-tight">{title}</h2>
      {action}
    </div>
  );
}

export function PageTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-center justify-between px-4 pb-3 pt-5">
      <h1 className="font-display text-2xl font-bold tracking-tight">{children}</h1>
      {right}
    </div>
  );
}

export function Equalizer({ playing }: { playing: boolean }) {
  return (
    <div className={`eq flex h-4 items-end gap-[2px] ${playing ? "" : "paused"}`}>
      <span />
      <span />
      <span />
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex rounded-full bg-white/8 p-1">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={`relative flex-1 rounded-full px-3 py-1.5 text-xs font-bold transition-colors ${value === o.value ? "text-black" : "text-white/70"}`}
        >
          {value === o.value && (
            <motion.span layoutId={`seg-${options.map((x) => x.value).join()}`} className="absolute inset-0 rounded-full bg-white" transition={{ type: "spring", duration: 0.35 }} />
          )}
          <span className="relative">{o.label}</span>
        </button>
      ))}
    </div>
  );
}
