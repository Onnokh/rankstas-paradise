# Deploy (Coolify)

Ranksta's Paradise runs as a single Bun HTTP service (entry `apps/server/src/main.ts`; the SEO core is `packages/domain`). State lives on one persistent volume; the bearer token is an env secret and the Google service-account key is seeded onto the volume — nothing is baked into the image. The ADRs are the source of truth: [0001](adr/0001-rp-as-hosted-service.md) for the hosted-service decision, [0002](adr/0002-effect-v4-monorepo.md) for the Effect v4 monorepo shape, [0003](adr/0003-service-account-auth.md) for service-account auth.

## 1. Service

- Project: **Digital Home**.
- New resource → **Dockerfile** application, pointed at this repo. Coolify builds from the repo-root `Dockerfile`.
- The server binds `0.0.0.0` on `SEO_PORT` (default **8790**); set Coolify's exposed port to match.
- For GitHub push auto-deploys, use Coolify's **GitHub Manual Webhook** URL (`/webhooks/source/github/events/manual`) and matching secret. The `/api/v1/deploy` URL is for bearer-authenticated API callers, not a repository webhook.

## 2. Persistent volume

Everything the app reads or writes — the service-account key, the site catalog (`rankstas-paradise.sqlite`), per-site SQLite, registry CSV — lives under one app home: `${XDG_CONFIG_HOME:-~/.config}/rankstas-paradise` (see [packages/domain/src/config/config.ts](../packages/domain/src/config/config.ts)).

- Mount a Coolify **persistent volume** at `/data`.
- Set env `XDG_CONFIG_HOME=/data`, so the app home is **`/data/rankstas-paradise`**.

Without the volume the key and history are lost on every redeploy.

## 3. Environment

