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
| `GET /api/registry/health` | `registry health` |
| `GET /api/keywords/proposed` | — (keyword proposals waiting on a decision; MCP `keywords_proposed`) |
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

### Indexing over time

Each target of `GET /api/registry` carries Google's last verdict on the page
(`indexed`, `coverageState`, `inspectedAt`), which is a reading of the present:
the ledger keeps one row per target and every URL Inspection overwrites it.

`GET /api/registry` therefore also carries **`coverage`**: one reading a day of
what the plan looked like, oldest first, as
`[{ date, keywordTargets, indexed, notIndexed }]`. `keywordTargets` is how many
pages at least one Keyword aimed at that day and is the denominator of the other
two; the pages that are neither are the ones Google said nothing usable about
(never inspected, or answered "unknown"). The Mac's registry screen charts it.

Inventory-only pages are **inspected** like every other tracked page — each one
carries its own `indexed` — but they are not counted in `coverage`. They have no
Keyword to rank, so Google's verdict on them cannot block a plan, and a site's
`/login` or `/privacy` is a page Google is right never to index: counted in, it
holds the share down for ever. On missingmounts this is the difference between
12 of 18 pages (67%) and 9 of 10 keyword targets (90%).

The daily sync records the day's reading and replaces it if it runs again the
same day. The series **cannot be backfilled** — URL Inspection answers only for
the present — so it is worth exactly as many days as it has been recording, and
an empty `coverage` is a young site rather than a broken one. The key is
optional, so a client built against an older server keeps decoding.

### Keyword demand

With a `dataforseo` key in the vault (or `DATAFORSEO_API_KEY` in the
environment, see [deploy.md](deploy.md)), the daily sync also fetches Keyword
metrics for the site's Market, and three reports carry them as **optional
keys** on the same terms as visits:

- `GET /api/queries` and `GET /api/registry` → `market`: `{ locationCode,
  languageCode, label, provider }`, the country and language every `demand`
  block in the response describes. `provider` is `labs` or `google-ads`, and
  says in advance whether `difficulty` and `intent` can arrive at all.
- each row of `GET /api/queries`, and each keyword of each target of
  `GET /api/registry` → `demand`: `{ searchVolume, difficulty, costPerClick,
  competition, intent, fetchedAt }`.
- each signal of `GET /api/opportunities` → `demand`: `{ searchVolume,
  difficulty, intent }`.

Two absences mean different things. **No `demand` key** means no answer is
stored for that term — the site has no key, the sync has not run, or the term
was never worth asking about (a brand query and an operator query are never
asked about, because the vendor charges per term). **A null `searchVolume`**
means DataForSEO was asked and has no volume for the term: it is too rare to
report, which is not the same as nobody searching it. Nothing here treats
either absence as a zero.

`searchVolume` is what ranks three of the four Opportunity kinds. `difficulty`
is reported and never scored — read it against the site's Domain Rating from
`GET /api/status`.

`GET /api/registry/health` is the same data turned round: the plan judged on
demand rather than the demand hung off the plan. It answers "does the Registry
aim at searches that exist", which is the question a site with no visibility
yet cannot answer any other way. Every planned keyword carries a `verdict`:

| verdict | what the vendor said | what it means |
|---|---|---|
| `has-demand` | a volume above zero | there is demand behind the plan |
| `no-demand` | zero | measured empty; the rows to act on |
| `unreported` | null | the term is too rare for the vendor to report |
| `unmeasured` | nothing — it was never asked | says nothing about the keyword |
| `brand` | nothing, and it never will be | the keyword is the site's own name, which is never asked about — the row needs nothing |

`brand` is separate from `unmeasured` because the two ask opposite things of the reader: an unmeasured keyword asks to be measured, and a brand keyword asks nothing, ever — volume on your own name cannot change a decision, so `KeywordMetrics` never spends on it. Left as `unmeasured` the row advises configuring a key, which would change nothing. The five verdict counts in `totals` sum to `totals.keywords`.

Keywords with demand come first, strongest first, and brand rows last. `totals.monthlyVolume` sums
only those, and is the size of the addressable market — every search, not the
share a first-page ranking would win. It is not a traffic forecast.

