import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";

process.env.BOT_TOKEN = "123456:TEST";
process.env.ALLOWED_USER_ID = "42";
process.env.DATA_DIR = process.env.TEST_DATA_DIR ?? "./data-test";
process.env.BOT_DISABLED = "true";

const { validateInitData, issueSession, verifySession } = await import("../src/auth.js");
const { scoreCandidate, similarity, normalize } = await import("../src/services/fullVersion.js");
const { preferExplicit } = await import("../src/providers/deezer.js");
const { encodeArchiveId, decodeArchiveId, parseLength } = await import("../src/providers/archive.js");
const { isPrivateHost } = await import("../src/routes/media.js");
const { verifyAudio, looksLikeAudio } = await import("../src/services/importAudio.js");
const { isValidTrackId } = await import("../src/services/tracks.js");

function signInitData(token: string, userId: number) {
  const p = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: userId }) });
  const dcs = [...p.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(token).digest();
  p.set("hash", crypto.createHmac("sha256", secret).update(dcs).digest("hex"));
  return p.toString();
}

/** Настоящий WAV: 16 бит, моно, 8 кГц, нужной длины */
function makeWav(seconds: number) {
  const rate = 8000;
  const samples = rate * seconds;
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + samples * 2, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) buf.writeInt16LE(Math.round(Math.sin(i / 10) * 8000), 44 + i * 2);
  return buf;
}

test("initData: принимает подпись владельца, отклоняет чужой токен", () => {
  assert.equal(validateInitData(signInitData("123456:TEST", 42)).id, 42);
  assert.throws(() => validateInitData(signInitData("999:OTHER", 42)), /подпись/);
});

test("сессия: только ALLOWED_USER_ID и неподделанный токен", () => {
  const { token } = issueSession(42);
  assert.equal(verifySession(token), 42);
  assert.equal(verifySession(token.slice(0, -2) + "xx"), null);
  assert.equal(verifySession(issueSession(43).token), null);
});

test("сопоставление: полная версия с той же длительностью проходит", () => {
  const target = { title: "Blinding Lights", artist: "The Weeknd", duration: 200 };
  assert.ok(scoreCandidate(target, { title: "Blinding Lights", artist: "The Weeknd", duration: 203, full: true, source: "audius" as const }) > 0.9);
});

test("сопоставление: превью, кавер другого артиста и другая длительность отклоняются", () => {
  const target = { title: "Blinding Lights", artist: "The Weeknd", duration: 200 };
  assert.equal(scoreCandidate(target, { title: "Blinding Lights", artist: "The Weeknd", duration: 30, full: false, source: "deezer" as const }), 0);
  assert.equal(scoreCandidate(target, { title: "Blinding Lights", artist: "Random Cover Band", duration: 200, full: true, source: "audius" as const }), 0);
  assert.equal(scoreCandidate(target, { title: "Blinding Lights", artist: "The Weeknd", duration: 420, full: true, source: "audius" as const }), 0);
  assert.equal(scoreCandidate(target, { title: "Save Your Tears", artist: "The Weeknd", duration: 200, full: true, source: "audius" as const }), 0);
});

test("нормализация названий", () => {
  assert.equal(normalize("Song (feat. Someone)"), "song");
  assert.equal(similarity("Ёлка", "елка"), 1);
});

test("explicit: из пары clean/explicit остаётся explicit", () => {
  const base = { source: "deezer" as const, artist: "A", artistId: null, album: null, albumId: null, cover: null, duration: 30, full: false, downloadable: false };
  const out = preferExplicit([
    { ...base, id: "dz:1", title: "Track", explicit: false },
    { ...base, id: "dz:2", title: "Track", explicit: true },
    { ...base, id: "dz:3", title: "Other", explicit: false },
  ]);
  assert.deepEqual(out.map((t) => t.id), ["dz:2", "dz:3"]);
});

test("Internet Archive: id туда-обратно и длительность", () => {
  const id = encodeArchiveId("some_item.v2", "CD 1/01 - Song (live).mp3");
  assert.ok(isValidTrackId(id));
  assert.deepEqual(decodeArchiveId(id.slice(3)), { identifier: "some_item.v2", file: "CD 1/01 - Song (live).mp3" });
  assert.equal(parseLength("20:36"), 1236);
  assert.equal(parseLength("1:02:03"), 3723);
  assert.equal(parseLength("245.6"), 246);
});

test("защита /api/img и импорта от внутренних адресов", () => {
  for (const h of ["localhost", "127.0.0.1", "10.1.2.3", "192.168.0.5", "172.20.0.1", "169.254.169.254", "100.64.0.1"]) assert.ok(isPrivateHost(h), h);
  assert.equal(isPrivateHost("archive.org"), false);
  assert.equal(isPrivateHost("8.8.8.8"), false);
});

test("проверка аудио: настоящий WAV проходит с верной длительностью", async () => {
  const r = await verifyAudio(makeWav(60), "audio/wav");
  assert.equal(r.duration, 60);
  assert.equal(r.container, "WAVE");
});

test("проверка аудио: мусор и HTML отклоняются", async () => {
  await assert.rejects(verifyAudio(Buffer.alloc(4096, 7)), /аудио|дорожки/);
  await assert.rejects(verifyAudio(Buffer.from("<html>" + "x".repeat(3000))), /аудио|дорожки/);
  assert.equal(looksLikeAudio("page.html", "text/html"), false);
  assert.ok(looksLikeAudio("song.flac", ""));
});

test("сопоставление: совпадение с одним из соавторов", async () => {
  const { splitArtists } = await import("../src/services/fullVersion.js");
  assert.deepEqual(splitArtists("Dr. Andrew Weil & Joshua Leeds"), ["Dr. Andrew Weil", "Joshua Leeds"]);
  const target = { title: "Song", artist: "Alpha & Beta feat. Gamma", duration: 180 };
  assert.ok(scoreCandidate(target, { title: "Song", artist: "Beta", duration: 182, full: true, source: "audius" as const }) > 0);
});
