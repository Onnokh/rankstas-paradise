# Ranksta's Paradise HTTP service — the Effect v4 monorepo server (apps/server).
#
# Runtime is Bun. The canonical entrypoint is apps/server/src/main.ts: it builds
# the root Layer (Bun HTTP server + HttpApi + the bearer-gated /mcp mount) and
# launches it under one long-lived runtime, binding 0.0.0.0 on SEO_PORT.
#
# STATE LIVES ON A VOLUME, NEVER IN THE IMAGE. All mutable state — the OAuth
# token (google-token.json), per-site SQLite, the registry CSV, and config.json —
# lives under the app home ${XDG_CONFIG_HOME}/rankstas-paradise. On Coolify, mount
# a persistent volume at /data and set XDG_CONFIG_HOME=/data (see docs/deploy.md).
# .dockerignore keeps any local state out of the build context.
#
# DEPLOY NOTE (operational; full rationale is ADR 0002 / PLO-278): the daily
# Coolify SCHEDULED TASK keeps each site's data fresh by calling
#   POST /api/jobs/sync?site=<id>
# once per configured site (bearer-authenticated with RP_TOKEN). The server does
# not self-schedule; read endpoints also warm-on-read as a fallback.
FROM oven/bun:1

WORKDIR /app

# Copy the whole workspace, then install from the committed lockfile. Workspace
# members (apps/*, packages/*) must be present for `workspace:*` deps to resolve,
# so we copy first and install second.
COPY . .
RUN bun install --frozen-lockfile

# Default port; override with SEO_PORT. EXPOSE is documentation only — the server
# binds 0.0.0.0 in code so the container is reachable behind Coolify's proxy.
EXPOSE 8790

# Serve the HTTP API + MCP from the new server app.
CMD ["bun", "run", "apps/server/src/main.ts"]
