# Retro Snake Arena — production image.
# Multi-stage: compile native deps (better-sqlite3) in a builder, then ship a
# slim runtime that runs as the non-root `node` user.

FROM node:20-bookworm-slim AS build
WORKDIR /app
# Build tools only needed to compile better-sqlite3.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .

FROM node:20-bookworm-slim
ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/app/data/leaderboard.sqlite
WORKDIR /app
COPY --from=build /app /app
# Writable data dir for the SQLite leaderboard (mounted as a volume at runtime).
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 3000
CMD ["node", "server.js"]
