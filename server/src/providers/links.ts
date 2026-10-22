export function externalLinks(artist: string, title: string) {
  const q = encodeURIComponent(`${artist} ${title}`);
  return {
    yandex: `https://music.yandex.ru/search?text=${q}`,
    spotify: `https://open.spotify.com/search/${q}`,
    youtube: `https://music.youtube.com/search?q=${q}`,
  };
}
