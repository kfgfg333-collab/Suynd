import { desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db, schema } from "../db/index.js";
import { UpstreamError } from "../http.js";
import { checkSubscription } from "../services/radar.js";

export async function radarRoutes(app: FastifyInstance) {
  app.get("/api/subscriptions", async () => ({
    items: db.select().from(schema.subscriptions).orderBy(desc(schema.subscriptions.createdAt)).all(),
  }));

  app.post("/api/subscriptions", async (req) => {
    const { artistId, name, picture } = (req.body ?? {}) as { artistId?: string; name?: string; picture?: string | null };
    const m = artistId?.match(/^(dz|au):[A-Za-z0-9_-]+$/);
    if (!artistId || !m) throw new UpstreamError("Неизвестный артист", 400);
    const row = {
      artistKey: artistId,
      source: (m[1] === "dz" ? "deezer" : "audius") as "deezer" | "audius",
      name: String(name ?? "").slice(0, 120) || artistId,
      picture: typeof picture === "string" ? picture : null,
      createdAt: Date.now(),
    };
    db.insert(schema.subscriptions).values(row).onConflictDoNothing().run();
    const sub = db.select().from(schema.subscriptions).where(eq(schema.subscriptions.artistKey, artistId)).get()!;
    // Сразу запоминаем уже вышедшие релизы, чтобы раздел «Новинки» не был пустым
    if (!sub.lastCheckedAt) await checkSubscription(sub).catch(() => 0);
    return { ok: true };
  });

  app.delete("/api/subscriptions/:key", async (req) => {
    const key = (req.params as { key: string }).key;
    db.delete(schema.subscriptions).where(eq(schema.subscriptions.artistKey, key)).run();
    db.delete(schema.releases).where(eq(schema.releases.artistKey, key)).run();
    return { ok: true };
  });

  app.get("/api/releases", async () => {
    const rows = db.select().from(schema.releases).all();
    // Сортируем по дате выхода (у треков Audius — по моменту обнаружения)
    const date = (r: (typeof rows)[number]) => (r.releaseDate ? Date.parse(r.releaseDate) : r.createdAt);
    return { items: rows.sort((a, b) => date(b) - date(a)).slice(0, 100) };
  });
}
