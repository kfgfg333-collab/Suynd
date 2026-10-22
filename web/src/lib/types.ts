export type Source = "deezer" | "audius" | "library" | "archive" | "jamendo" | "openverse";

/** Официальные ссылки (только переход на страницу, без аудио) */
export interface OfficialLinks {
  deezer?: string;
  spotify: string;
  yandex: string;
}

/** Ответ поиска треков: один лучший проверенный результат */
export interface BestResult {
  query: string;
  mode: "track" | "artist";
  best: Track | null;
  more: Track[];
  catalog: { id: string; title: string; artist: string; cover: string | null; duration: number; explicit: boolean } | null;
  links: OfficialLinks | null;
  partial: boolean;
}

export interface Track {
  id: string;
  source: Source;
  title: string;
  artist: string;
  artistId: string | null;
  album: string | null;
  albumId: string | null;
  cover: string | null;
  duration: number;
  full: boolean;
  downloadable: boolean;
  genre?: string | null;
  bpm?: number | null;
  mood?: string | null;
  explicit?: boolean;
  releaseDate?: string | null;
  links?: OfficialLinks;
  /** Та же запись в других источниках: плеер переключится на них, если поток не заиграет */
  alternates?: Track[];
  likedAt?: number;
}

export interface Artist {
  id: string;
  source: "deezer" | "audius";
  name: string;
  picture: string | null;
  fans?: number;
}

export interface Album {
  id: string;
  source: "deezer" | "audius";
  title: string;
  artist: string;
  artistId: string | null;
  cover: string | null;
  releaseDate?: string | null;
  trackCount?: number;
  type?: string;
}

export interface Playlist {
  id: number;
  name: string;
  createdAt: number;
  updatedAt: number;
  count?: number;
  covers?: string[];
}

export interface Release {
  id: string;
  artistKey: string;
  artistName: string;
  title: string;
  cover: string | null;
  releaseDate: string | null;
  kind: string;
  trackId: string | null;
  albumId: string | null;
  link: string | null;
  createdAt: number;
}

export interface Subscription {
  artistKey: string;
  source: "deezer" | "audius";
  name: string;
  picture: string | null;
  createdAt: number;
}

export type WaveMode = "familiar" | "mix" | "new";
export type WaveEnergy = "any" | "calm" | "energetic";
