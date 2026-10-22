export type Source = "deezer" | "audius" | "library" | "itunes" | "archive" | "jamendo" | "openverse";

export interface Track {
  id: string; // dz:123 | au:abc | lib:7
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
  links?: { yandex: string; spotify: string; youtube: string };
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
