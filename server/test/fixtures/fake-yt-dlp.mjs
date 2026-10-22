#!/usr/bin/env node
/*
 * Поддельный yt-dlp для тестов: ведёт себя как настоящий по формату вывода и ошибок,
 * но ничего не скачивает и не ходит в сеть. Аудио отдаёт локальный тестовый сервер (FAKE_MEDIA_BASE).
 * Каждый вызов дописывает свои аргументы в FAKE_STATE_DIR/calls.jsonl.
 */
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const stateDir = process.env.FAKE_STATE_DIR;
const media = process.env.FAKE_MEDIA_BASE ?? "http://127.0.0.1:1";
if (stateDir) fs.appendFileSync(path.join(stateDir, "calls.jsonl"), JSON.stringify(args) + "\n");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (msg) => {
  process.stderr.write(`ERROR: ${msg}\n`);
  process.exit(1);
};

if (args.includes("--version")) {
  process.stdout.write("2026.10.21\n");
  process.exit(0);
}

// Диагностика `yt-dlp -v` без URL: заголовок в stderr и код 2, как у настоящего
if (args.includes("-v") && !args.includes("--print") && !args.includes("--flat-playlist")) {
  process.stderr.write(
    [
      "[debug] yt-dlp version stable@2026.10.21 from yt-dlp/yt-dlp [fake] (pip)",
      "[debug] Optional libraries: certifi-2026.1.1, requests-2.0, yt_dlp_ejs-0.8.0",
      "[debug] JS runtimes: node-22.0.0",
      "[debug] Proxy map: {'https': 'http://user:proxy-secret@10.0.0.1:3128'}",
      "Usage: yt-dlp [OPTIONS] URL [URL...]",
      "yt-dlp: error: You must provide at least one URL.",
    ].join("\n") + "\n",
  );
  process.exit(2);
}

const target = args[args.length - 1];

if (args.includes("--flat-playlist")) {
  const query = target.replace(/^ytsearch\d+:/, "");
  if (/slow/.test(query)) await sleep(30_000);
  if (/wait/.test(query)) await sleep(800);
  if (/empty/.test(query)) {
    process.stdout.write(JSON.stringify({ _type: "playlist", entries: [] }));
    process.exit(0);
  }
  const e = (id, title, duration, extra = {}) => ({ _type: "url", ie_key: "Youtube", id, title, duration, uploader: "Test Channel", ...extra });
  process.stdout.write(
    JSON.stringify({
      _type: "playlist",
      entries: [
        e("okSong00001", "Test Artist - Test Song (Official Video)", 120),
        e("okSong00001", "Test Artist - Test Song (Official Video)", 120),
        e("topic000001", "Another Song", 200, { uploader: "Some Band - Topic" }),
        e("short000001", "Test Song", 30),
        e("prev0000001", "Test Song (Preview)", 60),
        e("live0000001", "Live radio", 0, { live_status: "is_live" }),
        e("priv0000001", "Hidden", 100, { availability: "private" }),
        e("bad id", "Broken", 100),
        { _type: "url", ie_key: "Vimeo", id: "vimeo000001", title: "Other site", duration: 100 },
      ],
    }),
  );
  process.exit(0);
}

if (args.includes("--print")) {
  const id = new URL(target).searchParams.get("v");
  const count = (() => {
    if (!stateDir) return 1;
    const f = path.join(stateDir, `resolve-${id}`);
    const n = (fs.existsSync(f) ? Number(fs.readFileSync(f, "utf8")) : 0) + 1;
    fs.writeFileSync(f, String(n));
    return n;
  })();
  const info = (extra = {}) => ({
    id,
    title: "Test Artist - Test Song",
    uploader: "Test Channel",
    duration: 70,
    availability: "public",
    live_status: "not_live",
    url: `${media}/audio.wav?id=${id}&n=${count}`,
    ext: "m4a",
    protocol: "https",
    http_headers: { "User-Agent": "FakeAgent/1.0", Accept: "text/html", Cookie: "SECRET=must-not-leak" },
    ...extra,
  });
  switch (id) {
    case "removed0001":
      fail(`[youtube] ${id}: Video unavailable. This video has been removed by the uploader`);
    case "geo00000001":
      fail(`[youtube] ${id}: The uploader has not made this video available in your country`);
    case "private0001":
      fail(`[youtube] ${id}: Private video. Sign in if you've been granted access to this video`);
    case "botcheck001":
      fail(`[youtube] ${id}: Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication`);
    case "agegate0001":
      fail(`[youtube] ${id}: Sign in to confirm your age. This video may be inappropriate for some users.`);
    case "drm00000001":
      fail(`[youtube] ${id}: This video is DRM protected`);
    case "flaky000001":
      // Первые два запуска — временный сетевой сбой, третий успешен
      if (count <= 2) fail(`[youtube] ${id}: Unable to download webpage: <urlopen error timed out> (caused by TransportError('timed out'))`);
      process.stdout.write(JSON.stringify(info()));
      process.exit(0);
    case "netdown0001":
      fail(`[youtube] ${id}: Unable to download webpage: Temporary failure in name resolution`);
    case "forbid00001":
      // Медиасервер всегда отвечает 403 — как YouTube для «чужого» IP
      process.stdout.write(JSON.stringify(info({ url: `${media}/expired?id=${id}&n=${count}` })));
      process.exit(0);
    case "deadHost001":
      process.stdout.write(JSON.stringify(info({ url: "http://127.0.0.1:9/audio.wav" })));
      process.exit(0);
    case "parallel001":
      await sleep(400);
      process.stdout.write(JSON.stringify(info()));
      process.exit(0);
    case "slow0000001":
      await sleep(60_000);
      break;
    case "huge0000001":
      process.stdout.write("x".repeat(5 * 1024 * 1024));
      process.exit(0);
    case "shortClip01":
      process.stdout.write(JSON.stringify(info({ duration: 30 })));
      process.exit(0);
    case "liveNow0001":
      process.stdout.write(JSON.stringify(info({ live_status: "is_live", is_live: true })));
      process.exit(0);
    case "evilHost001":
      process.stdout.write(JSON.stringify(info({ url: "file:///etc/passwd" })));
      process.exit(0);
    case "ccSong00001":
      process.stdout.write(JSON.stringify(info({ license: "Creative Commons Attribution license (reuse allowed)" })));
      process.exit(0);
    case "expired0001":
      // Первая ссылка «протухла»: тестовый сервер ответит на неё 403
      process.stdout.write(JSON.stringify(info(count === 1 ? { url: `${media}/expired?id=${id}` } : {})));
      process.exit(0);
    default:
      process.stdout.write(JSON.stringify(info()));
      process.exit(0);
  }
}

fail("unexpected arguments");
