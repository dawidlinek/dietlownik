# syntax=docker/dockerfile:1.7

# ────────────────────────────────────────────────────────────────────────────
# Stage 1 — install deps with Bun (matches bun.lock)
# ────────────────────────────────────────────────────────────────────────────
FROM oven/bun:1.3-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install

# ────────────────────────────────────────────────────────────────────────────
# Stage 2 — build the Next.js app (standalone output)
# ────────────────────────────────────────────────────────────────────────────
FROM oven/bun:1.3-alpine AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
# Placeholder for the build step only — Next "collect page data" loads route
# handlers, and scraper/db.ts throws on missing DATABASE_URL. The Pool is
# created lazily so this URL is never actually connected to. The real URL
# must be provided at runtime (`docker run -e DATABASE_URL=...`).
ENV DATABASE_URL=postgres://build:build@localhost:5432/build_placeholder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN bun run build

# ────────────────────────────────────────────────────────────────────────────
# Stage 3 — runtime: Next standalone web server + scraper / migration tooling
#
# The same image runs the web server (default CMD) and is also invokable as a
# scheduled job for scraper / migrations:
#
#   web       (default)         node server.js
#   scrape                       node node_modules/.bin/tsx scraper/index.ts
#   promotions backfill          node node_modules/.bin/tsx scraper/scripts/scrape-promotions-now.ts
#   promo-prices backfill        node node_modules/.bin/tsx scraper/scripts/scrape-prices-with-promos.ts
#   migrate (any vN)             node db/migrate_vN.js
#
# DATABASE_URL must be supplied at runtime (e.g. -e DATABASE_URL=...).
# ────────────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nextjs \
 && adduser --system --uid 1001 --ingroup nextjs nextjs

# Web (Next standalone bundle + traced node_modules).
COPY --from=builder --chown=nextjs:nextjs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nextjs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nextjs /app/public ./public

# Scraper + migrations + tooling for scheduled jobs.
COPY --from=builder --chown=nextjs:nextjs /app/scraper ./scraper
COPY --from=builder --chown=nextjs:nextjs /app/db ./db
COPY --from=builder --chown=nextjs:nextjs /app/package.json ./package.json
COPY --from=builder --chown=nextjs:nextjs /app/tsconfig.json ./tsconfig.json
# Full node_modules (overwrites the standalone-traced subset). Adds tsx + pg
# + dotenv + the rest of devDependencies so the scraper TypeScript runs as-is.
COPY --from=builder --chown=nextjs:nextjs /app/node_modules ./node_modules

USER nextjs
EXPOSE 3000

CMD ["node", "start.js"]
