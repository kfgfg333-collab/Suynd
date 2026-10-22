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
│  Telegram    │      Audius · Jamendo · Internet Archive · Openverse · Deezer (каталог)
└──────────────┘                       Telegram Bot API (файлы)
```

* **Вход:** Mini App отправляет `initData` → сервер проверяет HMAC‑SHA256 (ключ = HMAC("WebAppData", BOT_TOKEN)),
  срок `auth_date` (24 ч) и `user.id === ALLOWED_USER_ID` → выдаёт подписанный сессионный токен (7 дней).
  Токен идёт в заголовке `Authorization`, а для `<audio>`/картинок — в `?t=`.
* **Единая модель трека** (`id` с префиксом источника): `dz:123` (Deezer, только каталог), `au:abc` (Audius),
  `jm:123` (Jamendo), `ia:…`/`ov:…` (Internet Archive / Openverse, CC), `lib:7` (мои файлы). Префикс однозначно задаёт
  источник, поэтому id разных источников не пересекаются. Аудио всегда идёт через бэкенд (`/api/stream/:id`, с Range),
  потому что ссылка на файл Telegram содержит токен бота, а CDN источника может быть заблокирован у пользователя.
* **Провайдеры** (`providers/index.ts`): единый интерфейс `{ source, prefix, enabled, timeoutMs, optional?, search, streamUrl }`.
* **Поиск** (`services/search.ts` + сопоставление `services/match.ts`): каталог Deezer даёт эталон, источники опрашиваются
  параллельно с тайм-аутами, сбойный источник пропускается 30 с; кандидаты сравниваются по названию, исполнителю,
  длительности и версии, поток лучшего проверяется реальным запросом, дубли из других источников — `alternates`.
  Результаты кэшируются (10 мин / 2 мин для пустых), одинаковые одновременные запросы склеиваются.
* **Веб-поиск** (`services/web.ts`): официальные поисковые API (Tavily, Яндекс Search API) → страницы-кандидаты →
  одна проверка страницы как превью ссылки (robots.txt, без внутренних адресов, OpenGraph/JSON-LD) → сопоставление с
  эталоном каталога → один лучший результат. Звук с внешних страниц не извлекается: клиент открывает страницу в браузере.
* **Скачивание** разрешено только для `lib:*`, CC-источников (`ia:*`, `ov:*`, `jm:*` с разрешением автора) и `au:*` с
  `is_downloadable && access.download && !is_download_gated`.
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
    log.ts              JSON-логи без текста запросов и ключей
    providers/          index.ts (реестр), audius, jamendo, archive, openverse, deezer (каталог), links (официальные ссылки)
    services/           search.ts (агрегатор), web.ts (веб-поиск страниц), match.ts (сопоставление), fullOnly.ts (правило «только полные»),
                        tracks.ts (кэш треков), audioCache.ts, importAudio.ts, translit.ts, wave.ts, radar.ts
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
