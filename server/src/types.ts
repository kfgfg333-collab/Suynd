export type Source = "deezer" | "audius" | "library" | "archive" | "jamendo" | "openverse";

/** Официальные страницы трека или поиска в стриминговых сервисах (только ссылки, без аудио) */
export interface OfficialLinks {
  deezer?: string;
  spotify: string;
  yandex: string;
}

export interface Track {
  id: string; // dz:123 | au:abc | jm:1 | ia:… | ov:… | lib:7
  source: Source;
  title: string;
  artist: string;
  artistId: string | null; // dz:27 | au:xyz
  album: string | null;
  albumId: string | null; // dz:302127 | au:playlistId
  cover: string | null; // абсолютный URL или /api/cover/... (клиент добавит токен)
  duration: number; // секунды полной версии
  full: boolean; // false → превью 30 с
  downloadable: boolean;
  genre?: string | null;
  bpm?: number | null;
  mood?: string | null;
  explicit?: boolean;
  releaseDate?: string | null;
  links?: OfficialLinks;
  /** Та же запись в других источниках — плеер переключится на них, если этот поток не заиграет */
  alternates?: Track[];
}

export interface Artist {
  id: string; // dz:27 | au:xyz
  source: "deezer" | "audius";
  name: string;
  picture: string | null;
  fans?: number;
}

export interface Album {
  id: string; // dz:302127
  source: "deezer" | "audius";
  title: string;
  artist: string;
  artistId: string | null;
  cover: string | null;
  releaseDate?: string | null;
  trackCount?: number;
  type?: string;
}
