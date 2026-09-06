# API + background worker. Runs TypeScript directly with tsx; migrations apply on boot.
FROM node:22-alpine AS base
WORKDIR /app
ENV NODE_ENV=production

# Install the whole workspace once (lockfile-driven), then copy only what the API needs.
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --include=dev --no-audit --no-fund

COPY packages/core packages/core
COPY apps/api apps/api

RUN addgroup -S app && adduser -S app -G app && mkdir -p /app/data && chown -R app:app /app
USER app

ENV PORT=4000
# Without DATABASE_URL the API falls back to embedded PGlite in this directory (mount a volume).
ENV PGLITE_DIR=/app/data/pglite
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:4000/health || exit 1
CMD ["npx", "tsx", "apps/api/src/server.ts"]
