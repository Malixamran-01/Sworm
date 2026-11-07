# Conclave, Lite profile: one container (API, realtime hub, workers, built-in engine).
# Pair it with Postgres + pgvector (see compose.yaml), or leave CONCLAVE_DATABASE_URL unset
# to keep data in PGlite under /data.

FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY . .
RUN npm ci --no-audit --no-fund && npm run build:web && npm prune --omit=dev --no-audit --no-fund

FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    CONCLAVE_DATA_DIR=/data
WORKDIR /app
COPY --from=build --chown=node:node /app /app
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:8787/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--import", "tsx", "apps/server/src/main.ts"]
