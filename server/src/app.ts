import cors from "@fastify/cors";
import Fastify from "fastify";
import { requireAuth } from "./auth.js";
import "./db/index.js";
import { env } from "./env.js";
import { UpstreamError } from "./http.js";
import { authRoutes } from "./routes/auth.js";
import { catalogRoutes } from "./routes/catalog.js";
import { libraryRoutes } from "./routes/library.js";
import { mediaRoutes } from "./routes/media.js";
import { radarRoutes } from "./routes/radar.js";
import { waveRoutes } from "./routes/wave.js";

/** Сборка приложения без запуска: используется сервером и тестами (app.inject) */
export async function buildApp() {
  const app = Fastify({
    logger: { level: env.isProd ? "info" : "warn" },
    trustProxy: true,
    bodyLimit: 1024 * 1024,
    maxParamLength: 512, // id треков Internet Archive длинные (base64 от «item/файл»)
  });

  await app.register(cors, {
    origin: (origin, cb) => {
      // Разрешаем фронтенд из WEBAPP_URL, локальную разработку и превью Vercel
      if (!origin || origin === env.webappUrl || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return cb(null, true);
      cb(null, false);
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    exposedHeaders: ["content-length", "content-range", "accept-ranges"],
  });

  app.setErrorHandler((err, req, reply) => {
    const status = err instanceof UpstreamError ? err.status : (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) req.log.error(err);
    reply.code(status).send({
      error: "error",
      message: status >= 500 && !(err instanceof UpstreamError) ? "Что-то пошло не так на сервере. Попробуйте ещё раз." : (err as Error).message,
    });
  });

  app.get("/health", async () => ({ ok: true }));
  app.get("/", async () => ({ name: "Suynd API", ok: true }));

  await app.register(authRoutes);
  await app.register(async (secured) => {
    secured.addHook("onRequest", requireAuth);
    await secured.register(catalogRoutes);
    await secured.register(libraryRoutes);
    await secured.register(waveRoutes);
    await secured.register(radarRoutes);
    await secured.register(mediaRoutes);
  });

  return app;
}