`GET /api/keywords/proposed` is the other side of the same question: keywords an
expansion found that the Registry does *not* hold. Each row carries the vendor's
numbers **as they read when it was proposed**, frozen — a Keyword metric is
re-asked and overwritten every thirty days, and a proposal is the record of why
the term looked worth the work then. So a proposal may disagree with the same
keyword's current metric in `/api/registry/health`, and both are true.

`totals.monthlyVolume` here is the demand on offer, the counterpart of the plan's
own figure. Rows come strongest first.

There is deliberately **no HTTP route that runs a discovery**. An expansion is
billed by the rows the vendor decides to return, so every run costs money and
its cost is not knowable in advance; running one is `keywords_discover` over
MCP, where the caller reads the drop counts before spending again. Accepting a
proposal is `POST /api/registry` — the same call whether a person or an agent
makes it, which is why a keyword the Registry holds simply stops being proposed
and there is no "accepted" state to write.

A run over MCP is **two calls, and stores nothing on the first**. Every filter a
run applies is numeric or structural — a volume floor, a difficulty ceiling, an
intent, the brand test, the already-known test — so none of them can tell whether
a keyword is about the Site's subject at all. `keywords_discover` therefore
answers with the rows and writes nothing, and `keywords_propose` stores the ones
the caller judged relevant. The second call is free: it hands back rows the
caller already holds, so the vendor is asked once however many rows survive. That
is why a proposal on this route is a keyword *something* judged relevant, and not
just one that cleared a volume floor.

`keywords_proposed` over MCP answers with this same document, minus the HTTP
envelope's `generatedAt`/`mode`, which every MCP tool leaves to its transport.

`difficultyGap` is a keyword's difficulty minus the site's Domain Rating, so a
positive number means the keyword scores harder than the site rates. The two are
different scales from different vendors measuring related but distinct things,
so it is a rough guide reported as a number and never as a verdict — banding it
into "reachable" or "not" would dress a rule of thumb up as a fact. Inventory-
only rows (a blank keyword) are left out: they make no claim about demand.

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
feed. It answers `{ analytics, events: { windowMinutes, since, events, visitors,
fetchedAt } | null }`, where `events.events` is every pageview and event of the last 30
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

`events.visitors` says which of those people are returning — a row cannot, since
the window is half an hour. One entry per person the provider knows anything
about, `{ visitor, visits, firstSeen, lastSeen }`, joined to a row by `visitor`.
`visits` is the all-time count of their visits, so 1 is a first-time visitor and
more is a returning one; `firstSeen` and `lastSeen` are ISO instants. Any of the
three is null when the provider does not say, and the whole list is `[]` — or
absent, against an older server — when it cannot answer for visitors at all.

Two things to hold on to when you draw it. `since` trims `events` and never
`visitors`: a polling client keeps the earlier rows on screen and has to be able
to label them too, so every poll carries the whole cast of the window. And a
visitor is the provider's device fingerprint, not a person: one office network
can read as one returning visitor, and the same person on a second browser reads
as a new one. It is a good hint and a bad identity. Histories are memoised for a
minute rather than the feed's five seconds, because an all-time count does not
move between two polls, and a provider that fails to answer them costs the feed
its counts and never its rows.

`GET /api/today` is served from the ledger like every other read. The daily
sync stops at yesterday, so the server re-fetches the day in progress from the
provider every five minutes (`Sync.syncToday`) and writes it into the same
daily tables plus `analytics_site_hourly`. It answers `{ analytics, today: {
date, timeZone, hoursElapsed, site, hours, pages, events, syncedAt } | null,
revenue, sales: { date, timeZone, orders, revenue, net, currency, syncedAt }
| null }`: the provider's calendar day in the site's zone, its totals so far
(`site`, null before the first sync), exactly 24 hourly rows (`hour`,
`pageviews`, `visits`, `visitors`; zeros for hours to come, `hoursElapsed` says
how many have begun), the day's pages and events, and when the rows were last
written (`syncedAt`, null before the first sync).

