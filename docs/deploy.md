# Deploy (Coolify)

Ranksta's Paradise runs as a single Bun HTTP service (entry `apps/server/src/main.ts`; the SEO core is `packages/domain`). State lives on one persistent volume; the bearer token is an env secret and the Google service-account key is seeded onto the volume — nothing is baked into the image. The ADRs are the source of truth: [0001](adr/0001-rp-as-hosted-service.md) for the hosted-service decision, [0002](adr/0002-effect-v4-monorepo.md) for the Effect v4 monorepo shape, [0003](adr/0003-service-account-auth.md) for service-account auth.

## 1. Service

- Project: **Digital Home**.
- New resource → **Dockerfile** application, pointed at this repo. Coolify builds from the repo-root `Dockerfile`.
- The server binds `0.0.0.0` on `SEO_PORT` (default **8790**); set Coolify's exposed port to match.
- For GitHub push auto-deploys, use Coolify's **GitHub Manual Webhook** URL (`/webhooks/source/github/events/manual`) and matching secret. The `/api/v1/deploy` URL is for bearer-authenticated API callers, not a repository webhook.

## 2. Persistent volume

Everything the app reads or writes — the service-account key, SQLite, registry CSV, `config.json` — lives under one app home: `${XDG_CONFIG_HOME:-~/.config}/rankstas-paradise` (see [packages/domain/src/config/config.ts](../packages/domain/src/config/config.ts)).

- Mount a Coolify **persistent volume** at `/data`.
- Set env `XDG_CONFIG_HOME=/data`, so the app home is **`/data/rankstas-paradise`**.

Without the volume the key and history are lost on every redeploy.

## 3. Environment

| Var | Required | Notes |
|---|---|---|
| `RP_TOKEN` | yes (secret) | Bearer token required on every request. Use a long random value. |
| `XDG_CONFIG_HOME` | yes | Set to `/data` (see above). |
| `GOOGLE_SERVICE_ACCOUNT_FILE` | no | Override the key path. Defaults to `<app home>/google-service-account.json`. |
| `SITE_URL` | no | Overrides `siteUrl` from `config.json`. |
| `SEO_PORT` | no | Defaults to 8790. |

No Google credentials go in env: the only one is the service-account key file on the volume (next step). See [packages/domain/src/config/config.ts](../packages/domain/src/config/config.ts) — env takes precedence, `config.json` is the fallback.

## 4. Google authentication — a service-account key

The server authenticates with a **service-account key**: it signs a short JWT with the key's private half and exchanges it for an access token ([search-console.ts](../packages/domain/src/search-console/search-console.ts), `getAccessToken`). There is no browser step, no consent screen, no refresh token, and nothing that expires on a timer — the key is valid until you delete it in Google Cloud. Access tokens are cached in memory, never written to disk, so this path works on a read-only mount.

**Two files must be on the volume** (they can't be env vars):

- `config.json` — `siteUrl` and the `sites` array. See [config.example.json](../config.example.json).
- `google-service-account.json` — the key, **immutable**. The server only ever reads it.

Steps:

1. Create the service account and mint a key:

   ```sh
   gcloud iam service-accounts create rankstas-paradise \
     --project=<project> --display-name="Ranksta's Paradise"
   gcloud iam service-accounts keys create ~/.config/rankstas-paradise/google-service-account.json \
     --iam-account=rankstas-paradise@<project>.iam.gserviceaccount.com --project=<project>
   ```

   Enable `searchconsole.googleapis.com` on the project if it isn't already.

2. **Grant it access to each property.** Search Console → **Settings → Users and permissions → Add user**, paste the service account's email (`…@….iam.gserviceaccount.com`), permission **Owner**. This is the step that is easy to forget, and skipping it produces a 403 on every call while auth itself looks fine. Owner (not Full) is required because RP calls the URL Inspection API for index states; Full user is enough for search-analytics data alone. Repeat per property — the grant is per-property.

3. Copy both files onto the volume at `/data/rankstas-paradise/`:
   - Coolify file manager, or
   - `scp config.json google-service-account.json <server>:<volume-path>/rankstas-paradise/`

4. Redeploy / restart, then `POST /api/jobs/sync?site=<id>` per site to catch up.

Notes:

- **No IAM roles needed.** Search Console permissions live in Search Console, not in Cloud IAM — the service account needs no project role at all.
- **The key is a credential.** `chmod 600` it locally; it grants read access to your Search Console data until revoked with `gcloud iam service-accounts keys delete`.
- **Rotation is a file swap.** Mint a new key, copy it over the old one, restart, delete the old key in Google Cloud.

## 4b. Migrating existing local data

If you already run RP locally (history, registry, logged actions), migrate it instead of starting empty — it's a **plain file copy**, lossless, no transform. The storage schema is `create table if not exists …` with no versioning or migrations, so the deployed code opens the copied DBs directly.

Copy the app home into `/data/rankstas-paradise/`, preserving structure:

- `config.json`, `google-service-account.json` (from §4 above)
- `sites/<id>/keyword-registry.csv`, `search-console.sqlite`, `sitemap.json` — for each site

```sh
scp -r ~/.config/rankstas-paradise/sites <server>:<volume-path>/rankstas-paradise/
```

- **Skip** any `search-console.debug.sqlite` (debug fixture only).
- **Close the Mac TUI first** — it's the only writer. The DBs are `journal_mode=delete` with no `-wal`/`-shm` sidecars, so once the app is closed each `.sqlite` is a clean single file.
- The first scheduled sync on the server fills any gap between the copy and today (missing finalized days + reconcile of the newest few), so a slightly stale copy self-heals.

Do **not** rely on `backfill` as a substitute: it only refetches Google snapshots (≤16 months) and never restores `action_log` or the registry, so you would lose logged actions and still have to copy the CSVs anyway.

## 5. Domain + TLS

- In the Coolify service, add the domain (e.g. `rp.<your-domain>`).
- Coolify's proxy terminates TLS and issues the certificate automatically. Point the DNS record at the Coolify server first.

## 6. Sync: read-driven, with a scheduled floor

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

## 7. Connecting afterwards

- **Mac CLI/TUI** (`apps/tui`, remote-only): set `RP_API_URL=https://rp.<your-domain>` and `RP_TOKEN=<token>` (env wins), or run `rp init` to store them in `~/.config/rankstas-paradise/client.json`. Then `bun --cwd apps/tui run src/main.ts` opens the dashboard, or append a command for the agent CLI. There is no local-data mode anymore — the TUI always talks to the server.
- **opencode agents**: connect over MCP at `/mcp` with the same `RP_TOKEN`.
