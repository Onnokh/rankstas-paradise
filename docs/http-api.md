# HTTP API

`bun run apps/server/src/main.ts` (or `bun --cwd apps/server run serve`) starts the HttpApi server. It binds `0.0.0.0` on port `SEO_PORT` (default 8790) and is bearer-gated: every request needs `Authorization: Bearer <token>`, where the token is the shared `RP_TOKEN` or a per-client token (see Clients below). It is built on the `packages/domain` Effect services; payloads match the CLI's JSON documents, and every response carries `generatedAt` and `mode` (`live`/`debug`). Add `--debug` to serve the isolated fake fixture.

## Read endpoints (local data only, never call Google)

| Endpoint | CLI equivalent |
|---|---|
| `GET /api/sites` | — (the site catalog, resolved) |
| `GET /api/sites/:id/settings` | — (one site's stored settings next to the resolved Site) |
| `GET /api/status` | `status` |
| `GET /api/pages?window=N` | `pages --window N` |
| `GET /api/page?path=/x` | `page /x` |
| `GET /api/queries?page=&window=&min-impressions=&include-brand=true&limit=` | `queries …` |
| `GET /api/opportunities?kind=` | `opportunities --kind` |
| `GET /api/registry` | `registry` |
| `GET /api/log?path=` | `log list` |
| `GET /api/history?limit=N` | — (TUI history view) |
| `GET /api/live` | — (visitors on the site right now; the one read that asks the analytics provider) |
| `GET /api/live/events?since=T` | — (what visitors did in the last 30 minutes, newest first; also asks the provider) |
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

The daily sync grows the series forward from wherever it starts, and cannot
widen it backwards: its range begins at the ledger's own first day, and a day
already stored — including one stored as zeros because the provider had nothing
for it then — never counts as missing again. `POST /api/jobs/backfill-visits`
is how the earlier days arrive, and how a day the provider has since corrected
is repaired. It re-fetches every day in its range rather than only the gaps.

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

`GET /api/live/events` is the other read that reaches the provider: the live
feed. It answers `{ analytics, events: { windowMinutes, since, events, fetchedAt }
| null }`, where `events.events` is every pageview and event of the last 30
minutes, newest first, at most 500 rows: `{ id, at, kind, name, page,
properties, visitor, country, browser, operatingSystem, device, referrer }`.
`kind` is `pageview`, `event` (a named custom action) or one of Rybbit's
auto-captured kinds (`outbound`, `button_click`, `copy`, `form_submit`,
`input_change`); treat an unknown kind as `event`. `name` is null for a
pageview; `properties` is the event's data flattened to strings; `visitor` is
an opaque token that is the same for one person's rows, never a name; the
where-and-on-what fields are null when the provider does not know. `id` is
stable across polls for the same row. Pass `since=<ISO instant>` to get only the
rows newer than it (echoed back as `since`); a value that is not an instant is a
400. Answers are memoised for 5 seconds per site and `since` is applied to the
memo, so poll it every few seconds and never fold it into another read.

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
  the currency's minor unit (cents); `net` is the provider's own net, after
  refunds and its fees. The window ends on the newest whole day,
  as `/api/events` does. `revenue` is `null` for a site without a provider;
  then `days` is empty and every total zero.

All site-scoped endpoints accept `?site=<id>`. The default is the first configured site. For example:

```text
GET /api/pages?site=<id>&window=28
GET /api/opportunities?site=<id>
GET /tui/home.txt?site=<id>
```

The site catalog lives in the app-level database `rankstas-paradise.sqlite` in the app home and is edited through the routes below. A legacy `config.json` with a `sites` array is imported into it once, the first time the server reads an empty catalog; after that the file is not read again. Each site gets isolated SQLite, registry, and sitemap state under `sites/<id>/` in the app home. On the server, each site is served by its own cached `ManagedRuntime` with the active site bound as `CurrentSite` (see [adr/0002-effect-v4-monorepo.md](adr/0002-effect-v4-monorepo.md)); a settings write drops that runtime so the next request sees the new settings.

## Site catalog and settings

Bodies use `SiteSettings` (`packages/domain/src/config/schema.ts`): `siteUrl` (the Search Console property) is required; `name`, `origin`, `sitemapUrl`, `brandTerms`, `market`, `analytics`, and `revenue` are optional and derived when absent. A `market` names a DataForSEO `locationCode` and optionally a `languageCode`; absent, it resolves to the United States in English, and an absent language takes the country's primary search language. Every write answers `{ site, settings }`: the resolved Site next to what was stored. Vendor keys are never part of the settings.

- `POST /api/sites` — body: `{ id, ...SiteSettings }`. `201` with the new site; `409` when the id is taken; `400` when the id is not lower-case letters, digits, and hyphens, or the property/origin is not a URL.
- `PUT /api/sites/:id/settings` — body: `SiteSettings`. Replaces the whole entry. `404` for an unknown id.
- `DELETE /api/sites/:id` — removes the entry from the catalog. The site's data directory under `sites/<id>/` stays on disk. `404` for an unknown id.

## Vendor keys (the vault)

Vendor keys are stored encrypted (see [deploy.md](deploy.md) §3c) and addressed by scope and purpose. Values go in and never come out: every response carries a `SecretStatus` (`scope`, `purpose`, `last4`, `updatedAt`) at most. Requests need `RP_MASTER_KEY` on the server; without it writes answer `503` and `encryption.configured` is `false`.

- `GET /api/secrets` and `GET /api/sites/:id/secrets` — `{ encryption: { configured, reason }, slots: [...] }`. One slot per key the scope calls for (the site's analytics and revenue providers; `ahrefs` app-wide) plus anything else stored: `{ purpose, variable, stored: SecretStatus | null, inEnvironment }`, where `variable` is the environment variable the adapter reads and `inEnvironment` says whether the process environment would supply a fallback.
- `PUT /api/secrets/:purpose` and `PUT /api/sites/:id/secrets/:purpose` — body `{ value }`. Stores or replaces the key and rebuilds the affected site runtime(s), so the next read uses it. `400` for a blank value or a purpose that is not lower-case letters, digits, and hyphens; `404` for an unknown site.
- `DELETE /api/secrets/:purpose` and `DELETE /api/sites/:id/secrets/:purpose` — removes the key; the environment variable, if set, takes over again. `404` when nothing is stored.

## Clients (per-client tokens)

- `GET /api/clients` — `{ clients: [{ id, label, createdAt, lastUsedAt, revokedAt }] }`, revoked clients included. Never a token.
- `POST /api/clients` — body `{ label }`. `201` with `{ client, token }`; the token (`rp_…`) is shown here and never again, the server keeps its hash. `400` for a blank label.
- `DELETE /api/clients/:id` — revokes the client; its token answers `401` from then on. `404` for an unknown id.

## Write endpoints

- `POST /api/registry` — body: `RegistryAddInput` (`target`, optional `keyword`/`cluster`/`intent`/`priority`/`country`/`why`/`publishedAt`/`baselineDate`/`status`). Keyword rows require cluster, intent, and priority.
- `PATCH /api/registry` — body: `{ target, keyword?, patch: RegistryPatch }`.
- `POST /api/log` — body: `{ path, kind, date?, note? }`.

## Jobs (asynchronous)

- `POST /api/jobs/sync?site=<id>` → `202` with the job record, or `409` if a job is already running. One job at a time — syncs use delete-then-insert transactions that must not interleave.
- `POST /api/jobs/backfill?site=<id>` — body: `{ months? }` (default 16). Search Console history.
- `POST /api/jobs/backfill-visits?site=<id>` — body: `{ months? }` (default 6). Visits history from the site's analytics provider. Answers `202` with a summary saying so when the site has no provider; fails the job when it has one that is not ready.
- `GET /api/jobs?site=<id>` — job history for this server process (in-memory). `site` is optional here, unlike the other site-scoped routes: omitting it falls back to the first configured site.

## Native app format

The server also renders plain-text feeds for the native desktop client, whose
app-core subset has no JSON parser:

- `GET /sites.txt` — the site catalog.
- `GET /pages.txt?site=<id>&window=N` — pipe-delimited page lines.
- `GET /tui/{home,opportunities,history,registry,log}.txt?site=<id>` — the full
  TUI-mirroring view feeds (tab-separated, typed detail nodes).

These come from [apps/server/src/native-feed.ts](../apps/server/src/native-feed.ts). The complete wire grammar (line kinds, tones, slots) is documented in [native-app-contract.md](native-app-contract.md). All report formatting happens server-side; the native app only splits bytes.