`sales` is the same day from the site's commerce provider, in **that**
provider's zone, with `revenue` carrying its status: the one place a partial
day of sales is reported, since `/api/revenue` ends on the last whole day. A
day with no orders is a zero row once synced, so read `syncedAt` to tell "no
sales" from "not fetched yet". The two halves are independent — a site with a
commerce provider and no analytics gets `today: null` with `sales` filled, and
the other way round.

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
  as `/api/events` does — today's sales are left to `/api/today`, which
  carries them as `sales`. `revenue` is `null` for a site without a provider;
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
- `PUT /api/sites/:id/settings` — body: `SiteSettings`. Replaces the whole entry, so a caller must send every setting it wants to keep. `404` for an unknown id.
- `DELETE /api/sites/:id` — removes the entry from the catalog. The site's data directory under `sites/<id>/` stays on disk. `404` for an unknown id.

The Market has no HTTP route of its own; it is read and written over MCP, with
`market` and `market_set`. Those go through `Catalog.patch`, which changes only
the settings it is given and leaves the rest of the entry as stored — the
targeted counterpart of the whole-entry `PUT` above, so a caller that holds one
setting cannot drop the site's analytics or revenue block. `market_set` refuses
a location and language pair `Market.served()` does not hold before it stores
anything, because DataForSEO bills for a task it rejects, and it drops the
site's cached runtime like every other settings write.

A Market change makes the stored Keyword metrics unreachable rather than wrong:
they are keyed by location code and language code, so the plan reads as
`unmeasured` until each planned keyword is asked again. `keywords_refresh` over
MCP is that request on its own, without the rest of a sync.

## Vendor keys (the vault)

Vendor keys are stored encrypted (see [deploy.md](deploy.md) §3c) and addressed by scope and purpose. Values go in and never come out: every response carries a `SecretStatus` (`scope`, `purpose`, `last4`, `updatedAt`) at most. Requests need `RP_MASTER_KEY` on the server; without it writes answer `503` and `encryption.configured` is `false`.

- `GET /api/secrets` and `GET /api/sites/:id/secrets` — `{ encryption: { configured, reason }, slots: [...] }`. One slot per key the scope calls for (the site's analytics and revenue providers; `ahrefs` and `dataforseo` app-wide, since neither is named by any site setting — each is one account serving every site) plus anything else stored: `{ purpose, variable, stored: SecretStatus | null, inEnvironment }`, where `variable` is the environment variable the adapter reads and `inEnvironment` says whether the process environment would supply a fallback.
- `PUT /api/secrets/:purpose` and `PUT /api/sites/:id/secrets/:purpose` — body `{ value }`. Stores or replaces the key and rebuilds the affected site runtime(s), so the next read uses it. `400` for a blank value or a purpose that is not lower-case letters, digits, and hyphens; `404` for an unknown site.
- `DELETE /api/secrets/:purpose` and `DELETE /api/sites/:id/secrets/:purpose` — removes the key; the environment variable, if set, takes over again. `404` when nothing is stored.

## Clients (per-client tokens)

- `GET /api/clients` — `{ clients: [{ id, label, createdAt, lastUsedAt, revokedAt }] }`, revoked clients included. Never a token.
- `POST /api/clients` — body `{ label }`. `201` with `{ client, token }`; the token (`rp_…`) is shown here and never again, the server keeps its hash. `400` for a blank label.
- `DELETE /api/clients/:id` — revokes the client; its token answers `401` from then on. `404` for an unknown id.

## Write endpoints

- `POST /api/registry` — body: `RegistryAddInput` (`target`, optional `keyword`/`cluster`/`intent`/`priority`/`why`/`publishedAt`/`baselineDate`/`status`). Keyword rows require cluster, intent, and priority.
- `PATCH /api/registry` — body: `{ target, keyword?, patch: RegistryPatch }`.
- `POST /api/log` — body: `{ path, kind, date?, note? }`.
- `POST /api/keywords/dismiss` — body: `{ keywords: string[] }`; answers `{ dismissed }`, the number of rows that changed. A keyword already dismissed, or never proposed, changes nothing.

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