| Var | Required | Notes |
|---|---|---|
| `RP_TOKEN` | yes (secret) | The shared bearer token: the bootstrap credential that creates the first client, and the break-glass one if every client token is revoked. Use a long random value. Per-client tokens (§3d) are accepted beside it. |
| `XDG_CONFIG_HOME` | yes | Set to `/data` (see above). |
| `GOOGLE_SERVICE_ACCOUNT_FILE` | no | Override the key path. Defaults to `<app home>/google-service-account.json`. |
| `SITE_URL` | no | Legacy: the single property a fresh catalog is seeded with when there is no `config.json`. Ignored once the catalog has been imported. |
| `SEO_PORT` | no | Defaults to 8790. |
| `RP_MASTER_KEY` | yes for stored vendor keys (secret) | The key the vendor-key vault is encrypted with: 32 random bytes, base64 (`openssl rand -base64 32`). Without it the vault is read-only-empty, `GET /api/secrets` reports `encryption.configured: false`, and every key must still come from the environment. See §3c. |
| `AHREFS_API_KEY` | no (secret) | Fallback when no `ahrefs` key is stored in the vault. Enables Ahrefs Domain Rating. Without it every site simply has no rating; nothing else changes. A free key covers the endpoint used ([domain-rating-free](https://docs.ahrefs.com/en/api/reference/public/get-domain-rating-free)). |
| `DATAFORSEO_API_KEY` | no (secret) | Fallback when no `dataforseo` key is stored in the vault. Enables Keyword metrics: search volume, difficulty, cost per click, competition and intent for the Registry's keywords and the site's non-brand queries. The value is the base64 of `<login>:<password>` that the DataForSEO dashboard shows as the API key — one value, not two. Without it every site simply has no keyword demand data; Search Console is unaffected. Charged per request, so the sync asks only about keywords with no answer newer than 30 days, and never about a brand or operator query. |
| `RYBBIT_API_KEY` | no (secret) | Fallback when the site has no `rybbit` key stored in the vault. Reads visits for sites whose `config.json` entry names `analytics.provider: "rybbit"` (see [adr/0004](adr/0004-analytics-provider-port.md)). An organisation key from the Rybbit instance the site's `analytics.baseUrl` points at. Without it such a site shows `ready: false` under `analytics` on `GET /api/status` and has no visits; Search Console is unaffected. |
| `POLAR_API_KEY`, or the name each site's `revenue.keyVariable` gives (e.g. `POLAR_API_KEY_SHADERTOWN`) | no (secret) | Fallback when the site has no `polar` key stored in the vault. Reads sales for sites whose `config.json` entry names `revenue.provider: "polar"` (see [adr/0005](adr/0005-revenue-provider-port.md)). A Polar organization access token with the `metrics:read` scope; Polar issues one per organisation, so a site per organisation names its own variable. Without it the site shows `ready: false` under `revenue` on `GET /api/status` and has no revenue; nothing else changes. |

No Google credentials go in env: the only one is the service-account key file on the volume (next step).

## 3b. The site catalog

Sites and their settings live in `rankstas-paradise.sqlite` in the app home (the Catalog; see [packages/domain/src/catalog/catalog.ts](../packages/domain/src/catalog/catalog.ts)). Manage them through the API — `POST /api/sites`, `PUT /api/sites/:id/settings`, `DELETE /api/sites/:id` (see [http-api.md](http-api.md)) — rather than by editing files on the volume.

**One-time import.** A deployment that still has a `config.json` on the volume is migrated on the first start after this change: the server reads the file once, stores its `sites` into the catalog, records that the import ran, and logs `Imported N site(s) from config.json`. From then on the file is not read, so you can delete it. An emptied catalog is not refilled from the file. A fresh deployment with no file and no `SITE_URL` starts with an empty catalog; add the first site over the API.

## 3c. Vendor keys: the vault

Vendor keys (Polar, Rybbit, Ahrefs, DataForSEO) can be stored through the API instead of the environment, encrypted with AES-256-GCM under `RP_MASTER_KEY` in the same app-level database as the catalog (the Secrets service, [packages/domain/src/secrets/secrets.ts](../packages/domain/src/secrets/secrets.ts)).

- A key is addressed by **scope** and **purpose**: the scope is a site id (or app-wide, for Ahrefs and DataForSEO), the purpose is the provider name the site's `analytics` or `revenue` block names.
- `PUT /api/sites/<id>/secrets/<purpose>` with `{ "value": "…" }` stores a site's key; `PUT /api/secrets/ahrefs` and `PUT /api/secrets/dataforseo` store the app-wide ones. `GET` on the same paths lists statuses (last four characters, when written), never values. See [http-api.md](http-api.md).
- The server hands a stored key to the provider's adapter under the environment variable it already reads (`RYBBIT_API_KEY`, the site's `revenue.keyVariable`, `AHREFS_API_KEY`, `DATAFORSEO_API_KEY`), through a per-site ConfigProvider. **A stored key wins over the environment variable; the environment stays the fallback.** So you can move keys over one at a time and remove the env vars in Coolify afterwards.
- What this protects: copies of the volume and backups. It does not protect against an operator who can read the container's environment — they hold the master key too.
- **One-time import from the environment.** On the first start with `RP_MASTER_KEY` set, every slot the vault has nothing for is filled from the matching environment variable (each site's analytics and revenue providers, and Ahrefs and DataForSEO app-wide), and the server logs `Imported N vendor key(s) from the environment into the vault`. From then on the variables are fallbacks only and can be removed from Coolify.
- **Rotation:** there is no re-encrypt yet. To change `RP_MASTER_KEY`, delete the stored keys, set the new master key, restart, and store them again.

## 3d. Clients: per-client tokens

Instead of copying `RP_TOKEN` into every client, issue each one its own token: `POST /api/clients` with `{ "label": "Onno's MacBook" }` answers `201` with the client and its token, once. The server stores only the token's SHA-256 hash (the Clients service, [packages/domain/src/clients/clients.ts](../packages/domain/src/clients/clients.ts)). `GET /api/clients` lists clients with their last use; `DELETE /api/clients/<id>` revokes one, and its token stops working at the next request. The bearer middleware accepts `RP_TOKEN` and any active client token; it answers `503` only when neither exists.

Every client reads its token from `RP_API_URL`/`RP_TOKEN` or `~/.config/rankstas-paradise/client.json`; put a client token there instead of the shared one.

## 4. Google authentication — a service-account key

The server authenticates with a **service-account key**: it signs a short JWT with the key's private half and exchanges it for an access token ([search-console.ts](../packages/domain/src/search-console/search-console.ts), `getAccessToken`). There is no browser step, no consent screen, no refresh token, and nothing that expires on a timer — the key is valid until you delete it in Google Cloud. Access tokens are cached in memory, never written to disk, so this path works on a read-only mount.

**One file must be on the volume** (it can't be an env var):

- `google-service-account.json` — the key, **immutable**. The server only ever reads it.

(Sites are no longer a file: see §3b. A `config.json` shaped like [config.example.json](../config.example.json) is only read once, to seed the catalog.)

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

3. Copy the key onto the volume at `/data/rankstas-paradise/`:
   - Coolify file manager, or
   - `scp google-service-account.json <server>:<volume-path>/rankstas-paradise/`

4. Redeploy / restart, add each site with `POST /api/sites` (or let a legacy `config.json` seed the catalog, §3b), then `POST /api/jobs/sync?site=<id>` per site to catch up.

Notes:

- **No IAM roles needed.** Search Console permissions live in Search Console, not in Cloud IAM — the service account needs no project role at all.
- **The key is a credential.** `chmod 600` it locally; it grants read access to your Search Console data until revoked with `gcloud iam service-accounts keys delete`.
- **Rotation is a file swap.** Mint a new key, copy it over the old one, restart, delete the old key in Google Cloud.

## 4b. Migrating existing local data

If you already run RP locally (history, registry, logged actions), migrate it instead of starting empty — it's a **plain file copy**, lossless, no transform. The storage schema is `create table if not exists …` with no versioning or migrations, so the deployed code opens the copied DBs directly.

Copy the app home into `/data/rankstas-paradise/`, preserving structure:

- `google-service-account.json` (from §4 above) and `rankstas-paradise.sqlite` (the catalog), or a legacy `config.json` for the one-time import
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
