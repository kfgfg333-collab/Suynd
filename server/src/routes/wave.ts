import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db, schema } from "../db/index.js";
import { UpstreamError } from "../http.js";
import { nextWaveBatch, type WaveEnergy, type WaveMode } from "../services/wave.js";
import { ensureTrack } from "./library.js";

const MODES: WaveMode[] = ["familiar", "mix", "new"];
const ENERGIES: WaveEnergy[] = ["any", "calm", "energetic"];

export async function waveRoutes(app: FastifyInstance) {
  app.post("/api/wave/next", async (req) => {
    const body = (req.body ?? {}) as { mode?: WaveMode; energy?: WaveEnergy; exclude?: string[] };
    const mode = MODES.includes(body.mode!) ? body.mode! : "mix";
    const energy = ENERGIES.includes(body.energy!) ? body.energy! : "any";
    const exclude = Array.isArray(body.exclude) ? body.exclude.filter((x) => typeof x === "string").slice(-200) : [];
    return { items: await nextWaveBatch({ mode, energy, exclude }) };
  });

  /** 👍 = 1, 👎 = -1, 0 = снять оценку */
  app.post("/api/feedback", async (req) => {
    const { value } = (req.body ?? {}) as { value?: number };
    if (![1, -1, 0].includes(value as number)) throw new UpstreamError("value должен быть 1, -1 или 0", 400);
    const track = await ensureTrack(req.body);
    if (value === 0) {
      db.delete(schema.feedback).where(eq(schema.feedback.trackId, track.id)).run();
    } else {
      const row = { trackId: track.id, artistKey: track.artistId, value: value!, createdAt: Date.now() };
      db.insert(schema.feedback).values(row).onConflictDoUpdate({ target: schema.feedback.trackId, set: row }).run();
    }
    return { ok: true };
  });

  app.get("/api/blocked", async () => ({ items: db.select().from(schema.blockedArtists).all() }));

  app.post("/api/blocked", async (req) => {
    const { artistId, name } = (req.body ?? {}) as { artistId?: string; name?: string };
    if (!artistId || !/^(dz|au):[A-Za-z0-9_-]+$/.test(artistId)) throw new UpstreamError("Неизвестный артист", 400);
    db.insert(schema.blockedArtists)
      .values({ artistKey: artistId, name: String(name ?? "").slice(0, 120) || artistId, createdAt: Date.now() })
      .onConflictDoNothing()
      .run();
    return { ok: true };
  });

  app.delete("/api/blocked/:key", async (req) => {
    db.delete(schema.blockedArtists).where(eq(schema.blockedArtists.artistKey, (req.params as { key: string }).key)).run();
    return { ok: true };
  });
}
