import type { OfficialLinks } from "../types.js";

/** Официальные ссылки: страница трека Deezer (если известна) и поиск в Spotify и Яндекс Музыке */
export function officialLinks(artist: string, title: string, deezerId?: string | number | null): OfficialLinks {
  const q = encodeURIComponent(`${artist} ${title}`.trim());
  return {
    ...(deezerId ? { deezer: `https://www.deezer.com/track/${deezerId}` } : {}),
    spotify: `https://open.spotify.com/search/${q}`,
    yandex: `https://music.yandex.ru/search?text=${q}`,
  };
}
