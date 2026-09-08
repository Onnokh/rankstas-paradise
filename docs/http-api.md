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
| `GET /api/live` | — (visitors on the site right now; the one read that asks the analytics provider) |
| `GET /api/events?window=N` | `events --window N` |
| `GET /api/today` | — (today so far, from the ledger; re-synced every five minutes) |
| `GET /api/revenue?window=N` | — (sales per day from the site's commerce provider, from the ledger) |

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

### Visits from the site's analytics provider

A site may name a web-analytics provider in its `config.json` entry
(`analytics: { provider, siteId, baseUrl?, timeZone? }`, see
[adr/0004-analytics-provider-port.md](adr/0004-analytics-provider-port.md)).
When it does, the daily sync also fetches the provider's visits and the reports
carry them as **optional keys** beside the Search Console numbers, so a client
built against an older server keeps decoding:

- `GET /api/status` → `analytics`: the provider, whether this deployment can
  read it (`ready`, with a `reason` when not), and how many days of visits are
  stored (`days`, `firstDate`, `lastDate`, `lastSyncedAt`). `null` when the
  site has no provider.
- `GET /api/pages`, `GET /api/page` and each target of `GET /api/registry` →
  `visits`: `{ current, previous, deltaPageviews, deltaVisits }` of pageviews
  and visits over the same two windows as the Search Console metrics. `null`
  when there is no provider or no visits synced yet.
- `GET /api/history` → each day carries `visits: { pageviews, visits,
  visitors } | null`.
- `GET /api/events?window=N` → `{ analytics, windowDays, window, events: [{ name,
  current, previous, delta }] }`: each custom event over the last N days against
  the N days before, strongest first, anchored on the Search Console latest
  date. `events` is empty when there is no provider or nothing is synced yet.

Visits have no finalization lag: the newest stored day is yesterday (UTC), and
the last two days are re-fetched on each sync.

`GET /api/live` is the exception to "read endpoints never call out": it asks
the provider how many distinct people were active in the last 30 minutes and
answers `{ analytics, live: { visitors, windowMinutes, online, onlineWindowMinutes,
series, fetchedAt } | null }`. `online` is the same count over the last 5
minutes: the people on the site right now. `series` is one count per minute of
the window, oldest first, zero for quiet minutes: the bars of a realtime card.
It carries positions, not timestamps; the last entry is the minute that just
ended before `fetchedAt`.
Answers are memoised for 30 seconds per site, so poll it on its own timer and
never fold it into the dashboard read, which must stay served from disk.

`GET /api/today` is served from the ledger like every other read. The daily
sync stops at yesterday, so the server re-fetches the day in progress from the
provider every five minutes (`Sync.syncToday`) and writes it into the same
daily tables plus `analytics_site_hourly`. It answers `{ analytics, today: {
date, timeZone, hoursElapsed, site, hours, pages, events, syncedAt } | null }`:
the provider's calendar day in the site's zone, its totals so far (`site`,
null before the first sync), exactly 24 hourly rows (`hour`, `pageviews`,
`visits`, `visitors`; zeros for hours to come, `hoursElapsed` says how many
have begun), the day's pages and events, and when the rows were last written
(`syncedAt`, null before the first sync).

`GET /api/events` ends its window on the newest finished day of visits
(yesterday once today has synced), not on the Search Console latest date, so
the freshest whole days are in it; today's partial day is left to `/api/today`.

### Revenue from the site's commerce provider

A site may also name a commerce provider in its `config.json` entry
(`revenue: { provider, accountId?, keyVariable?, baseUrl?, timeZone? }`, see
[adr/0005-revenue-provider-port.md](adr/0005-revenue-provider-port.md)). The
first adapter is Polar. The key is read from the environment variable
`keyVariable` names (default `<PROVIDER>_API_KEY`, so `POLAR_API_KEY`); Polar
issues one token per organisation, so two sites on two organisations name two
variables. When a site has one, the daily sync fetches its sales beside its
visits — a year back on the first run, one call — and the today sync refreshes
today's row every five minutes.

- `GET /api/status` → `revenue`: the provider, whether this deployment can
  read it (`ready`, with a `reason` when not), and how many days are stored.
  `null` when the site has no provider.
- `GET /api/revenue?window=N` → `{ revenue, windowDays, window, currency, days,
  current, previous, delta }`: one row per synced day of the current window
  (`date`, `orders`, `revenue`, `net`, `currency`), oldest first, and the
  totals of the window and the one before with their deltas. Amounts are in
  the currency's minor unit (cents). The window ends on the newest whole day,
  as `/api/events` does. `revenue` is `null` for a site without a provider;
  then `days` is empty and every total zero.

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
