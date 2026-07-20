# Ranksta's Paradise HTTP service. Runtime is Bun; the entrypoint is
# src/server.ts (`bun run server`), which binds 0.0.0.0 on SEO_PORT.
# No secrets or state are baked in — the OAuth token, SQLite, registry CSV,
# and config.json all live on a persistent volume (see docs/deploy.md).
FROM oven/bun:1

WORKDIR /app

# Install dependencies first so this layer is cached across source changes.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Copy the application source.
COPY . .

# Default port; override with SEO_PORT. EXPOSE is documentation only.
EXPOSE 8790

CMD ["bun", "run", "server"]
