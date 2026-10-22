# Сервер Suynd (API + бот) вместе с yt-dlp.
# Railway берёт этот файл сам, если Root Directory = server. Локально:
#   docker build -t suynd-server server && docker run --env-file server/.env -p 3000:3000 -v suynd-data:/data suynd-server

# Базовый образ можно заменить зеркалом, если Docker Hub ограничивает скачивание:
#   --build-arg NODE_IMAGE=public.ecr.aws/docker/library/node:22-bookworm-slim
ARG NODE_IMAGE=node:22-bookworm-slim

# 1) Зависимости Node. Инструменты сборки нужны, только если для better-sqlite3 не нашлось готовой сборки
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# 2) Рабочий образ
FROM ${NODE_IMAGE}
WORKDIR /app
# yt-dlp ставится из PyPI в отдельное окружение. Набор [default] включает yt-dlp-ejs —
# без него YouTube отдаёт ссылки, на которые медиасервер отвечает 403.
# Версия закреплена, чтобы сборка была воспроизводимой (проверена с YouTube-извлечением и yt-dlp-ejs 0.8.0).
# YouTube меняется часто: чтобы обновиться, соберите с --build-arg YT_DLP_VERSION=<новая версия>
# или пустым значением (тогда будет последняя на момент сборки) и прогоните `GET /api/sources/status`.
ARG YT_DLP_VERSION=2026.10.21
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && python3 -m venv /opt/yt-dlp \
  && /opt/yt-dlp/bin/pip install --no-cache-dir "yt-dlp[default]${YT_DLP_VERSION:+==$YT_DLP_VERSION}" \
  && /opt/yt-dlp/bin/python -c "import yt_dlp_ejs" \
  && /opt/yt-dlp/bin/yt-dlp --version
ENV NODE_ENV=production \
    DATA_DIR=/data \
    YT_DLP_PATH=/opt/yt-dlp/bin/yt-dlp
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
RUN mkdir -p /data && chown -R node:node /data /app
USER node
EXPOSE 3000
CMD ["node_modules/.bin/tsx", "src/index.ts"]
