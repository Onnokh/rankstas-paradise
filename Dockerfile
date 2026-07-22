# Ranksta's Paradise HTTP service — STUB Dockerfile for the monorepo rewrite.
#
# The real image targets the new server app (apps/server) once its HTTP entry
# lands in PLO-276. It is kept minimal and mostly commented until then: the
# current apps/server/src/main.ts is a skeleton that does not serve traffic yet.
#
# Runtime is Bun; state (OAuth token, SQLite, registry CSV, config.json) lives on
# a persistent volume (see docs/deploy.md), never baked into the image.
FROM oven/bun:1

WORKDIR /app

# Install workspace dependencies first so this layer caches across source changes.
COPY package.json bun.lock ./
# COPY packages ./packages
# COPY apps ./apps
RUN bun install --frozen-lockfile

# Copy the application source.
COPY . .

# Default port; override with SEO_PORT. EXPOSE is documentation only.
EXPOSE 8790

# Real entry (PLO-276): serve the HTTP API from the new server app.
# CMD ["bun", "run", "apps/server/src/main.ts"]
CMD ["bun", "run", "apps/server/src/main.ts"]
