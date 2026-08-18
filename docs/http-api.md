# HTTP API

`bun run apps/server/src/main.ts` (or `bun --cwd apps/server run serve`) starts the HttpApi server. It binds `0.0.0.0` on port `SEO_PORT` (default 8790) and is bearer-gated: every request needs `Authorization: Bearer <RP_TOKEN>`. It is built on the `packages/domain` Effect services; payloads match the CLI's JSON documents, and every response carries `generatedAt` and `mode` (`live`/`debug`). Add `--debug` to serve the isolated fake fixture.

## Read endpoints (local data only, never call Google)

| Endpoint | CLI equivalent |
|---|---|
| `GET /api/sites` | — (configured site catalog) |
| `GET /api/status` | `status` |
| `GET /api/pages?window=N` | `pages --window N` |
| `GET /api/page?path=/x` | `page /x` |
| `GET /api/queries?page=&window=&min-impressions=&include-brand=true&limit=` | `queries …` |
| `GET /api/opportunities?kind=` | `opportunities --kind` |
| `GET /api/registry` | `registry` |
| `GET /api/log?path=` | `log list` |
| `GET /api/history?limit=N` | — (TUI history view) |

`GET /api/status` reports two instants in `data`, both ISO 8601
(`YYYY-MM-DDTHH:MM:SSZ`) and both `null` until they have a value:

- `data.lastSyncedAt` — when this site's data last **changed**: the newest
  `synced_day.fetched_at`. `null` for a site that has never been synced.
- `data.lastCheckedAt` — when Ranksta last **asked Google**: the instant a sync
  run last completed. `null` for a site no sync run has completed for.

Read freshness from these, never from `generatedAt` — that is only when the
response was serialized, so a client that treats it as a sync time shows "just
now" over data that is days old.

Keep the two apart; they answer different questions. A sync that correctly finds
no new finalized day to fetch writes no `synced_day` row, so `lastSyncedAt`
cannot move — for up to `reconciliationTtlHours` (6) after a real write, no
matter how many syncs run. Only `lastCheckedAt` moves on such a run. So:

| `lastCheckedAt` | `lastSyncedAt` | What happened |
|---|---|---|
| recent | recent | The sync ran and Google had new data. |
| recent | older | The sync ran and Google had nothing new. Healthy. |
| stale or `null`, while syncs are being requested | anything | The sync is failing, or nothing is asking for one. The reason is on the server's error log — a failed job is logged at error level with its site and its cause. |

`lastCheckedAt` is stamped by a completed sync only. A run that fails stamps
nothing, and `POST /api/jobs/backfill` does not stamp it either: the field
answers "when was the daily refresh last attempted", and a one-off historical
fetch would make it read fresher than the truth.

All site-scoped endpoints accept `?site=<id>`. The default is the first configured site. For example:

```text
GET /api/pages?site=<id>&window=28
GET /api/opportunities?site=<id>
GET /tui/home.txt?site=<id>
```

The site catalog is configured in `config.json` under `sites`. Each site gets isolated SQLite, registry, and sitemap state under `sites/<id>/` in the app home. On the server, each site is served by its own cached `ManagedRuntime` with the active site bound as `CurrentSite` (see [adr/0002-effect-v4-monorepo.md](adr/0002-effect-v4-monorepo.md)).

## Write endpoints

- `POST /api/registry` — body: `RegistryAddInput` (`target`, optional `keyword`/`cluster`/`intent`/`priority`/`country`/`why`/`publishedAt`/`baselineDate`/`status`). Keyword rows require cluster, intent, and priority.
- `PATCH /api/registry` — body: `{ target, keyword?, patch: RegistryPatch }`.
- `POST /api/log` — body: `{ path, kind, date?, note? }`.

## Jobs (Google-touching, asynchronous)

- `POST /api/jobs/sync?site=<id>` → `202` with the job record, or `409` if a job is already running. One job at a time — syncs use delete-then-insert transactions that must not interleave.
- `POST /api/jobs/backfill?site=<id>` — body: `{ months? }` (default 16).
- `GET /api/jobs?site=<id>` — job history for this server process (in-memory). `site` is optional here, unlike the other site-scoped routes: omitting it falls back to the first configured site.

## Native app format

The server also renders plain-text feeds for the native desktop client, whose
app-core subset has no JSON parser:

- `GET /sites.txt` — the site catalog.
- `GET /pages.txt?site=<id>&window=N` — pipe-delimited page lines.
- `GET /tui/{home,opportunities,history,registry,log}.txt?site=<id>` — the full
  TUI-mirroring view feeds (tab-separated, typed detail nodes).

These come from [apps/server/src/native-feed.ts](../apps/server/src/native-feed.ts). The complete wire grammar (line kinds, tones, slots) is documented in [native-app-contract.md](native-app-contract.md). All report formatting happens server-side; the native app only splits bytes.
