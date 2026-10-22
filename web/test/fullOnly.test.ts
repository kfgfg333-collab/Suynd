import assert from "node:assert/strict";
import { test } from "node:test";
import { isFullLengthAudio, isFullTrack, onlyFull, planPlayback } from "../src/lib/fullOnly.ts";
import type { Track } from "../src/lib/types.ts";

const base = { artistId: null, album: null, albumId: null, cover: null, downloadable: false };
const preview: Track = { ...base, id: "dz:1", source: "deezer", title: "Hit", artist: "Star", duration: 30, full: false };
const catalog: Track = { ...base, id: "dz:2", source: "deezer", title: "Hit", artist: "Star", duration: 210, full: false };
const snippet: Track = { ...base, id: "au:s", source: "audius", title: "Hit (snippet)", artist: "Star", duration: 25, full: true };
const full1: Track = { ...base, id: "au:1", source: "audius", title: "A", artist: "X", duration: 200, full: true };
const full2: Track = { ...base, id: "ia:QUJD", source: "archive", title: "B", artist: "Y", duration: 180, full: true, downloadable: true };

test("превью и фрагменты не считаются полными треками", () => {
  assert.equal(isFullTrack(preview), false);
  assert.equal(isFullTrack(catalog), false);
  assert.equal(isFullTrack(snippet), false);
  assert.equal(isFullTrack(full1), true);
});

test("если полной версии нет — плеер не стартует", () => {
  assert.equal(planPlayback([preview, full1], 0), null);
  assert.equal(planPlayback([catalog], 0), null);
});

test("превью не попадает в очередь (избранное, рекомендации, волна)", () => {
  const plan = planPlayback([preview, full1, snippet, full2, catalog], 1)!;
  assert.deepEqual(plan.queue.map((t) => t.id), ["au:1", "ia:QUJD"]);
  assert.equal(plan.index, 0);
  assert.deepEqual(onlyFull([preview, full2]).map((t) => t.id), ["ia:QUJD"]);
});

test("загрузчик: файл короче ожидаемого — не полный трек", () => {
  assert.equal(isFullLengthAudio(200, 30), false);
  assert.equal(isFullLengthAudio(200, 150), false);
  assert.equal(isFullLengthAudio(200, NaN), false);
  assert.equal(isFullLengthAudio(200, 199.5), true);
});
