# Multi-stage build for the Task Management API.
#
# 1. deps    — install all deps (incl. dev) for building
# 2. build   — generate Prisma client + tsc compile to dist/
# 3. runtime — slim image with prod deps + dist + Prisma client/schema only
#
# Migrations need the Prisma CLI (a dev dependency): run them from the `build`
# stage — `docker build --target build` — as the stand's one-shot `migrate`
# service does (root docker-compose.yml). The demo seed is compiled into dist:
# `node dist/prisma/seed-demo.js` in the runtime image (13.D3).

# --- deps --------------------------------------------------------------------
FROM node:20-slim AS deps
WORKDIR /app
# OpenSSL is required by Prisma's query engine.
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

# --- build -------------------------------------------------------------------
FROM deps AS build
WORKDIR /app
COPY . .
RUN npx prisma generate && npm run build

# --- runtime -----------------------------------------------------------------
FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Compiled app + generated Prisma client + schema (needed for migrate deploy).
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/node_modules/@prisma/client ./node_modules/@prisma/client
COPY --from=build /app/src/prisma ./src/prisma

# Local-disk storage (STORAGE_DRIVER=local) writes here. Created owned by `node`
# so a fresh named volume mounted at this path inherits a writable owner.
RUN mkdir -p /data/uploads && chown node:node /data/uploads

USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
