# Deploy (Coolify)

Ranksta's Paradise runs as a single Bun HTTP service. State lives on one persistent volume; the bearer token and Google client credentials are env secrets, and the OAuth token is seeded onto the volume — nothing is baked into the image. The ADR ([docs/adr/0001-rp-as-hosted-service.md](adr/0001-rp-as-hosted-service.md)) is the source of truth.

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
| `GOOGLE_CLIENT_ID` | yes (secret) | Desktop OAuth client id. Overrides `config.json` if both are set. |
| `GOOGLE_CLIENT_SECRET` | yes (secret) | Desktop OAuth client secret. |
| `XDG_CONFIG_HOME` | yes | Set to `/data` (see above). |
| `SEO_PORT` | no | Defaults to 8790. |

The Google **client id/secret** are static, so they go in env (Coolify secrets). Everything else Google/data-related is a file on the volume (next step). See [src/config.ts](../src/config.ts): env takes precedence, `config.json` is the fallback.

## 4. Google authentication — mint once, refresh headlessly

Google OAuth has two phases, and **only the first needs a browser**:

- **Interactive login (once, on your Mac).** `connectGoogle` ([src/google.ts](../src/google.ts)) opens a loopback callback + your browser, you approve the `webmasters.readonly` scope, and it writes `google-token.json` containing a long-lived **`refresh_token`**. This is a *desktop* OAuth flow (loopback redirect, macOS `open`) and **cannot run on the headless server** — it is only ever triggered from the Mac TUI ([src/main.ts](../src/main.ts)).
- **Headless refresh (forever, on the server).** With that token file present, the server only ever calls `getAccessToken`: a server-to-server POST of `refresh_token` + client id/secret to Google, no browser. The refreshed token is rewritten to the file, which is why it must live on the writable volume. The server has **no code path that opens a browser** — a missing/revoked token just makes sync jobs fail cleanly (read endpoints keep serving).

So the login is a one-time bootstrap on your Mac; the server lives entirely off the copied refresh token.

**Two files must be on the volume** (they can't be env vars):

- `config.json` — only `siteUrl` and the `sites` array now (the client id/secret come from env). See [config.example.json](../config.example.json).
- `google-token.json` — the OAuth token, **mutable** (rewritten on every refresh).

Steps:

1. On the Mac, with a valid local `config.json` (or the `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` env set), run `bun run seo` once and complete Google's OAuth flow. This writes `~/.config/rankstas-paradise/google-token.json`.
2. Copy both files onto the volume at `/data/rankstas-paradise/`:
   - Coolify file manager, or
   - `scp config.json google-token.json <server>:<volume-path>/rankstas-paradise/`
3. Redeploy / restart. The service refreshes the token itself from then on.

Three things that make or break it:

- **Same OAuth client both sides.** The `refresh_token` is bound to the client that minted it — the server's `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` must be the *same* desktop client you used on the Mac, or refresh is rejected.
- **Consent screen "In production"** (see next section) — otherwise the refresh token dies after 7 days.
- **One token covers all sites.** The token is per-*account*, stored at the app-home root (not under `sites/<id>/`), so one login serves every site in that Google account's Search Console.

**Recovery.** If Google ever revokes the token (password change, manual revoke), the server can't re-login itself — re-run the Mac bootstrap (steps 1–2). Rare once the consent screen is in production.

## 4b. Migrating existing local data

If you already run RP locally (history, registry, logged actions), migrate it instead of starting empty — it's a **plain file copy**, lossless, no transform. The storage schema is `create table if not exists …` with no versioning or migrations, so the deployed code opens the copied DBs directly.

Copy the app home into `/data/rankstas-paradise/`, preserving structure:

- `config.json`, `google-token.json` (from step 4 above)
- `sites/<id>/keyword-registry.csv`, `search-console.sqlite`, `sitemap.json` — for each site

```sh
scp -r ~/.config/rankstas-paradise/sites <server>:<volume-path>/rankstas-paradise/
```

- **Skip** any `search-console.debug.sqlite` (debug fixture only).
- **Close the Mac TUI first** — it's the only writer. The DBs are `journal_mode=delete` with no `-wal`/`-shm` sidecars, so once the app is closed each `.sqlite` is a clean single file.
- The first scheduled sync on the server fills any gap between the copy and today (missing finalized days + reconcile of the newest few), so a slightly stale copy self-heals.

Do **not** rely on `backfill` as a substitute: it only refetches Google snapshots (≤16 months) and never restores `action_log` or the registry, so you would lose logged actions and still have to copy the CSVs anyway.

## 5. Google OAuth consent screen MUST be "In production" ⚠

If the consent screen is left in **Testing**, Google expires the refresh token after **7 days** — sync then fails silently every week and data goes stale with no error at deploy time.

Google Cloud Console → **APIs & Services → OAuth consent screen** → **Publishing status → In production**. The `webmasters.readonly` scope is non-sensitive, so no verification review is required.

## 6. Domain + TLS

- In the Coolify service, add the domain (e.g. `rp.<your-domain>`).
- Coolify's proxy terminates TLS and issues the certificate automatically. Point the DNS record at the Coolify server first.

## 7. Sync: read-driven, with a scheduled floor

The server keeps data fresh two ways, and you configure only the second:

- **Read-driven (automatic, no config).** Every read — an app over HTTP or an agent over MCP — warms the site: if its ledger hasn't been reconciled within the reconciliation window (6h), the read kicks a background sync and still returns current data immediately. Concurrent or in-flight syncs coalesce into a no-op (the single-job guard), so bursty agent traffic can't stack jobs or exhaust Google's quota. A warm site is never more than a few hours stale.
- **Scheduled floor (you configure this).** The read path only fires when *something* reads. For a site nothing touches for a day, add a Coolify **Scheduled Task** per site, daily, as the cold-start floor. The task runs inside the container, so `localhost:$SEO_PORT` reaches the service and `$RP_TOKEN` is already in the environment.

One command per configured site id:

```sh
curl -fsS -X POST "http://localhost:8790/api/jobs/sync?site=<site-id>" \
  -H "Authorization: Bearer $RP_TOKEN"
```

- Schedule daily, e.g. `0 6 * * *`. Stagger the sites by a few minutes — only one job runs at a time (a second returns `409`, which for the cron is harmless: it just means a read-triggered sync is already running).

> The single-job guard is in-process, so it assumes **one** server instance. Don't scale the service to multiple replicas against the same volume without adding a shared lock — concurrent syncs would race the delete-then-insert writes.

## 8. Connecting afterwards

- **Mac CLI/TUI**: set `RP_API_URL=https://rp.<your-domain>` and `RP_TOKEN=<token>`, or run `rp init` to store them. Once configured, `bun run seo` talks to the server by default; override per-run with `--local` (this machine's own data) or `--network` (force the server).
- **opencode agents**: connect over MCP with the same `RP_TOKEN`.
