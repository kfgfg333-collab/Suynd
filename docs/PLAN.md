# Suynd — план проекта

Личный музыкальный Telegram Mini App + бот. Доступ только у одного пользователя (`ALLOWED_USER_ID`).

## 1. Архитектура

```
┌──────────────┐  HTTPS (Bearer-токен)   ┌───────────────────────────┐
│  Mini App    │ ──────────────────────▶ │  server (Fastify)         │
│  web/ (Vite) │ ◀────────────────────── │  ├─ /api/*  REST          │
│  Vercel      │   <audio src=…?t=токен>  │  ├─ бот grammY (polling)  │
└──────────────┘                         │  ├─ node-cron задачи      │
       ▲                                 │  └─ SQLite (Drizzle)      │
       │ кнопка «Открыть»                └──────┬────────────────────┘
┌──────┴───────┐                                │ fetch
│  Telegram    │                       Deezer API · iTunes · Audius API
└──────────────┘                       Telegram Bot API (файлы)
```

* **Вход:** Mini App отправляет `initData` → сервер проверяет HMAC‑SHA256 (ключ = HMAC("WebAppData", BOT_TOKEN)),
  срок `auth_date` (24 ч) и `user.id === ALLOWED_USER_ID` → выдаёт подписанный сессионный токен (7 дней).
  Токен идёт в заголовке `Authorization`, а для `<audio>`/картинок — в `?t=`.
* **Единая модель трека** (`id` с префиксом источника): `dz:123` (Deezer, только каталог), `au:abc` (Audius, полный),
  `ia:…`/`ov:…` (Internet Archive / Openverse, CC), `jm:123` (Jamendo), `yt:<id видео>` (YouTube через yt-dlp),
  `lib:7` (мои файлы, полный). Ссылки на аудио всегда идут через бэкенд (`/api/stream/:id`), потому что превью Deezer
  протухают, а ссылка на файл Telegram содержит токен бота.
* **Скачивание** разрешено только для `lib:*`, CC-источников (`ia:*`, `ov:*`, `jm:*` с разрешением автора), `au:*` с
  `is_downloadable && access.download && !is_download_gated` и `yt:*` с лицензией Creative Commons (проверяется через yt-dlp).
* **YouTube (yt-dlp):** поиск `ytsearch` → треки `yt:*`; перед воспроизведением `--print` с форматом m4a даёт свежую ссылку
  googlevideo, она кэшируется до `expire`; ответ 403/404/410 → одно повторное получение. Процессы: без оболочки, тайм-аут,
  максимум 2 одновременно, очередь 8, вывод до 4 МБ.
  Офлайн: файл качается через `/api/download/:id` и кладётся в IndexedDB (прогресс, размер, удаление).

## 2. Структура

```
server/
  src/
    index.ts            запуск: БД → Fastify → бот → cron
    env.ts              чтение .env
    db/schema.ts        таблицы Drizzle
    db/index.ts         подключение + создание таблиц
    auth.ts             проверка initData, сессионные токены
    providers/          deezer.ts, itunes.ts, audius.ts, links.ts
    services/           tracks.ts (кэш треков), wave.ts, radar.ts, history.ts
    routes/             auth, catalog, library, playlists, wave, media, radar
    bot.ts              grammY: /start, приём аудио, отправка файлов
    jobs.ts             node-cron: радар каждый час, чистка истории
web/
  src/
    lib/                api, telegram, offline (IndexedDB), color, format
    store/              player.ts, library.ts (Zustand)
    components/         BottomNav, MiniPlayer, FullPlayer, TrackRow, …
    pages/              Home, Search, Wave, Collection, Downloads, Artist, Album, Playlist, …
```

## 3. Схема БД (SQLite)

| Таблица | Поля | Зачем |
|---|---|---|
| `tracks` | `id` PK, `source`, `title`, `artist`, `artist_id`, `album`, `album_id`, `cover`, `duration`, `genre`, `bpm`, `full` (0/1), `downloadable` (0/1), `extra` JSON, `updated_at` | кэш метаданных любого трека |
| `library_files` | `id` PK, `file_id`, `file_unique_id` UNIQUE, `file_name`, `mime`, `size`, `cover_path`, `created_at` | мои файлы из бота (трек = `lib:<id>`) |
| `favorites` | `track_id` PK, `created_at` | любимые |
| `plays` | `id` PK, `track_id`, `played_at` | история (≥15 с), чистится старше 3 дней |
| `playlists` | `id` PK, `name`, `created_at`, `updated_at` | плейлисты |
| `playlist_tracks` | `playlist_id`, `track_id`, `position`, PK(playlist_id, track_id) | порядок треков |
| `feedback` | `track_id` PK, `artist_key`, `value` (+1/−1), `created_at` | 👍/👎 в волне |
| `blocked_artists` | `artist_key` PK, `name`, `created_at` | «не показывать артиста» |
| `wave_seen` | `track_id` PK, `seen_at` | что волна уже выдавала (3 дня) |
| `subscriptions` | `artist_key` PK, `source`, `name`, `picture`, `created_at`, `last_checked_at` | подписки радара |
| `releases` | `id` PK (`dz-album:…` / `au:…`), `artist_key`, `title`, `cover`, `release_date`, `kind`, `track_id`, `album_id`, `created_at`, `notified` | найденные новинки |

`artist_key` = `dz:<artistId>` или `au:<userId>`.

## 4. Моя волна (алгоритм)

1. **Семена:** артисты из любимых (вес 3), 👍 (вес 2), подписок (вес 2), истории (вес 1); минус 👎 и заблокированные.
2. **Кандидаты:**
   * «Знакомое» — топ‑треки семенных артистов + любимые, которые давно не играли;
   * «Новое» — похожие артисты Deezer (`/artist/{id}/related`) → их топ + тренды Audius по моим жанрам;
   * «Микс» — 50/50.
3. **Фильтры:** нет в истории/выдаче волны за 3 дня, нет 👎 трека, артист не заблокирован, ≤2 трека одного артиста в пачке.
4. **Настроение:** «Спокойное/Энергичное» — по BPM (Deezer/Audius) и полю `mood` у Audius.
5. Холодный старт — чарт Deezer + тренды Audius. Клиент держит в запасе ≥10 треков и предзагружает следующий.

## 5. Фоновые задачи

* каждый час — радар релизов (Deezer `/artist/{id}/albums`, Audius `/users/{id}/tracks?sort=date`) → уведомление ботом с обложкой;
* каждый час — удаление `plays` и `wave_seen` старше 3 дней.
