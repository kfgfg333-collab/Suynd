import { ListMusic } from "lucide-react";
import { Cover } from "./ui";

/** Обложка плейлиста: коллаж из 4 первых треков */
export function PlaylistCollage({ covers, className = "" }: { covers: (string | null)[]; className?: string }) {
  const list = covers.filter(Boolean) as string[];
  if (list.length === 0) {
    return (
      <div className={`flex items-center justify-center rounded-2xl bg-gradient-to-br from-accent/50 to-surface-2 ${className}`}>
        <ListMusic className="h-1/3 w-1/3 text-white/70" />
      </div>
    );
  }
  if (list.length < 4) return <Cover src={list[0]} className={className} rounded="rounded-2xl" />;
  return (
    <div className={`grid grid-cols-2 grid-rows-2 overflow-hidden rounded-2xl ${className}`}>
      {list.slice(0, 4).map((c, i) => (
        <Cover key={i} src={c} className="h-full w-full" rounded="rounded-none" />
      ))}
    </div>
  );
}
