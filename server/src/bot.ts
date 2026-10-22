import { Bot, InlineKeyboard, InputFile, Keyboard, type Context } from "grammy";
import type { Audio, Document } from "grammy/types";
import { parseBuffer } from "music-metadata";
import fs from "node:fs";
import path from "node:path";
import { coversDir, db, schema } from "./db/index.js";
import { eq } from "drizzle-orm";
import { env } from "./env.js";
import { runRadar, type Notifier } from "./services/radar.js";
import { getTracks, upsertTracks } from "./services/tracks.js";
import type { Track } from "./types.js";
import { TG_DOWNLOAD_LIMIT, telegramFileUrl } from "./telegramFiles.js";
import { UpstreamError } from "./http.js";
import { MIN_FULL_SEC } from "./services/fullOnly.js";
import { SHORT_FRAGMENT } from "./services/importAudio.js";

let bot: Bot | null = null;

export function getBot(): Bot {
  if (!bot) bot = new Bot(env.botToken);
  return bot;
}

const webAppAvailable = () => env.webappUrl.startsWith("https://");

function openButton(text = "🎧 Открыть плеер", path = "") {
  return webAppAvailable() ? new InlineKeyboard().webApp(text, `${env.webappUrl}${path}`) : undefined;
}

const AUDIO_EXT = /\.(mp3|m4a|aac|ogg|oga|opus|flac|wav)$/i;

function splitFileName(name?: string) {
  const base = (name ?? "").replace(AUDIO_EXT, "").replace(/_/g, " ").trim();
  const m = base.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  return m ? { artist: m[1].trim(), title: m[2].trim() } : { artist: null, title: base || null };
}

