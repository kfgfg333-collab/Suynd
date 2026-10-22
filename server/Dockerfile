# Сервер Suynd (API + бот). Railway берёт этот файл сам, если Root Directory = server. Локально:
#   docker build -t suynd-server server && docker run --env-file server/.env -p 3000:3000 -v suynd-data:/data suynd-server

# Базовый образ можно заменить зеркалом, если Docker Hub ограничивает скачивание:
#   --build-arg NODE_IMAGE=mirror.gcr.io/library/node:22-bookworm-slim
ARG NODE_IMAGE=node:22-bookworm-slim

# 1) Зависимости. Инструменты сборки нужны, только если для better-sqlite3 не нашлось готовой сборки
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# 2) Рабочий образ: только Node.js и код
FROM ${NODE_IMAGE}
WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/data
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
RUN mkdir -p /data && chown -R node:node /data /app
USER node
EXPOSE 3000
CMD ["node_modules/.bin/tsx", "src/index.ts"]
