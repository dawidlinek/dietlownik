# syntax=docker/dockerfile:1.7

# ────────────────────────────────────────────────────────────────────────────
# Stage 1 — install deps with Bun (matches bun.lock)
# ────────────────────────────────────────────────────────────────────────────
FROM oven/bun:1.3-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# ────────────────────────────────────────────────────────────────────────────
# Stage 2 — build the Next.js app (standalone output)
# ────────────────────────────────────────────────────────────────────────────
FROM oven/bun:1.3-alpine AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN bun run build

# ────────────────────────────────────────────────────────────────────────────
# Stage 3 — minimal runtime (Node, non-root, only the standalone bundle)
# ────────────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nextjs \
 && adduser --system --uid 1001 --ingroup nextjs nextjs

# Standalone server + traced node_modules.
COPY --from=builder --chown=nextjs:nextjs /app/.next/standalone ./
# Static chunks (Next does not include these in standalone).
COPY --from=builder --chown=nextjs:nextjs /app/.next/static ./.next/static
# Public assets (favicon, fonts, etc).
COPY --from=builder --chown=nextjs:nextjs /app/public ./public

USER nextjs
EXPOSE 3000

# DATABASE_URL must be supplied at runtime (e.g. `docker run -e DATABASE_URL=...`).
CMD ["node", "server.js"]