async function downloadTelegramFile(fileId: string): Promise<Buffer> {
  const res = await fetch(await telegramFileUrl(fileId), { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`Telegram вернул ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Сохраняет аудио из Telegram в «Мои файлы»: теги, обложка, длительность.
 * buffer — уже скачанный файл (при импорте из приложения), иначе скачаем сами.
 */
async function storeLibraryFile(file: Audio | Document, buffer?: Buffer): Promise<{ track: Track; existed: boolean }> {
  const exists = db.select().from(schema.libraryFiles).where(eq(schema.libraryFiles.fileUniqueId, file.file_unique_id)).get();
  if (exists) {
    const [track] = getTracks([`lib:${exists.id}`]);
    if (track) return { track, existed: true };
  }
  const isAudio = "duration" in file;
  const guess = splitFileName(file.file_name);
  let title = (isAudio && file.title) || guess.title || "Без названия";
  let artist = (isAudio && file.performer) || guess.artist || "Неизвестный артист";
  let album: string | null = null;
  let genre: string | null = null;
  let duration = isAudio ? file.duration : 0;
  let cover: { data: Uint8Array; ext: string } | null = null;

  // Теги и обложка из самого файла (Bot API отдаёт файлы до 20 МБ)
  if (buffer || (file.file_size ?? 0) <= TG_DOWNLOAD_LIMIT) {
    try {
      const data = buffer ?? (await downloadTelegramFile(file.file_id));
      const meta = await parseBuffer(data, { mimeType: file.mime_type, size: data.length });
      title = meta.common.title || title;
      artist = meta.common.artist || meta.common.albumartist || artist;
      album = meta.common.album ?? null;
      genre = meta.common.genre?.[0] ?? null;
      duration = Math.round(meta.format.duration ?? duration);
      const pic = meta.common.picture?.[0];
      if (pic) cover = { data: pic.data, ext: pic.format.includes("png") ? "png" : "jpg" };
    } catch (err) {
      console.warn("Не удалось прочитать теги:", (err as Error).message);
    }
  }
  // Запасной вариант — миниатюра, которую Telegram сам вытащил из файла
  if (!cover && "thumbnail" in file && file.thumbnail) {
    try {
      cover = { data: await downloadTelegramFile(file.thumbnail.file_id), ext: "jpg" };
    } catch {
      /* без обложки */
    }
  }

  // Короткие обрезки (превью, нарезки) в библиотеку не попадают
  if (!duration) throw new UpstreamError("Не удалось определить длительность файла — без неё не могу подтвердить, что это полный трек", 422);
  if (duration < MIN_FULL_SEC) throw new UpstreamError(SHORT_FRAGMENT, 422);

  const row = db
    .insert(schema.libraryFiles)
    .values({
      fileId: file.file_id,
      fileUniqueId: file.file_unique_id,
      fileName: file.file_name ?? null,
      mime: file.mime_type ?? null,
      size: file.file_size ?? buffer?.length ?? null,
      createdAt: Date.now(),
    })
    .returning()
    .get();

  let coverUrl: string | null = null;
  if (cover) {
    const coverPath = path.join(coversDir, `lib-${row.id}.${cover.ext}`);
    fs.writeFileSync(coverPath, cover.data);
    db.update(schema.libraryFiles).set({ coverPath }).where(eq(schema.libraryFiles.id, row.id)).run();
    coverUrl = `/api/cover/lib/${row.id}`;
  }

  const track: Track = {
    id: `lib:${row.id}`,
    source: "library",
    title,
    artist,
    artistId: null,
    album,
    albumId: null,
    cover: coverUrl,
    duration,
    full: true,
    downloadable: true,
    genre,
  };
  upsertTracks([track]);
  return { track, existed: false };
}

async function saveAudio(ctx: Context, file: Audio | Document) {
  let result: Awaited<ReturnType<typeof storeLibraryFile>>;
  try {
    result = await storeLibraryFile(file);
  } catch (err) {
    await ctx.reply(`⚠️ ${(err as Error).message}`);
    return;
  }
  const { track, existed } = result;
  if (existed) {
    await ctx.reply("Этот файл уже есть в вашей библиотеке 👌", { reply_markup: openButton() });
    return;
  }
  const tooBig = (file.file_size ?? 0) > TG_DOWNLOAD_LIMIT;
  await ctx.reply(
    `✅ Добавлено в «Мои файлы»:\n<b>${escapeHtml(track.artist)} — ${escapeHtml(track.title)}</b>` +
      (tooBig ? "\n\n⚠️ Файл больше 20 МБ: Telegram не даёт ботам скачивать такие файлы, поэтому в плеере он не заиграет. Его можно только переслать в чат." : ""),
    { parse_mode: "HTML", reply_markup: openButton() },
  );
}

/** Импорт файла из приложения: кладём его в чат с ботом (так он хранится в Telegram) и в библиотеку */
export async function importAudioBuffer(buffer: Buffer, fileName: string, mime: string) {
  const asAudio = /^audio\/(mpeg|mp3|mp4|x-m4a|aac)$/.test(mime) || /\.(mp3|m4a)$/i.test(fileName);
  const input = new InputFile(buffer, fileName);
  const caption = "📥 Импортировано из приложения";
  const msg = asAudio
    ? await getBot().api.sendAudio(env.allowedUserId, input, { caption, disable_notification: true })
    : await getBot().api.sendDocument(env.allowedUserId, input, { caption, disable_notification: true });
  const file = ("audio" in msg && msg.audio) || ("document" in msg && msg.document);
  if (!file) throw new Error("Telegram не принял файл");
  return storeLibraryFile(file, buffer);
}

function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export const notifyRelease: Notifier = async (r) => {
  const caption = `🆕 <b>${escapeHtml(r.artistName)}</b>\n${escapeHtml(r.kind)}: ${escapeHtml(r.title)}`;
  const markup = openButton("▶️ Слушать", r.albumId ? `/album/${encodeURIComponent(r.albumId)}` : "/collection/releases");
  if (r.cover) await getBot().api.sendPhoto(env.allowedUserId, r.cover, { caption, parse_mode: "HTML", reply_markup: markup });
  else await getBot().api.sendMessage(env.allowedUserId, caption, { parse_mode: "HTML", reply_markup: markup });
};

export async function startBot() {
  const b = getBot();

  // Только владелец
  b.use(async (ctx, next) => {
    if (ctx.from?.id !== env.allowedUserId) {
      if (ctx.chat?.type === "private") await ctx.reply("Это личный музыкальный бот 🙂");
      return;
    }
    await next();
  });

  b.command("start", async (ctx) => {
    const keyboard = webAppAvailable() ? new Keyboard().webApp("🎧 Открыть плеер", env.webappUrl).resized() : undefined;
    await ctx.reply(
      "Привет! Это твой личный плеер.\n\n" +
        "• Нажми «Открыть плеер», чтобы слушать музыку.\n" +
        "• Пришли мне аудиофайл — он появится в «Моих файлах» и будет играть целиком.\n" +
        "• /radar — проверить новинки подписок прямо сейчас.",
      { reply_markup: keyboard },
    );
  });

  b.command("radar", async (ctx) => {
    await ctx.reply("🔎 Проверяю новинки…");
    const n = await runRadar(notifyRelease);
    await ctx.reply(n ? `Нашёл новинок: ${n}` : "Новых релизов пока нет.");
  });

  b.on("message:audio", (ctx) => saveAudio(ctx, ctx.message.audio));
  b.on("message:document", async (ctx) => {
    const doc = ctx.message.document;
    if (doc.mime_type?.startsWith("audio/") || AUDIO_EXT.test(doc.file_name ?? "")) return saveAudio(ctx, doc);
    await ctx.reply("Пришлите аудиофайл (mp3, m4a, ogg, flac…) — я добавлю его в библиотеку.");
  });
  b.on("message:voice", (ctx) => ctx.reply("Голосовые сообщения не сохраняю — пришлите музыкальный файл."));

  b.catch((err) => console.error("Ошибка бота:", err.error));

  if (webAppAvailable()) {
    await b.api
      .setChatMenuButton({ chat_id: env.allowedUserId, menu_button: { type: "web_app", text: "Плеер", web_app: { url: env.webappUrl } } })
      .catch((e) => console.warn("Не удалось поставить кнопку меню:", e.message));
  }
  await b.api.setMyCommands([
    { command: "start", description: "Открыть плеер" },
    { command: "radar", description: "Проверить новинки" },
  ]);

  // Long polling — не нужен публичный адрес для вебхука
  void b.start({ drop_pending_updates: false, onStart: (me) => console.log(`🤖 Бот @${me.username} запущен`) });
}

export async function sendTrackToChat(opts: { fileId?: string; stream?: AsyncIterable<Uint8Array>; filename: string; title: string; performer: string; duration?: number; cover?: string | null }) {
  const b = getBot();
  const audio = opts.fileId ?? new InputFile(opts.stream!, opts.filename);
  await b.api.sendAudio(env.allowedUserId, audio, {
    title: opts.title,
    performer: opts.performer,
    duration: opts.duration,
    // Telegram принимает миниатюры только до 200 КБ — берём маленькую версию обложки Audius
    thumbnail: opts.cover?.startsWith("http") && !opts.fileId ? new InputFile(new URL(opts.cover.replace("1000x1000", "150x150"))) : undefined,
  });
}
