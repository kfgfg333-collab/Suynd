import type { FastifyInstance } from "fastify";
import { issueSession, validateInitData } from "../auth.js";
import { env } from "../env.js";

export async function authRoutes(app: FastifyInstance) {
  app.post("/api/auth", async (req, reply) => {
    const { initData } = (req.body ?? {}) as { initData?: string };

    if (!initData && env.devAuthBypass) {
      req.log.warn("DEV_AUTH_BYPASS: вход без Telegram (только для локальной разработки)");
      return { ...issueSession(env.allowedUserId), user: { id: env.allowedUserId, first_name: "Dev" } };
    }
    if (!initData) {
      return reply.code(401).send({ error: "no_init_data", message: "Откройте приложение через бота в Telegram." });
    }
    try {
      const user = validateInitData(initData);
      if (user.id !== env.allowedUserId) {
        return reply.code(403).send({ error: "forbidden", message: "Это личное приложение — доступ только у владельца." });
      }
      return { ...issueSession(user.id), user };
    } catch (err) {
      return reply.code(401).send({ error: "bad_init_data", message: (err as Error).message });
    }
  });
}
