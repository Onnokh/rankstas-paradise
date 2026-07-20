# Deploy (Coolify)

Ranksta's Paradise runs as a single Bun HTTP service. All state lives on one persistent volume; Google credentials are seeded onto that volume, never baked into the image. The ADR ([docs/adr/0001-rp-as-hosted-service.md](adr/0001-rp-as-hosted-service.md)) is the source of truth.

## 1. Service

- Project: **Digital Home**.
- New resource → **Dockerfile** application, pointed at this repo. Coolify builds from the repo-root `Dockerfile`.
- The server binds `0.0.0.0` on `SEO_PORT` (default **8790**); set Coolify's exposed port to match.

## 2. Persistent volume

Everything the app reads or writes — OAuth token, SQLite, registry CSV, `config.json` — lives under one app home: `${XDG_CONFIG_HOME:-~/.config}/rankstas-paradise` (see [src/config.ts](../src/config.ts)).

- Mount a Coolify **persistent volume** at `/data`.
- Set env `XDG_CONFIG_HOME=/data`, so the app home is **`/data/rankstas-paradise`**.

Without the volume the token and history are lost on every redeploy.

## 3. Environment

| Var | Required | Notes |
|---|---|---|
| `RP_TOKEN` | yes (secret) | Bearer token required on every request. Use a long random value. |
| `XDG_CONFIG_HOME` | yes | Set to `/data` (see above). |
| `SEO_PORT` | no | Defaults to 8790. |

No Google secrets go in env — they live in `config.json` on the volume (next step).

## 4. Seed the volume

Google creds and the OAuth token are files under the app home, not env:

- `config.json` — `googleClientId`, `googleClientSecret`, `siteUrl`, and the `sites` array (see [config.example.json](../config.example.json)).
- `google-token.json` — minted once locally, refreshed headlessly thereafter.

Steps:

1. On the Mac, with a valid `config.json`, run `bun run seo` once and complete Google's OAuth flow. This writes `~/.config/rankstas-paradise/google-token.json`.
2. Copy both files onto the volume at `/data/rankstas-paradise/`:
   - Coolify file manager, or
   - `scp config.json google-token.json <server>:<volume-path>/rankstas-paradise/`
3. Redeploy / restart. The service refreshes the token itself from then on.

## 5. Google OAuth consent screen MUST be "In production" ⚠

If the consent screen is left in **Testing**, Google expires the refresh token after **7 days** — sync then fails silently every week and data goes stale with no error at deploy time.

Google Cloud Console → **APIs & Services → OAuth consent screen** → **Publishing status → In production**. The `webmasters.readonly` scope is non-sensitive, so no verification review is required.

## 6. Domain + TLS

- In the Coolify service, add the domain (e.g. `rp.<your-domain>`).
- Coolify's proxy terminates TLS and issues the certificate automatically. Point the DNS record at the Coolify server first.

## 7. Scheduled sync

Sync is not automatic on the server — drive it with a Coolify **Scheduled Task** per site, daily. The task runs inside the container, so `localhost:$SEO_PORT` reaches the service and `$RP_TOKEN` is already in the environment.

One command per configured site id (`sleevy`, `missingmounts`):

```sh
curl -fsS -X POST "http://localhost:8790/api/jobs/sync?site=sleevy" \
  -H "Authorization: Bearer $RP_TOKEN"
```

```sh
curl -fsS -X POST "http://localhost:8790/api/jobs/sync?site=missingmounts" \
  -H "Authorization: Bearer $RP_TOKEN"
```

- Schedule daily, e.g. `0 6 * * *`. Stagger the two by a few minutes — only one job runs at a time (a second returns `409`).

## 8. Connecting afterwards

- **Mac CLI/TUI**: set `RP_API_URL=https://rp.<your-domain>` and `RP_TOKEN=<token>`, or run `rp init` to store them.
- **opencode agents**: connect over MCP with the same `RP_TOKEN`.
