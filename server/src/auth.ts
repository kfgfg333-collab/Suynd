import crypto from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { env } from "./env.js";

const MAX_INIT_DATA_AGE_SEC = 24 * 60 * 60;
const SESSION_TTL_SEC = 7 * 24 * 60 * 60;

export interface TelegramUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
}

/**
 * Проверка Telegram initData по официальному алгоритму:
 * secret = HMAC_SHA256(key="WebAppData", BOT_TOKEN), hash = HMAC_SHA256(secret, data_check_string)
 */
export function validateInitData(initData: string): TelegramUser {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) throw new Error("В initData нет подписи");
  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const secret = crypto.createHmac("sha256", "WebAppData").update(env.botToken).digest();
  const expected = crypto.createHmac("sha256", secret).update(dataCheckString).digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error("Неверная подпись initData");

  const authDate = Number(params.get("auth_date"));
  if (!authDate || Date.now() / 1000 - authDate > MAX_INIT_DATA_AGE_SEC) throw new Error("initData устарела");

  const user = JSON.parse(params.get("user") ?? "null") as TelegramUser | null;
  if (!user?.id) throw new Error("В initData нет пользователя");
  return user;
}

function sign(payload: string) {
  return crypto.createHmac("sha256", env.sessionSecret).update(payload).digest("base64url");
}

export function issueSession(userId: number): { token: string; expiresAt: number } {
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SEC;
  const payload = Buffer.from(JSON.stringify({ uid: userId, exp: expiresAt })).toString("base64url");
  return { token: `${payload}.${sign(payload)}`, expiresAt };
}

export function verifySession(token: string | undefined): number | null {
  if (!token) return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  const expected = sign(payload);
  if (expected.length !== signature.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) {
    return null;
  }
  try {
    const { uid, exp } = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (uid !== env.allowedUserId || exp < Date.now() / 1000) return null;
    return uid;
  } catch {
    return null;
  }
}

/** Хук Fastify: пропускает только владельца. Токен — в заголовке или ?t= (для <audio>/<img>). */
export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : (req.query as { t?: string } | undefined)?.t;
  if (!verifySession(token)) {
    return reply.code(401).send({ error: "unauthorized", message: "Сессия истекла — откройте приложение заново из Telegram." });
  }
}
